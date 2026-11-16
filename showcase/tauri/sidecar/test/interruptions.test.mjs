import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canInterrupt, createSupervisorNotifier, DEFAULT_INTERRUPTION_RULES, interruptionMode, supervisorInterruption } from '../interruptions.mjs';
import { createSupervisors, parseSupervisorRequest } from './supervisorfixture.mjs';
import { newsDesk } from '../agents.mjs';

assert.equal(canInterrupt('failures', {}, { focus: true }, 0, 100), true);
assert.equal(canInterrupt('questions', {}, { focus: true }, 0, 100), true);
assert.equal(canInterrupt('completions', {}, { focus: true }, 60000, 100), false);
assert.equal(canInterrupt('completions', {}, {}, 14999, 100), false);
assert.equal(canInterrupt('completions', {}, {}, 15000, 100), true);
for (const gate of ['busy', 'queued', 'barOpen', 'voice', 'saidPending', 'autoListen', 'asking', 'onboarding', 'intro', 'loggingIn']) {
  assert.equal(canInterrupt('failures', {}, { [gate]: true }, 60000, 100), false, `urgent does not talk over ${gate}`);
}
assert.equal(interruptionMode('questions', { snoozeUntil: 101 }, 100), 'off');
assert.equal(interruptionMode('questions', { snoozeUntil: 100 }, 100), 'immediate', 'snooze expires at its boundary');
assert.equal(canInterrupt('failures', { failures: 'off' }, {}, 60000, 100), false);

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-interruptions-')));
let time = 100000, gate = { focus: true }, ack = true;
const deliveries = [];
const opts = { root, now: () => time, intervalMs: 0, allowDispatch: () => true, orca: { launchSupervisor: async () => ({ handle: 'terminal_123', surface: 'terminal' }) } };
let manager = createSupervisors(opts);
const launch = (title) => manager.launch({ title, workspace: 'identity:wt2:local:abc-123', agent: 'codex', objective: title, instructions: 'Stay in scope.' });
const report = async (r, revision, state, fields = {}) => {
  await fs.writeFile(path.join(root, `${r.id}.report.json`), JSON.stringify({ supervisorId: r.id, revision, state, progress: 'Current progress.', ...fields }));
  await manager.tick();
};
const notifier = () => createSupervisorNotifier({ now: () => time, gates: () => gate, snapshot: () => manager.snapshot(), claim: (id, key) => manager.claimNotification(id, key),
  deliver: async (m) => { deliveries.push(m); if (ack) for (const e of m.events) await manager.notified(e.id, e.key); } });
