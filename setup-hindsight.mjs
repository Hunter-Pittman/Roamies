#!/usr/bin/env node
// Cross-platform developer setup. No credentials are written to the repository or passed on command lines.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node setup-hindsight.mjs [--check]\nRequires Node 22+, running Docker with Compose, and a Roamies ChatGPT sign-in.\nInstalls sidecar dependencies if missing, starts the local service, and waits for readiness.\nThen enable Hindsight memory on the Memory page. Keep this terminal open while using the service.\n--check verifies prerequisites and reports service status without starting or installing anything.');
  process.exit(0);
}
if (args.some((a) => a !== '--check')) { console.error('Unknown option. Run with --help.'); process.exit(1); }
const dir = fileURLToPath(new URL('./showcase/tauri/sidecar/', import.meta.url));
const check = args.includes('--check');
function fail(message) { console.error(message); process.exit(1); }
if (Number(process.versions.node.split('.')[0]) < 22) fail('Install Node.js 22 or newer, then run setup again.');
for (const argv of [['info', '--format', '{{.ServerVersion}}'], ['compose', 'version', '--short']]) {
  const r = spawnSync('docker', argv, { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (r.error || r.status !== 0) fail('Docker with Compose must be installed and running. Start Docker Desktop (or Docker Engine) and retry.');
}
console.log('Node and Docker Compose are ready.');
if (!existsSync(path.join(dir, 'node_modules', '@kenkaiiii', 'gg-core', 'package.json'))) {
  if (check) fail('Sidecar dependencies are missing. Run setup without --check to install them.');
  console.log('Installing sidecar dependencies from the lockfile...');
  // Static command and arguments only. npm.cmd requires the Windows command shell.
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], { cwd: dir, stdio: 'inherit',
    windowsHide: true, shell: process.platform === 'win32' });
  if (r.error || r.status !== 0) fail('Dependency installation failed. Run npm ci in showcase/tauri/sidecar, then retry.');
}
try {
  const { hindsightServiceReady, runHindsightSetup } = await import('./showcase/tauri/sidecar/hindsight-provider.mjs');
  if (check) {
    console.log((await hindsightServiceReady()) ? 'Hindsight is healthy. Enable Hindsight memory on the Memory page.' : 'Hindsight is not running. Run setup without --check to start it.');
  } else await runHindsightSetup();
} catch (e) {
  // Do not echo command objects, request bodies or credential resolver errors.
  fail(e.code === 'EADDRINUSE' ? 'Provider port 9078 is already in use. Stop the existing bridge and retry.' : 'Setup could not finish. Check your Roamies ChatGPT sign-in, Docker, and free ports 8888/9078/9999.');
}
