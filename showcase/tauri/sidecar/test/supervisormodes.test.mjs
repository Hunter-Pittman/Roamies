import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createSupervisors } from './supervisorfixture.mjs';
import { resolveToolSchema } from '@kenkaiiii/gg-ai';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-supervisor-modes-')));
const input = { workspace: 'identity:wt2:local:abc-123', agent: 'codex', title: 'Keep crypto work moving', objective: 'Finish the existing authorized task.', instructions: 'Preserve the existing scope and budget.' };
const prompts = [];
const orca = { launchSupervisor: async (request) => { prompts.push(request.prompt); return { handle: 'terminal_123', surface: 'terminal', promptDelivered: true }; } };
const options = { root, orca, intervalMs: 0, allowDispatch: () => true };
let manager = createSupervisors(options);
try {
  await manager.ready;
  const tool = manager.tools.find((t) => t.name === 'create_supervisor');
  assert.deepEqual(resolveToolSchema(tool).properties.mode.enum, ['basic', 'advanced']);
  const basic = JSON.parse(await tool.execute({ ...input, mode: null }));
  assert.equal(basic.mode, 'basic', 'an omitted/null mode grants only basic supervision');
  const skill = await fs.readFile(new URL('../bundled-plugins/orca/skills/roamie-supervisor/SKILL.md', import.meta.url), 'utf8');
  assert.ok(prompts[0].includes(skill), 'the actual maintained skill is delivered in the launch, not just a possibly inaccessible path');
  assert.match(prompts[0], /Mode: basic\./);
  assert.equal((await manager.launch(input)).id, basic.id);
  assert.equal(prompts.length, 1, 'default/null basic calls reuse the same launch');
  assert.throws(() => manager.launch({ ...input, mode: 'unbounded' }), /basic or advanced/);
  assert.equal(prompts.length, 1, 'invalid modes cannot launch');
  const advanced = await manager.launch({ ...input, mode: 'advanced' });
  assert.equal(advanced.mode, 'advanced');
  assert.notEqual(advanced.id, basic.id, 'mode is part of the saved assignment identity');
  assert.match(prompts[1], /Mode: advanced\./);
  await manager.close();
  manager = createSupervisors(options); await manager.ready;
  assert.equal(manager.get(basic.id).mode, 'basic');
  assert.equal(manager.get(advanced.id).mode, 'advanced');
  await manager.close();

  // Old dispatch keys had no mode. Preserve their advanced authority and avoid duplicating a live launch.
  const saved = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
  saved.supervisors = saved.supervisors.filter((r) => r.id === advanced.id);
  delete saved.supervisors[0].mode;
  saved.supervisors[0].dispatchKey = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  await fs.writeFile(path.join(root, 'state.json'), JSON.stringify(saved));
  manager = createSupervisors(options); await manager.ready;
  assert.equal(manager.get(advanced.id).mode, 'advanced', 'existing supervisors are not silently downgraded');
  assert.equal((await manager.launch({ ...input, mode: 'advanced' })).id, advanced.id);
  assert.equal(prompts.length, 2, 'an old active launch is not repeated under the new mode key');
  console.log('Supervisor mode delivery and recovery tests: passed');
} finally {
  await manager.close(); await fs.rm(root, { recursive: true, force: true });
}
