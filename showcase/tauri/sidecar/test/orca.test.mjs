import assert from 'node:assert/strict';
import { createOrca, cleanOrcaEnv, findOrca } from '../orca.mjs';
const calls = [];
let taskStatus = 'running', outcome = 'pending', host = 'local';
const runId = 'run_123', taskId = 'task_456', dispatchId = 'ctx_789';
const orca = createOrca({ binary: () => '/trusted/orca', env: { PATH: 'ok', ORCA_ENVIRONMENT: 'remote', ORCA_SPAWN_TOKEN: 'secret', ORCA_SESSION_ID: 'coordinator' }, now: () => 100,
  transport: async (file, args, opts) => {
    calls.push(args);
    assert.deepEqual(opts.env, { PATH: 'ok' }); assert.equal(opts.windowsHide, true);
    assert.equal(args.at(-3), '--environment'); assert.equal(args.at(-2), 'local');
    const data = {
      'run-list': { runs: [{ id: runId, objective: 'Crypto' }], nextCursor: 'page2' },
      'task-list': { runId, tasks: [{ id: taskId, task_title: 'Experiment', status: taskStatus, result: 'Reported result' }] },
      'worker-list': { workers: [{ dispatchId, taskId, host }] },
      'worker-show': { dispatch: { id: dispatchId, runId, taskId, processIncarnation: 'process1' }, projection: { host: { kind: host, id: host }, outcome, workspace: { id: 'workspace' }, stage: { detail: 'waiting' } } },
      'worker-read': { dispatchId, source: 'transcript', transcript: { messages: [{ role: 'assistant', blocks: [{ type: 'text', text: 'Done' }] }], limited: true }, warnings: ['clipped'] },
    }[args[1]];
    assert.ok(data, 'no undocumented calls'); return JSON.stringify({ ok: true, result: data, _meta: { runtimeId: 'runtime1' } });
  } });
assert.deepEqual(cleanOrcaEnv({ ORCA_X: 'x', orca_y: 'y', HOME: 'h' }), { HOME: 'h' });
assert.throws(() => findOrca({ ORCA_CLI_COMMAND: '/does-not-exist/orca', PATH: process.env.PATH }), /no other Orca build/);
assert.equal((await orca.runs()).nextCursor, 'page2');
assert.equal((await orca.tasks(runId))[0].dispatchId, dispatchId);
assert.equal((await orca.observe({ runId, taskId, dispatchId })).outcome, null, 'idle/running is not completion');
taskStatus = 'completed'; outcome = 'succeeded';
assert.equal((await orca.observe({ runId, taskId, dispatchId })).outcome, 'succeeded');
outcome = 'failed';
assert.equal((await orca.observe({ runId, taskId, dispatchId })).outcome, 'failed', 'completed Task can report a failed worker');
host = 'ssh'; await assert.rejects(orca.observe({ runId, taskId, dispatchId }), /local/);
assert.deepEqual(await orca.evidence(dispatchId), { text: 'Done', limited: true, warnings: ['clipped'] });
assert.ok(calls.every((a) => !a.includes('check') && !a.includes('--from') && !a.includes('auto')));
const bad = createOrca({ binary: () => '/trusted/orca', transport: async () => 'not json' });
await assert.rejects(bad.runs(), /invalid JSON/);
const wrong = createOrca({ binary: () => '/trusted/orca', transport: async () => JSON.stringify({ ok: true, result: { source: 'terminal' } }) });
await assert.rejects(wrong.evidence(dispatchId), /Exact transcript/);
console.log('Orca observation tests: passed');
