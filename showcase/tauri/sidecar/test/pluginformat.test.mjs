import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectPlugin, parsePluginSkill, PLUGIN_SCHEMA, MCP_SCHEMA, readPluginFile } from '../plugin-format.mjs';
import { resolvePluginPath, checkPluginEndpoint, checkPluginHeaders, checkPluginCommand, expandPluginString, pluginEnvironment, pluginWorkingDirectory } from '../safety.mjs';
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-plugin-format-')));
const root = path.join(temp, 'package'), outside = path.join(temp, 'outside'), data = path.join(temp, 'data');
const write = async (relative, value) => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const base = { $schema: PLUGIN_SCHEMA, name: 'acme.tools' };
const skill = (name = 'summarize', extra = '') => `---\nname: ${name}\ndescription: Summarize the current experiment.\n${extra}---\nRead notes/reference.txt only when needed.\n`;
try {
  await fs.mkdir(root); await fs.mkdir(outside); await fs.mkdir(data);
  await write('plugin.json', base);
  let result = await inspectPlugin(root);
  assert.equal(result.valid, true); assert.equal(result.diagnostics.length, 0, 'missing optional components are valid');
  await write('plugin.json', { ...base, version: 'unusual version', homepage: 'not a URL', repository: '', license: 'anything', author: { email: 'not-an-email' }, extensions: { 'other.client': null }, unknown: { mcpServers: 'never load me' } });
  result = await inspectPlugin(root); assert.equal(result.valid, true); assert.equal(result.servers.length, 0); assert.equal(result.diagnostics.length, 1);
  await write('plugin.json', { ...base, extensions: 5 }); result = await inspectPlugin(root); assert.equal(result.valid, true); assert.match(result.diagnostics[0].message, /Non-object/);
  for (const change of [{ name: 'Bad' }, { name: '-a' }, { name: 'a--b' }, { name: 'a..b' }, { name: '' }, { name: 'a'.repeat(65) }, { version: 7 }, { description: null }, { author: { unknown: 'x' } }, { keywords: [null] }, { $schema: 'https://example.com/fetch-this' }]) {
    await write('plugin.json', { ...base, ...change }); result = await inspectPlugin(root); assert.equal(result.valid, false, JSON.stringify(change)); assert.equal(result.skills.length + result.servers.length, 0);
  }
  for (const name of ['a', 'acme.tools', 'lint3r', 'a-b']) { await write('plugin.json', { ...base, name }); assert.equal((await inspectPlugin(root)).valid, true); }
  await write('plugin.json', base);
  await write('skills/summarize/SKILL.md', skill());
  await write('skills/summarize/notes/reference.txt', 'A supporting file outside conventional resource folders.');
  await write('skills/bad/SKILL.md', skill('bad', 'name: duplicate\n'));
  await write('skills/deeper/wrapped/SKILL.md', skill('wrapped'));
  await write('bin/server.js', '// Fixture only; loader does not execute this.');
  await write('mcp.json', { $schema: MCP_SCHEMA, mcpServers: {
    local: { type: 'stdio', command: './bin/server.js', args: ['../opaque', '${HOME}', 'a; b', null].filter((v) => v !== null), env: { CONFIG: '${PLUGIN_ROOT}/config' }, cwd: '${PLUGIN_DATA}/cache/../cache' },
    remote: { type: 'streamable-http', url: 'http://localhost:8765/mcp', headers: { 'X-Literal': '${PLUGIN_ROOT}' } },
    malformed: { type: 'stdio', command: 'node', url: 'http://localhost/mcp' },
    legacy: { type: 'sse', url: 'https://example.com/mcp' },
  } });
  result = await inspectPlugin(root);
  assert.equal(result.valid, true); assert.deepEqual(result.skills.map((s) => s.name), ['summarize']);
  assert.deepEqual(result.servers.map((s) => s.name), ['local', 'remote', 'legacy']);
  assert.equal(result.servers.at(-1).supported, false);
  assert.ok(result.diagnostics.some((d) => d.entry === 'bad')); assert.ok(result.diagnostics.some((d) => d.entry === 'malformed'));
  assert.equal((await readPluginFile(root, 'skills/summarize/notes/reference.txt')).text.startsWith('A supporting'), true);
  for (const bad of ['not JSON', { $schema: PLUGIN_SCHEMA, mcpServers: {} }, { $schema: MCP_SCHEMA, mcpServers: {}, unknown: true }]) {
    await write('mcp.json', bad); result = await inspectPlugin(root); assert.equal(result.valid, true); assert.equal(result.skills.length, 1); assert.equal(result.servers.length, 0);
  }
  await write('mcp.json', { $schema: MCP_SCHEMA, mcpServers: {} }); assert.equal((await inspectPlugin(root)).servers.length, 0);
  for (const extra of ['description: 1\n', 'metadata: {x: 1}\n', 'compatibility: null\n', 'license: null\n', 'allowed-tools: []\n']) assert.throws(() => parsePluginSkill(skill('summarize', extra), 'summarize'));
  assert.throws(() => parsePluginSkill(skill('other'), 'summarize'));
  assert.throws(() => parsePluginSkill('---\nname: summarize\ndescription: &a foo\nmetadata: {x: *a}\n---\ntext', 'summarize'));
  assert.equal(parsePluginSkill(skill('δοκιμή'), 'δοκιμή').name, 'δοκιμή', 'documented Unicode naming interpretation');
  assert.ok(parsePluginSkill(skill() + 'line\n'.repeat(600), 'summarize').body.length > 2000, 'recommended line counts are not validity limits');

  assert.equal(expandPluginString('${PLUGIN_ROOT}|${PLUGIN_DATA}|${HOME}', '/x/${PLUGIN_DATA}', '/data'), '/x/${PLUGIN_DATA}|/data|${HOME}', 'single non-recursive expansion');
  const env = pluginEnvironment({ path: 'new', TEST: '${PLUGIN_ROOT}' }, '/root', '/data', { PATH: 'old', Plugin_Root: 'wrong' }, 'win32');
  assert.equal(env.path, 'new'); assert.equal(env.PATH, undefined); assert.equal(env.Plugin_Root, undefined); assert.equal(env.PLUGIN_ROOT, '/root'); assert.equal(env.TEST, '/root');
  assert.throws(() => pluginEnvironment({ plugin_data: 'x' }, '/root', '/data', {}, 'win32'));
  assert.equal(pluginEnvironment({ plugin_data: 'x' }, '/root', '/data', {}, 'linux').plugin_data, 'x');
  assert.equal(await pluginWorkingDirectory({}, root, data), root);
  assert.equal(await pluginWorkingDirectory({ cwd: '${PLUGIN_DATA}/cache/../pending' }, root, data), path.join(data, 'pending'));
  for (const cwd of ['../outside', 'data', '${HOME}', '${PLUGIN_DATA}/../outside', '${PLUGIN_ROOT}/../outside']) await assert.rejects(pluginWorkingDirectory({ cwd }, root, data));
  for (const command of ['../node', '/bin/node', 'C:\\node.exe', 'node --help', '${PLUGIN_ROOT}/bin/node']) assert.throws(() => checkPluginCommand(command));
  assert.equal(checkPluginCommand('./bin/a path with spaces'), './bin/a path with spaces');
  for (const url of ['http://localhost/mcp', 'http://127.0.0.2/mcp', 'http://[::1]/mcp', 'https://private.internal/mcp']) assert.equal(checkPluginEndpoint(url).level, 'safe');
  for (const url of ['http://localhost.example/mcp', 'http://192.168.1.2/mcp', 'file:///mcp', 'https://user@example.com/mcp', 'https://example.com/#', 'https://@example.com/mcp']) assert.throws(() => checkPluginEndpoint(url));
  assert.throws(() => checkPluginHeaders({ Authorization: 'a', authorization: 'b' })); assert.throws(() => checkPluginHeaders({ 'X-Key': 'a\r\nb' }));
  assert.equal(checkPluginHeaders({ 'X-Key': '${HOME}' })['X-Key'], '${HOME}');
  for (const relative of ['../outside', 'C:\\Windows', '\\server\\share', '/outside']) await assert.rejects(resolvePluginPath(root, relative, { missing: true }));
  assert.equal(await resolvePluginPath(root, 'new/child', { missing: true }), path.join(root, 'new', 'child'));

  // Windows directory junctions need no developer-mode symlink privilege; other platforms use directory links.
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  await fs.symlink(outside, path.join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolvePluginPath(root, 'external/secret.txt'), /outside/);
  await assert.rejects(resolvePluginPath(root, 'external/missing/child', { missing: true }), /outside/);
  await assert.rejects(readPluginFile(root, 'external/secret.txt'), /outside/);
  await fs.symlink(outside, path.join(root, 'skills', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  result = await inspectPlugin(root); assert.equal(result.skills.length, 1); assert.ok(result.diagnostics.some((d) => d.entry === 'escape'));
  await fs.rm(path.join(root, 'skills'), { recursive: true, force: true });
  await fs.symlink(outside, path.join(root, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  await write('mcp.json', { $schema: MCP_SCHEMA, mcpServers: { valid: { type: 'stdio', command: 'node' } } });
  result = await inspectPlugin(root); assert.equal(result.valid, true); assert.equal(result.skills.length, 0); assert.equal(result.servers.length, 1, 'escaping fixed skill location does not disable MCP');
  console.log(`Plugin format and ${process.platform === 'win32' ? 'native Windows junction' : 'native symlink'} containment tests: passed`);
} finally { await fs.rm(temp, { recursive: true, force: true }); }