try {
  await manager.ready;
  assert.deepEqual(manager.snapshot().interruptions, DEFAULT_INTERRUPTION_RULES);
  const done = await launch('Completed experiment'), question = await launch('Budget decision'), failed = await launch('Failed experiment');
  await report(done, 1, 'completed', { report: 'All planned runs finished. The results matched.' });
  await report(question, 1, 'waiting', { needsYou: 'May I extend the budget?' });
  await report(failed, 1, 'failed', { report: 'The required dataset could not be accessed.' });
  let desk = notifier();
  await desk.tick();
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].events[0].id, failed.id, 'failure wins over completed results');
  const result = manager.get(failed.id).result;
  assert.equal(result.announced, true); assert.equal(result.read, false); assert.equal(result.presented, false, 'notification receipt does not pretend the brief was read');
  time += 10001; await desk.tick();
  assert.equal(deliveries.at(-1).events[0].id, question.id, 'a question reaches the user during focus at a safe break');
  time += 60000; await desk.tick(); assert.equal(deliveries.length, 2, 'completion stays quiet during focus');
  gate = {}; await desk.tick(); assert.equal(deliveries.at(-1).events[0].id, done.id);

  await report(question, 2, 'waiting', { needsYou: 'May I extend the budget?' });
  time += 20000; await desk.tick(); assert.equal(deliveries.length, 3, 'same question is not a new notification on each revision');
  await report(question, 3, 'working');
  await report(question, 4, 'waiting', { needsYou: 'May I extend the budget?' });
  await desk.tick(); assert.equal(deliveries.length, 4, 'a new question episode can notify again');

  const tool = manager.tools.find((t) => t.name === 'interruption_rules');
  const quiet = JSON.parse(await tool.execute({ failures: null, questions: null, completions: 'off', snoozeMinutes: 60 }));
  assert.equal(quiet.snoozeUntil, time + 3600000);
  const blocked = await launch('Needs input during snooze');
  await report(blocked, 1, 'waiting', { needsYou: 'Which dataset?' });
  time += 30000; await desk.tick(); assert.equal(deliveries.length, 4, 'explicit snooze silences even urgent work announcements');
  assert.ok(manager.get(blocked.id).question, 'quieting announcements does not hide or answer questions');
  await manager.close(); manager = createSupervisors(opts); await manager.ready; desk = notifier();
  assert.equal(manager.snapshot().interruptions.completions, 'off');
  assert.equal(manager.snapshot().interruptions.snoozeUntil, quiet.snoozeUntil, 'preferences survive restart');
  await desk.tick(); assert.equal(deliveries.length, 4);
  await manager.setInterruptions({ snoozeMinutes: 0 }); await desk.tick(); assert.equal(deliveries.length, 5, 'resume restores previous category settings');

  // Lost UI delivery is retryable across restart, with backoff and no false receipt.
  const retry = await launch('Delivery retry');
  await report(retry, 1, 'failed', { report: 'No access to the required machine.' });
  ack = false; time += 10001; await desk.tick();
  const attemptCount = deliveries.length, key = deliveries.at(-1).events[0].key;
  assert.equal(manager.get(retry.id).result.announced, undefined, 'transport send alone is not delivery');
  time += 10001; await desk.tick(); assert.equal(deliveries.length, attemptCount);
  await manager.close(); manager = createSupervisors(opts); await manager.ready; desk = notifier();
  await desk.tick(); assert.equal(deliveries.length, attemptCount, 'restart retains retry backoff');
  time += 20000; await desk.tick(); assert.equal(deliveries.length, attemptCount + 1);
  assert.equal(deliveries.at(-1).events[0].key, key);
  assert.equal(await manager.notified(retry.id, 'stale-key'), false);
  assert.equal(await manager.notified(retry.id, key), true);
  time += 300000; await desk.tick(); assert.equal(deliveries.length, attemptCount + 1, 'acknowledged events do not repeat');

  // Muted completions remain in saved status. Batched completions share one interruption when enabled again.
  const one = await launch('Batch one'), two = await launch('Batch two');
  await report(one, 1, 'completed', { report: 'Finished.' }); await report(two, 1, 'completed', { report: 'Finished.' });
  await desk.tick(); assert.equal(deliveries.length, attemptCount + 1);
  await manager.setInterruptions({ completions: 'quiet' }); ack = true;
  await desk.tick(); assert.equal(deliveries.at(-1).events.length, 2);
  assert.match(deliveries.at(-1).text, /2 supervisors finished/);
  assert.ok(!manager.get(one.id).result.read);
  assert.equal(supervisorInterruption(manager.get(one.id)), null);
  for (const p of [{ snoozeMinutes: -1 }, { snoozeMinutes: 1441 }, { failures: 'always' }, { command: 'run' }]) assert.throws(() => manager.setInterruptions(p));
  assert.equal(parseSupervisorRequest({ action: 'notified', id: one.id, key: manager.get(one.id).result.id }).action, 'notified');
  assert.throws(() => parseSupervisorRequest({ action: 'notified', id: '../state.json', key }));
  const alreadyAnswered = { ...manager.get(question.id), questionAnnouncedRevision: -1, notification: null, message: { state: 'accepted', revision: 4 } };
  assert.equal(supervisorInterruption(alreadyAnswered), null, 'accepted answers do not keep prompting while the supervisor processes them');
  alreadyAnswered.message.state = 'uncertain';
  assert.equal(supervisorInterruption(alreadyAnswered).category, 'questions', 'uncertain delivery is not an answer');
  const bad = createSupervisors({ ...opts, root: path.join(root, 'write-failure'), write: async () => { throw new Error('Disk full'); } });
  await bad.ready;
  await assert.rejects(bad.setInterruptions({ completions: 'off' }), /Disk full/);
  assert.equal(bad.snapshot().interruptions.completions, 'quiet', 'failed preference writes are not acknowledged as saved');
  await bad.close();
} finally { await manager.close(); await fs.rm(root, { recursive: true, force: true }); }

// The same persisted rules apply to built-in background agents, including focus and snooze.
let t = 100, g = { focus: true }, rules = { ...DEFAULT_INTERRUPTION_RULES };
const news = [{ id: 'a1', kind: 'done', title: 'Done', outcome: 'Finished.', files: [] }, { id: 'a2', kind: 'failed', title: 'Failed', reason: 'No access.' }];
const said = [];
const agentDesk = newsDesk({ now: () => t, gates: () => g, interruptions: () => rules, news: () => news, markTold: (ids) => { for (let i = news.length - 1; i >= 0; i--) if (ids.includes(news[i].id)) news.splice(i, 1); }, signedIn: () => false, say: (text) => said.push(text) });
agentDesk.tick(); assert.match(said[0], /No access/); assert.equal(news.length, 1);
t += 30000; agentDesk.tick(); assert.equal(said.length, 1);
g = {}; agentDesk.tick(); t += 15000; agentDesk.tick(); assert.equal(said.length, 2);
rules.snoozeUntil = t + 60000; news.push({ id: 'a3', kind: 'ask', question: 'Allow?', title: 'Worker' });
agentDesk.tick(); assert.equal(said.length, 2); assert.equal(agentDesk.along('What time is it?'), ''); assert.equal(news.length, 1);
console.log('Interruption priority, persistence, delivery and focus tests: passed');
