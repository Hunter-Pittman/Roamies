import assert from 'node:assert/strict';
import { createOrca } from '../orca.mjs';
let snapshot = { totalCount: 2, truncated: false, hostScope: { hostIds: ['local', 'hypervisor'], omittedHostIds: [] }, worktrees: [
  { repo: 'Crypto', displayName: 'main', hostId: 'local', agents: [
    { paneKey: 'chat-live', agentType: 'codex', conversationName: 'Untracked experiments', state: 'working', mainAgent: { state: 'working' }, updatedAt: 100, prompt: 'Private prompt must not be returned' },
    { paneKey: 'coordinator', agentType: 'codex', state: 'done', mainAgent: { state: 'done' }, children: [{ paneKey: 'child-live', state: 'working', agentType: 'claude' }] },
    { paneKey: 'child-live', parentPaneKey: 'coordinator', state: 'working', agentType: 'claude' },
    { paneKey: 'aggregate-live', state: 'working', mainAgent: { state: 'done' }, subagentObservation: 'unverifiable' },
  ] },
  { repo: 'Infrastructure', displayName: 'hypervisor', hostId: 'hypervisor', agents: [
    { paneKey: 'remote-wait', agentType: 'codex', state: 'waiting_for_approval' },
    { paneKey: 'unknown', state: 'unrecognized-new-state' },
  ] },
] };
const calls = [];
const orca = createOrca({ binary: () => '/trusted/orca', now: () => 123, transport: async (_file, args) => {
  calls.push(args);
  assert.deepEqual(args, ['worktree', 'ps', '--agent-wait', '--limit', '1000', '--environment', 'local', '--json']);
  return JSON.stringify({ ok: true, result: snapshot, _meta: { runtimeId: 'runtime_1' } });
} });
let result = await orca.status();
assert.equal(calls.length, 1, 'agent status never relies on Task history');
assert.deepEqual(result.summary, { working: 3, waiting: 1, idle: 1, unknown: 1, total: 6 });
assert.equal(result.agents[0].activity, 'working');
assert.ok(result.agents.some((a) => a.name === 'Untracked experiments'), 'ordinary chats without orchestration Tasks are included');
assert.equal(result.agents.filter((a) => a.id === 'child-live').length, 1, 'children are not double counted');
assert.ok(result.agents.some((a) => a.host === 'hypervisor'), 'host metadata is retained, not silently filtered to local agents');
assert.equal(result.coverage.unverifiedSubagentRoots, 1);
assert.equal(result.observedAt, 123);
assert.ok(!JSON.stringify(result).includes('Private prompt'), 'status does not return conversation bodies');
snapshot = { ...snapshot, truncated: true, hostScope: { hostIds: ['local'], omittedHostIds: ['hypervisor'] } };
result = await orca.status(); assert.equal(result.coverage.partial, true); assert.deepEqual(result.coverage.omittedHosts, ['hypervisor']);
snapshot = { totalCount: 1, worktrees: [{ repo: 'Unknown coverage', agents: [] }] };
assert.equal((await orca.status()).coverage.partial, true, 'missing coverage cannot establish a global negative');
console.log('Orca live activity coverage tests: passed');
