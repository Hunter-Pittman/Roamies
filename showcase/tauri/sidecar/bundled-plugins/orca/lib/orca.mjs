// Local Orca integration: non-consuming observation and typed launches/messages to owned supervisors.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orcaReadArgs, orcaSupervisorArgs, orcaSupervisorMessageArgs } from '../../../safety.mjs';

export const cleanOrcaEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^ORCA_/i.test(k)));
export function findOrca(env = process.env, platform = process.platform) {
  const name = env.ORCA_DEV_REPO_ROOT ? (platform === 'win32' ? 'orca-dev.exe' : 'orca-dev') : platform === 'win32' ? 'orca.exe' : platform === 'linux' ? 'orca-ide' : 'orca';
  const candidates = env.ORCA_CLI_COMMAND ? [env.ORCA_CLI_COMMAND] : [
    !env.ORCA_DEV_REPO_ROOT && platform === 'win32' && env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'orca', 'resources', 'bin', 'orca.exe'),
    !env.ORCA_DEV_REPO_ROOT && platform === 'darwin' && '/Applications/Orca.app/Contents/Resources/bin/orca',
    ...String(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, name))];
  const found = candidates.find((p) => p && path.isAbsolute(p) && fs.existsSync(p) && fs.statSync(p).isFile()
    && /^(orca(-dev|-ide)?)(\.exe)?$/i.test(path.basename(p)));
  if (!found) throw new Error(env.ORCA_CLI_COMMAND ? 'The configured Orca CLI executable is unavailable; no other Orca build was selected.' : 'Orca CLI is unavailable. Install Orca and its CLI, then try again.');
  return found;
}
const execute = (file, args, options) => new Promise((resolve, reject) => execFile(file, args, options, (error, stdout) => {
  if (error) { error.stdout = stdout; return reject(error); }
  resolve(stdout);
}));
const text = (s, n = 12000) => String(s ?? '').slice(0, n);
const array = (v, key) => { if (!Array.isArray(v?.[key])) throw new Error(`Unsupported Orca response: missing ${key}.`); return v[key]; };
export function createOrca({ transport = execute, binary = () => findOrca(), env = process.env, now = Date.now } = {}) {
  async function status() {
    const { data, runtime } = await read('activity', {});
    const rows = array(data, 'worktrees'), agents = [], seen = new Set();
    let unverifiedSubagentRoots = 0, clipped = false;
    function walk(a, workspace, parent = null, depth = 0) {
      if (!a || typeof a !== 'object' || agents.length >= 10000 || depth > 64) { clipped = true; return; }
      const state = text(a.state || a.mainAgent?.state || 'unknown', 50).toLowerCase();
      const mainState = text(a.mainAgent?.state, 50).toLowerCase();
      const states = [state, mainState];
      const activity = states.some((s) => ['working', 'running', 'thinking', 'busy', 'tool', 'streaming'].includes(s)) ? 'working'
        : states.some((s) => ['waiting', 'asking', 'needs_input', 'approval', 'waiting_for_input', 'waiting_for_approval'].includes(s)) ? 'waiting'
        : ['done', 'idle', 'stopped', 'exited', 'paused', 'cancelled', 'canceled'].includes(state) || a.interrupted ? 'idle' : 'unknown';
      const id = text(a.paneKey || a.id, 500);
      const key = `${workspace.hostId}:${id}`;
      if (id && seen.has(key)) return;
      if (id) seen.add(key);
      agents.push({ id, parent, project: text(workspace.repo, 200), workspace: text(workspace.displayName || workspace.repo, 200),
        host: text(workspace.hostId, 200), name: text(a.conversationName || a.displayName || a.taskTitle || a.agentType, 200),
        agent: text(a.agentType, 50), activity, reportedState: state, mainState, interrupted: !!a.interrupted,
        updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : null,
        wait: a.agentWait ?? null });
      if (a.subagentObservation === 'unverifiable') unverifiedSubagentRoots++;
      for (const child of Array.isArray(a.children) ? a.children : []) walk(child, workspace, id, depth + 1);
    }
    for (const workspace of rows) {
      if (!Array.isArray(workspace.agents)) { clipped = true; continue; }
      for (const agent of workspace.agents) walk(agent, workspace);
    }
    const omittedHosts = Array.isArray(data.hostScope?.omittedHostIds) ? data.hostScope.omittedHostIds : [];
    return { observedAt: now(), runtime,
      summary: { working: agents.filter((a) => a.activity === 'working').length, waiting: agents.filter((a) => a.activity === 'waiting').length,
        idle: agents.filter((a) => a.activity === 'idle').length, unknown: agents.filter((a) => a.activity === 'unknown').length, total: agents.length },
      coverage: { partial: !!data.truncated || clipped || omittedHosts.length > 0 || !data.hostScope,
        hosts: data.hostScope?.hostIds ?? [], omittedHosts, returnedWorkspaces: rows.length, totalWorkspaces: data.totalCount ?? null, unverifiedSubagentRoots },
      agents: agents.sort((a, b) => ({ working: 0, waiting: 1, unknown: 2, idle: 3 }[a.activity] - { working: 0, waiting: 1, unknown: 2, idle: 3 }[b.activity])),
      meaning: 'Live agent activity, including ordinary chats and observed children. Task status is a different data source. Idle/done does not prove an assignment is complete. Disclose partial coverage, unknown agents and unverified subagents; never infer no running agents from completed Tasks.' };
  }
  async function workspaces() {
    const { data } = await read('workspaces', {});
    if (data.truncated) throw new Error('Orca workspace discovery was truncated; narrow the local workspace list before dispatching.');
    return array(data, 'worktrees').filter((w) => w.hostId === 'local' && w.address?.environment === 'local')
      .map((w) => ({ workspace: w.address.worktree, title: text(w.displayName || w.repo, 200), project: text(w.repo, 200), path: text(w.path, 1000),
        agents: [...new Set((w.agents ?? []).map((a) => a.agentType).filter(Boolean))] }));
  }
  async function launchSupervisor(request) {
    const args = orcaSupervisorArgs(request);
    if (!(await workspaces()).some((w) => w.workspace === request.workspace)) throw new Error('The selected local Orca workspace is unavailable.');
    let raw, failed = false;
    try { raw = await transport(binary(), args, { env: cleanOrcaEnv(env), cwd: os.homedir(), windowsHide: true, timeout: 90000, maxBuffer: 4 << 20 }); }
    catch (e) { raw = e.stdout; failed = true; }
    let response;
    try { response = JSON.parse(raw); } catch {
      const error = new Error('Supervisor launch response was lost. Work may have started; do not launch a replacement.');
      error.uncertain = true; throw error;
    }
    const result = response.result;
    if (failed || response.ok !== true || !result?.outcome?.handle || !['journaled', 'handed-to-terminal'].includes(result.prompt?.outcome)) {
      const error = new Error(text(response.error?.message || 'Orca did not confirm supervisor launch and prompt delivery. Inspect the workspace before retrying.', 400));
      error.uncertain = true;
      error.operationId = response.error?.data?.operationId ?? result?.operationId ?? null;
      throw error;
    }
    return { handle: text(result.outcome.handle, 300), surface: result.outcome.kind, operationId: result.operationId ?? null,
      workspace: request.workspace, runtime: text(response._meta?.runtimeId, 128), promptDelivered: true };
  }
  async function messageSupervisor(handle, message) {
    const args = orcaSupervisorMessageArgs({ handle, text: message });
    let response;
    try {
      const raw = await transport(binary(), args, { env: cleanOrcaEnv(env), cwd: os.homedir(), windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 });
      response = JSON.parse(raw);
    } catch { throw new Error('Supervisor message was not confirmed. It may have been delivered; do not resend automatically.'); }
    const receipt = response.result?.send;
    if (response.ok !== true || !receipt?.accepted || !receipt.prompt || receipt.prompt.provider === 'old-host') throw new Error('This Orca agent did not confirm message delivery. No fallback input or automatic resend was attempted.');
    return { accepted: true, receipt: receipt.prompt };
  }
  async function read(operation, input) {
    const args = orcaReadArgs(operation, input);
    const raw = await transport(binary(), args, { env: cleanOrcaEnv(env), cwd: os.homedir(), windowsHide: true, timeout: 15000, maxBuffer: 4 << 20 });
    let response;
    try { response = JSON.parse(raw); } catch { throw new Error('Orca returned invalid JSON.'); }
    if (response.ok !== true || !response.result) throw new Error(text(response.error?.message || 'Orca observation failed.', 300));
    return { data: response.result, runtime: text(response._meta?.runtimeId, 128) };
  }
  async function runs(cursor) {
    const { data } = await read('runs', cursor ? { cursor } : {});
    return { runs: array(data, 'runs').map((r) => ({ id: text(r.id, 80), title: text(r.objective, 200) })), nextCursor: data.nextCursor ?? null };
  }
  async function workers(runId) {
    const rows = []; let cursor;
    for (let page = 0; page < 10; page++) {
      const { data } = await read('workers', { runId, ...(cursor ? { cursor } : {}) });
      rows.push(...array(data, 'workers'));
      cursor = data.nextCursor;
      if (!cursor) return rows;
    }
    throw new Error('Too many Orca workers in this Run; cannot safely identify the current dispatch.');
  }
  async function tasks(runId) {
    const [{ data }, ws] = await Promise.all([read('tasks', { runId }), workers(runId)]);
    if (data.runId !== runId) throw new Error('Orca Run identity changed.');
    return array(data, 'tasks').map((t) => {
      const matching = ws.filter((w) => w.taskId === t.id);
      // A retry may leave multiple dispatches. Require explicit selection in that case.
      return { runId, taskId: text(t.id, 80), title: text(t.task_title ?? t.title ?? t.display_name, 200), status: text(t.status, 40),
        dispatchId: matching.length === 1 ? matching[0].dispatchId : null,
        dispatches: matching.map((w) => ({ id: w.dispatchId, state: text(w.state, 40), host: text(w.host, 128) })),
        reportedResult: text(t.result), observedAt: now() };
    });
  }
  async function observe(target) {
    const [ts, { data, runtime }] = await Promise.all([tasks(target.runId), read('worker', { dispatchId: target.dispatchId })]);
    const task = ts.find((t) => t.taskId === target.taskId);
    const d = data.dispatch, p = data.projection;
    if (!task || d?.id !== target.dispatchId || (d.taskId ?? d.task_id) !== target.taskId || d.runId !== target.runId) throw new Error('The selected Orca target is no longer available.');
    if (p?.host?.kind !== 'local' || p.host.id !== 'local') throw new Error('This supervisor only supports local Orca Tasks.');
    const dispatches = task.dispatches.map((w) => w.id).sort();
    if (!dispatches.includes(target.dispatchId)) throw new Error('The selected dispatch is no longer associated with this Task.');
    const status = task.status;
    // Task status is authoritative; worker activity, process exit and terminal accounting are not.
    const outcome = status === 'completed' ? (p.outcome === 'succeeded' ? 'succeeded' : p.outcome === 'failed' ? 'failed' : null)
      : ['failed', 'cancelled', 'canceled', 'abandoned'].includes(status) ? status : null;
    return { ...task, dispatchId: target.dispatchId, dispatches, outcome, runtime,
      incarnation: text(data.worker?.processIncarnation ?? d.processIncarnation, 160),
      workspace: text(p.workspace?.id, 500), host: 'local', detail: text(p.stage?.detail, 200) };
  }
  async function evidence(dispatchId) {
    const { data } = await read('transcript', { dispatchId });
    if (data.source !== 'transcript' || data.dispatchId !== dispatchId) throw new Error('Exact transcript evidence is unavailable.');
    const messages = array(data.transcript, 'messages');
    return { text: text(messages.filter((m) => m.role === 'assistant').map((m) => (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')).join('\n\n')),
      limited: !!data.transcript.limited, warnings: (data.warnings ?? []).map((s) => text(s, 200)).slice(0, 5) };
  }
  return { status, workspaces, launchSupervisor, messageSupervisor, runs, tasks, observe, evidence };
}
