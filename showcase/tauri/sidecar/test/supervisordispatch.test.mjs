// The real supervisor manager and Orca adapter with a scripted CLI transport; never starts real project work.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOrca } from '../orca.mjs';
import { createSupervisors, parseSupervisorRequest } from '../supervisors.mjs';
import { writeJson } from '../store.mjs';
import { resolveToolSchema } from '@kenkaiiii/gg-ai';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-model-supervisor-')));
const workspace = 'identity:wt2:local:11111111-1111-4111-8111-111111111111';
const input = { workspace, agent: 'codex', title: 'Finish crypto experiments', objective: 'Run the remaining planned experiments and summarize their evidence.', instructions: 'Inspect the existing experiment plan. Run only remaining experiments within the existing budget. Use workers as needed. Ask before expanding scope.' };
let allow = true, launches = 0, messages = 0, ambiguous = false, rejectMessage = false;
const calls = [];
const orca = createOrca({ binary: () => '/trusted/orca', env: { ORCA_SESSION_ID: 'not-the-supervisor', ORCA_ENVIRONMENT: 'remote', PATH: 'ok' }, transport: async (file, args, options) => {
  calls.push(args); assert.deepEqual(options.env, { PATH: 'ok' });
  if (args[0] === 'worktree') return JSON.stringify({ ok: true, result: { truncated: false, worktrees: [{ hostId: 'local', address: { environment: 'local', worktree: workspace }, displayName: 'Crypto', path: '/projects/crypto', repo: 'crypto', agents: [{ agentType: 'codex' }] }] } });
  if (args[0] === 'agent') {
    launches++; assert.equal(args[1], 'launch'); assert.ok(!args.includes('--from') && !args.includes('--focus') && !args.includes('--model'));
    const prompt = args[args.indexOf('--prompt') + 1];
    assert.ok(prompt.includes(input.objective) && prompt.includes(input.instructions));
    assert.match(prompt, /Mode: basic/); assert.match(prompt, /<supervisor-skill>/); assert.match(prompt, /READ-ONLY overlay/);
    if (ambiguous) throw new Error('connection lost after acceptance');
    return JSON.stringify({ ok: true, result: { outcome: { kind: 'structured', handle: 'orca_session_id:supervisor-123' }, prompt: { outcome: 'journaled' }, operationId: 'launch_123' } });
  }
  if (args[0] === 'terminal') {
    messages++; assert.ok(args.includes('orca_session_id:supervisor-123'));
    return JSON.stringify({ ok: true, result: { send: { accepted: !rejectMessage, prompt: { requestId: 'msg_123', provider: 'codex' } } } });
  }
  throw new Error(`Unexpected operation: ${args[0]}`);
} });
assert.equal((await orca.workspaces())[0].workspace, workspace);
let manager = createSupervisors({ orca, root, intervalMs: 0, allowDispatch: () => allow }); await manager.ready;
for (const tool of manager.tools) assert.equal(resolveToolSchema(tool).type, 'object', `${tool.name} has a provider-compatible schema`);
allow = false; assert.throws(() => manager.launch(input), /requires Allow/); assert.equal(launches, 0);
allow = true;
const launched = JSON.parse(await manager.tools.find((t) => t.name === 'create_supervisor').execute(input));
assert.equal(launched.state, 'working'); assert.equal(launched.launch.receipt.surface, 'structured');
assert.equal(launched.launch.request, undefined, 'the overlay gets status, never launch inputs');
assert.equal((await manager.launch(input)).id, launched.id); assert.equal(launches, 1, 'duplicate model calls do not launch twice');
orca.observe = async (target) => ({ ...target, dispatches: [target.dispatchId], runtime: 'runtime1', incarnation: 'p1', workspace: 'w1', status: 'running', outcome: null, observedAt: 100 });
const existingWatch = await manager.create({ runId: 'run_123', taskId: 'task_123', dispatchId: 'ctx_123', title: 'Existing task', objective: 'Observe existing work alongside the model supervisor.' });
await manager.action(existingWatch.id, 'pause');
assert.equal(manager.snapshot().supervisors.length, 2, 'model supervisors and existing-task watches coexist');
assert.ok(calls.every((a) => !a.includes('worker-start') && !a.includes('check')), 'external observer does not impersonate a coordinator');
const reportFile = path.join(root, `${launched.id}.report.json`);
async function report(revision, state, fields = {}) { await fs.writeFile(reportFile, JSON.stringify({ supervisorId: launched.id, revision, state, progress: 'The model generated three experiments and dispatched workers.', ...fields })); }
await report(1, 'working'); await manager.tick(); assert.equal(manager.get(launched.id).revision, 1);
await report(2, 'waiting', { needsYou: 'May I extend the compute budget?' }); await manager.tick();
assert.equal(manager.get(launched.id).state, 'needs_attention'); assert.match(manager.get(launched.id).question, /compute budget/);
const delivery = await manager.message(launched.id, 'Keep the original budget.'); assert.equal(delivery.accepted, true);
const acceptedCount = messages;
assert.equal((await manager.message(launched.id, 'Keep the original budget.')).alreadyDelivered, true); assert.equal(messages, acceptedCount);
rejectMessage = true;
assert.equal((await manager.message(launched.id, 'Use the smaller dataset.')).uncertain, true);
const sent = messages;
await assert.rejects(manager.message(launched.id, 'Use the smaller dataset.'), /uncertain delivery/); assert.equal(messages, sent);
await report(1, 'working'); await manager.tick(); assert.equal(manager.get(launched.id).revision, 2, 'old reports cannot regress state');
await fs.writeFile(reportFile, JSON.stringify({ supervisorId: 's_22222222-2222-4222-8222-222222222222', revision: 3, state: 'completed', progress: 'spoofed', report: 'spoofed' }));
await manager.tick(); assert.equal(manager.get(launched.id).result, null, 'wrong report identity cannot complete an assignment');
await report(3, 'completed', { report: 'The supervisor model generated this brief from worker results. Two runs passed; the third is inconclusive. Evidence: experiment log. No claim of independent verification.' });
await manager.tick(); assert.equal(manager.get(launched.id).state, 'completed'); assert.match(manager.get(launched.id).brief, /inconclusive/);
const resultId = manager.get(launched.id).result.id; await manager.tick(); assert.equal(manager.get(launched.id).result.id, resultId);
await manager.close();
manager = createSupervisors({ orca, root, intervalMs: 0, allowDispatch: () => allow }); await manager.ready;
assert.equal(manager.get(launched.id).result.id, resultId); assert.equal(launches, 1, 'restart never relaunches a supervisor'); await manager.close();

