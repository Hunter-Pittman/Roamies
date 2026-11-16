import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const source = fs.readFileSync(new URL('../../../roamies/supervisors.js', import.meta.url), 'utf8');
const { window, document } = parseHTML('<html><head></head><body></body></html>');
window.Roamie = { safe: { top: 25, bottom: 60, left: 0, right: 0 } };
Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get: () => 640 });
Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { get: () => 560 });
window.HTMLElement.prototype.getBoundingClientRect = function () {
  const left = parseFloat(this.style.left) || 0, top = parseFloat(this.style.top) || 0;
  return { left, top, width: 640, height: 560 };
};
window.HTMLElement.prototype.focus = () => {};
const frames = [];
vm.runInNewContext(source, { window, document, innerWidth: 1280, innerHeight: 900, addEventListener: () => {}, setInterval: () => {}, setTimeout: () => {}, requestAnimationFrame: (fn) => frames.push(fn), Date, Math });
const R = window.Roamie, card = R.supervisors, sent = [];
card.send = (m) => sent.push(m.request);
assert.equal(R.supervisorRect(), null, 'closed overlay captures no clicks');
card.open();
assert.equal(card.isOpen, true); assert.equal(sent.at(-1).action, 'hello');
const rect = R.supervisorRect();
assert.ok(R.supervisorHit(rect[0] + 10, rect[1] + 10));
assert.equal(R.supervisorHit(1279, 899), false, 'rest of desktop remains click-through');
const record = { id: 's_11111111-1111-4111-8111-111111111111', title: '<img src=x onerror=alert(1)>', objective: 'Watch this task', state: 'completed', createdAt: 1000,
  connection: 'connected', target: { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1' }, observation: { status: 'completed', outcome: 'failed' },
  brief: '<script>malicious()</script>', result: { read: false, presented: false } };
card.event({ kind: 'state', supervisors: [record], monitoring: 'While Roamies is open' });
assert.equal(document.querySelector('.sv img'), null);
assert.equal(document.querySelector('.sv script'), null, 'reports are rendered as text');
assert.ok(document.querySelector('.sv .brief').textContent.includes('<script>'));
assert.match(document.querySelector('[data-sv="detail"] .badge').textContent, /Failed · Basic/, 'failed outcomes are not labeled done');
assert.equal(sent.at(-1).action, 'read', 'opening a saved report acknowledges it without a management action');
assert.equal(document.querySelector('.sv form, .sv input, .sv select'), null, 'read-only view has no setup workflow');
assert.equal(document.querySelectorAll('.sv button').length, 2, 'only supervisor navigation and close are offered');

const long = { ...record, kind: 'coordinator', mode: 'advanced', observation: { outcome: 'succeeded' }, brief: 'The experiments finished. The results match the target, but formal blindness was not established. ' + 'Technical evidence and detailed validation. '.repeat(60) };
card.event({ kind: 'state', supervisors: [long] });
assert.ok(document.querySelector('.sv .brief').textContent.length <= 640, 'long legacy briefs stay compact by default');
assert.ok(document.querySelector('.sv pre').textContent.includes('Technical evidence'), 'full older evidence remains available');
assert.ok(!document.querySelector('.sv details').open, 'detail is collapsed');
document.querySelector('.sv details').open = true;
card.event({ kind: 'state', supervisors: [long] });
assert.equal(document.querySelector('.sv details').open, true, 'refresh does not collapse evidence while it is being read');
assert.match(document.querySelector('[data-sv="detail"] .badge').textContent, /Done · Advanced/);
document.querySelector('[data-sv="close"]').click();
assert.equal(card.isOpen, false); assert.equal(R.supervisorRect(), null); assert.equal(sent.at(-1).action, 'close');
const closedCount = sent.length;
card.event({ kind: 'state', supervisors: [long] });
assert.equal(sent.length, closedCount, 'a closed overlay does not mark a result read');
assert.ok(sent.every((m) => ['hello', 'close', 'read'].includes(m.action)), 'the view cannot dispatch or control work');
const alert = { text: 'The experiment needs you.', mood: 'concerned', events: [{ id: record.id, key: `${record.id}:question:1` }] };
const shown = [];
const beforeAlert = sent.length;
card.notify(alert, { blocked: () => true, say: (...args) => { shown.push(args); return {}; } }); frames.shift()();
assert.equal(shown.length, 0); assert.equal(sent.length, beforeAlert, 'blocked alerts are not acknowledged');
card.notify(alert, { say: () => null }); frames.shift()();
assert.equal(sent.length, beforeAlert, 'a missing creature cannot acknowledge presentation');
const say = (...args) => { shown.push(args); return {}; };
card.notify(alert, { say });
assert.equal(sent.length, beforeAlert, 'sending an alert is not proof it was shown');
frames.shift()();
assert.equal(shown.length, 1); assert.equal(sent.at(-1).action, 'notified');
card.notify(alert, { say }); frames.shift()();
assert.equal(shown.length, 1, 'transport retries acknowledge again without opening a duplicate bubble');
assert.equal(card.isOpen, false, 'an alert never opens a management window');
for (const [view, safe] of [[[1280, 900], R.safe], [[800, 600], {}]]) {
  const point = Array.from(R.supervisorPlace([2000, 2000], [640, 500], safe, view));
  assert.ok(point[0] >= 12 && point[1] >= (safe.top ?? 0) + 12);
  assert.ok(point[0] + 640 <= view[0] - 12 && point[1] + 500 <= view[1] - (safe.bottom ?? 0) - 12);
}
console.log('Supervisor overlay interaction tests: passed');
