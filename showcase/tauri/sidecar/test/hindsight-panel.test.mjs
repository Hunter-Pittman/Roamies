// Exercise the actual sidecar protocol and persisted setting, with isolated home/data and a health-only server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-hindsight-panel-'));
let healthCalls = 0;
const server = createServer((req, res) => { healthCalls++; assert.equal(req.url, '/health'); res.end('{"status":"healthy"}'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await fs.writeFile(path.join(dir, 'sidekick.json'), JSON.stringify({ hindsight: false, voice: false, replies: 'text', onboarded: false }));
const children = [];
function launch() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../sidekick.mjs', import.meta.url))], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir, ROAMIES_DATA_DIR: dir, ROAMIES_HANDS: '',
      ROAMIES_HINDSIGHT_URL: `http://127.0.0.1:${server.address().port}` }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  children.push(child);
  const states = [], waiters = [];
  let errors = '';
  child.stderr.on('data', (b) => { errors += b; });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.type !== 'panel' || m.msg?.kind !== 'state') return;
    states.push(m.msg.state);
    for (const w of waiters.slice()) if (w.predicate(m.msg.state)) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve(m.msg.state); }
  });
  const wait = (predicate) => new Promise((resolve, reject) => {
    const state = states.findLast(predicate); if (state) { resolve(state); return; }
    const w = { predicate, resolve, timer: setTimeout(() => reject(new Error(`Sidecar panel timed out: ${errors.slice(-1000)}`)), 15_000) };
    waiters.push(w);
  });
  return { child, send, wait };
}
try {
  let app = launch(); app.send({ type: 'panel_open' });
  await app.wait((s) => s.hindsight?.on === false);
  assert.equal(healthCalls, 0, 'saved off prevents the environment flag from enabling network access');
  app.send({ type: 'menu', id: 'hindsight' });
  await app.wait((s) => s.hindsight?.on && s.hindsight.phase === 'ready');
  assert.ok(healthCalls > 0);
  app.send({ type: 'menu', id: 'hindsight' });
  // Ask for a fresh state; the original off state is already in the history.
  app.send({ type: 'panel_open' });
  app.child.stdin.end();
  await new Promise((r) => app.child.once('exit', r));
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'sidekick.json'), 'utf8')).hindsight, false);
  const beforeReload = healthCalls;
  app = launch(); app.send({ type: 'panel_open' });
  await app.wait((s) => s.hindsight?.on === false);
  assert.equal(healthCalls, beforeReload, 'disabled state remains off after a real process restart');
  app.child.stdin.end(); await new Promise((r) => app.child.once('exit', r));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  assert.ok(dir.startsWith(path.join(os.tmpdir(), 'roamies-hindsight-panel-')));
  await fs.rm(dir, { recursive: true, force: true });
}
console.log('hindsight panel persistence tests: passed');