// Lost launch replies remain uncertain and are never retried as a new launch, including after restart.
ambiguous = true;
const uncertainRoot = path.join(root, 'uncertain');
manager = createSupervisors({ orca, root: uncertainRoot, intervalMs: 0, allowDispatch: () => true }); await manager.ready;
const uncertain = await manager.launch(input); assert.equal(uncertain.state, 'needs_attention');
const count = launches; assert.equal((await manager.launch(input)).id, uncertain.id); assert.equal(launches, count);
await manager.close(); manager = createSupervisors({ orca, root: uncertainRoot, intervalMs: 0, allowDispatch: () => true }); await manager.ready;
await manager.tick(); assert.equal(launches, count); await manager.close();

// No external effect before durable intent, and a failed receipt save retains the accepted receipt.
const blocked = createSupervisors({ orca, root: path.join(root, 'disk-full'), intervalMs: 0, allowDispatch: () => true, write: async () => { throw new Error('Disk full'); } });
await blocked.ready; await assert.rejects(blocked.launch(input), /Disk full/); assert.equal(launches, count); await blocked.close();
ambiguous = false; let receiptFailure = true;
manager = createSupervisors({ orca, root: path.join(root, 'receipt'), intervalMs: 0, allowDispatch: () => true, write: async (file, state, opts) => {
  if (receiptFailure && state.supervisors.some((r) => r.state === 'working')) { receiptFailure = false; throw new Error('Receipt write failed'); }
  return writeJson(file, state, opts);
} }); await manager.ready;
const retained = await manager.launch(input); assert.equal(retained.launch.receipt.operationId, 'launch_123'); assert.equal(retained.launch.uncertain, false); await manager.close();
for (const action of ['create', 'message', 'launch', 'pause', 'stop']) assert.throws(() => parseSupervisorRequest({ action, ...input }));
await fs.rm(root, { recursive: true, force: true });
console.log('Model supervisor dispatch and report tests: passed');
