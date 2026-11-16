import assert from 'node:assert/strict';
import { createHindsightSettings, hindsightOn } from '../hindsight-settings.mjs';
import { hindsightServiceReady } from '../hindsight-provider.mjs';

assert.equal(hindsightOn({}, {}), false);
assert.equal(hindsightOn({}, { ROAMIES_HINDSIGHT_URL: 'http://127.0.0.1:8888' }), true);
assert.equal(hindsightOn({ hindsight: false }, { ROAMIES_HINDSIGHT_URL: 'http://127.0.0.1:8888' }), false, 'saved off wins over environment');
assert.equal(hindsightOn(JSON.parse(JSON.stringify({ hindsight: true })), {}), true, 'saved choice survives reload');

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const made = [], states = [], facts = [{ id: 'f1', text: 'User likes tea' }];
let healthy = true, healthCalls = 0, finishRecall = null, finishFlush = null;
const settings = createHindsightSettings({ dir: 'unused', facts: () => facts,
  changed: () => states.push(settings.state()),
  fetcher: async (_, options) => { healthCalls++; assert.equal(options.redirect, 'error'); return new Response(JSON.stringify({ status: healthy ? 'healthy' : 'starting' })); },
  factory: (options) => {
    const client = { enabled: true, closed: false, synced: [], options,
      sync(f) { this.synced.push(f); }, recall() { return finishRecall ? finishRecall.promise : Promise.resolve(['doc1']); },
      close() { this.closed = true; }, flush() { return finishFlush ? finishFlush.promise : Promise.resolve(); } };
    made.push(client); return client;
  } });
assert.equal(settings.state().phase, 'off');
settings.sync(facts); await settings.check(); assert.deepEqual(await settings.recall('tea'), []);
assert.equal(healthCalls, 0); assert.equal(made.length, 0, 'off does not contact service or load an adapter');
await settings.setEnabled(true); assert.equal(settings.state().phase, 'ready');
assert.deepEqual(made[0].synced, [facts]);
healthy = false; await settings.check(); assert.equal(settings.state().phase, 'offline');
healthy = true; await settings.check(); assert.equal(settings.state().phase, 'ready');
finishRecall = deferred(); const recall = settings.recall('tea');
finishFlush = deferred();
await settings.setEnabled(false); assert.equal(settings.state().phase, 'off'); assert.ok(made[0].closed);
finishRecall.resolve(['doc-from-disabled-client']); assert.deepEqual(await recall, [], 'late recall excluded after off');
const enabling = settings.setEnabled(true);
await Promise.resolve(); assert.equal(made.length, 1, 'new writer waits for retired writer');
await settings.setEnabled(false);
finishFlush.resolve(); await enabling;
assert.equal(made.length, 1, 'an enable superseded by off never starts another adapter');
finishFlush = null; finishRecall = null;
await settings.setEnabled(true); assert.equal(made.length, 2);
made[0].options.log('hindsight_failed', { operation: 'sync' });
assert.equal(settings.state().phase, 'ready', 'late event from retired client cannot overwrite status');
made[1].options.log('hindsight_failed', { operation: 'sync' }); assert.equal(settings.state().phase, 'offline');
made[1].options.log('hindsight_recall', { ms: 310 }); assert.equal(settings.state().ms, 310);
settings.close(); assert.deepEqual(await settings.recall('tea'), []);

const invalid = createHindsightSettings({ dir: 'unused', endpoint: 'https://example.com', facts: () => [], fetcher: () => { throw new Error('must not fetch'); } });
await invalid.setEnabled(true); assert.equal(invalid.state().phase, 'invalid'); invalid.close();
assert.equal(await hindsightServiceReady(async (_, o) => { assert.equal(o.redirect, 'error'); return new Response('{"status":"healthy"}'); }), true);
assert.equal(await hindsightServiceReady(async () => { throw new Error('offline'); }), false);
console.log('hindsight settings tests: passed');
