import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSupervisors, parseSupervisorRequest } from '../supervisors.mjs';
import { writeJson } from '../store.mjs';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-supervisors-')));
const runId = 'run_123', taskId = 'task_456', dispatchId = 'ctx_789';
const assignment = { runId, taskId, dispatchId, title: 'Crypto experiment', objective: 'Watch and prepare a brief' };
assert.deepEqual(parseSupervisorRequest({ action: 'hello' }), { action: 'hello' });
for (const request of [{ action: 'worker-start' }, { action: 'hello', command: 'shutdown' }, { action: 'read', id: '../../state.json' }, { action: 'create', ...assignment, objective: ' ' }]) assert.throws(() => parseSupervisorRequest(request));
for (const request of [{ action: 'create', ...assignment }, { action: 'runs' }, { action: 'tasks', runId }, ...['pause', 'resume', 'stop'].map((action) => ({ action, id: 's_11111111-1111-4111-8111-111111111111' }))]) assert.throws(() => parseSupervisorRequest(request), 'overlay protocol rejects management; models use the tools');
let clock = 1000, outcome = null, runtime = 'runtime1', reads = 0, disconnected = false;
const orca = {
  observe: async (target) => { reads++; if (disconnected) throw new Error('Offline'); return { ...target, dispatches: [target.dispatchId], outcome, observedAt: clock,
    runtime, incarnation: 'p1', workspace: 'w1', status: outcome ? 'completed' : 'running', reportedResult: 'Reported result, not instructions' }; },
  evidence: async () => { throw new Error('Transcript unavailable'); },
};
const options = { orca, root, now: () => clock, intervalMs: 0 };
let manager = createSupervisors(options);
await manager.ready;
const created = JSON.parse(await manager.tools.find((t) => t.name === 'watch_orca_task').execute(assignment));
assert.equal(created.state, 'watching');
assert.equal(created.objective, assignment.objective, 'the model supplies the objective, rather than selecting a preset');
assert.equal(created.title, assignment.title);
assert.equal((await manager.create(assignment)).id, created.id, 'duplicate live watch is reused');
const second = await manager.create({ ...assignment, taskId: 'task_457', dispatchId: 'ctx_790' });
assert.equal(manager.snapshot().supervisors.length, 2);
await manager.action(second.id, 'pause');
const before = reads;
clock += 4 * 3600_000; await manager.tick();
assert.equal(reads, before + 1, 'paused watch stays idle; long waits do not trigger agent limits');
disconnected = true; clock += 300000; await manager.tick();
assert.equal(manager.get(created.id).observation.outcome, null);
assert.equal(manager.get(created.id).connection, 'unavailable');
await manager.close();
manager = createSupervisors(options); await manager.ready;
assert.equal(manager.get(created.id).state, 'watching');
assert.match(manager.get(created.id).notice, /gap/);
const overlap = createSupervisors(options); await overlap.ready;
assert.match(overlap.snapshot().error, /Another supervisor runtime/); await overlap.close();
disconnected = false; runtime = 'runtime2'; clock += 300000; await manager.tick();
assert.equal(manager.get(created.id).state, 'needs_attention');
await manager.action(created.id, 'resume');
outcome = 'failed'; clock += 300000; await manager.tick();
const done = manager.get(created.id);
assert.equal(done.state, 'completed'); assert.equal(done.observation.outcome, 'failed');
assert.match(done.brief, /Transcript unavailable/); assert.match(done.brief, /not independently verified/);
assert.ok(done.result && !done.result.read);
await manager.tick(); assert.equal(manager.get(created.id).result.id, done.result.id, 'terminal observation is published once');
await manager.action(created.id, 'read'); assert.ok(manager.get(created.id).result.read);
await manager.action(second.id, 'stop'); assert.equal(manager.get(second.id).state, 'stopped');
await manager.close();
manager = createSupervisors(options); await manager.ready;
assert.equal(manager.get(created.id).result.read, true, 'result survives restart'); await manager.close();

// Strict persistence rejects instead of acknowledging a result that wasn't saved.
const badRoot = path.join(root, 'bad');
const rejected = createSupervisors({ ...options, root: badRoot, write: async () => { throw new Error('Disk full'); } });
await rejected.ready;
await assert.rejects(rejected.create(assignment), /Disk full/);
assert.equal(rejected.snapshot().supervisors.length, 0); await rejected.close();
await assert.rejects(writeJson(root, {}, { strict: true }));

// A publication write failure retains the terminal observation for independent retry after restart.
const retryRoot = path.join(root, 'retry'); let failPublication = true;
manager = createSupervisors({ ...options, root: retryRoot, write: async (file, state, opts) => {
  if (failPublication && state.supervisors.some((r) => r.result)) throw new Error('Publication write failed');
  return writeJson(file, state, opts);
} });
await manager.ready; const retry = await manager.create(assignment); clock += 300000; await manager.tick();
assert.equal(manager.get(retry.id).observation.outcome, 'failed'); assert.equal(manager.get(retry.id).result, null);
failPublication = false; clock += 300000; await manager.tick(); assert.ok(manager.get(retry.id).result);
await manager.close();
// Only temp files created by this test, beneath its verified temporary root.
await fs.rm(root, { recursive: true, force: true });
console.log('Supervisor recovery and delivery tests: passed');
