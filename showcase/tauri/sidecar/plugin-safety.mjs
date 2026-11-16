// Typed plugin policy. Package containment is not a sandbox for an approved MCP subprocess.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
const fail = (message) => { throw new Error(message); };
const key = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
export const insidePluginRoot = (root, file) => key(file) === key(root) || key(file).startsWith(key(root.endsWith(path.sep) ? root : root + path.sep));

async function realNearest(file) {
  try { return await fs.realpath(file); }
  catch (e) {
    if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e;
    // A dangling link is not a missing ordinary descendant.
    const st = await fs.lstat(file).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (st?.isSymbolicLink()) fail('A plugin path is a dangling link.');
    const parent = path.dirname(file);
    if (parent === file) throw e;
    return path.join(await realNearest(parent), path.basename(file));
  }
}

/** All package/data reads and discovery go through this strict resolver, including missing cwd descendants. */
export async function resolvePluginPath(root, relative, { kind = null, missing = false } = {}) {
  if (typeof relative !== 'string' || !relative || /\0/.test(relative) || /^[a-z]:|^[/\\]/i.test(relative)
    || process.platform === 'win32' && relative.includes(':')) fail('Expected a relative plugin path without drive, UNC or alternate-stream syntax.');
  const realRoot = await fs.realpath(root);
  if (!(await fs.stat(realRoot)).isDirectory()) fail('The plugin root is not a directory.');
  const candidate = path.resolve(realRoot, relative);
  if (!insidePluginRoot(realRoot, candidate)) fail('Plugin path escaped its root.');
  const real = missing ? await realNearest(candidate) : await fs.realpath(candidate);
  if (!insidePluginRoot(realRoot, real)) fail('Plugin path resolves outside its root.');
  if (kind) {
    const st = await fs.stat(real).catch((e) => { if (missing && e.code === 'ENOENT') return null; throw e; });
    if (st && !(kind === 'file' ? st.isFile() : st.isDirectory())) fail(`Plugin path is not a ${kind}.`);
  }
  return real;
}

export function expandPluginString(value, root, data) {
  return value.replace(/\$\{PLUGIN_(ROOT|DATA)\}/g, (_all, name) => name === 'ROOT' ? root : data);
}

export function checkPluginCommand(command) {
  if (typeof command !== 'string' || !command || /[\0-\x1f\x7f]/.test(command)) fail('Invalid MCP executable token.');
  if (command.startsWith('./')) return command;
  if (/[\s/\\]/.test(command) || /^[a-z]:/i.test(command)) fail('MCP command must be one bare executable or a ./ package path.');
  return command;
}

export function pluginLoopback(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (net.isIP(h) === 4) return h.startsWith('127.');
  // WHATWG serializes IPv4-mapped IPv6 as hex.
  return /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h);
}

/** An approved MCP endpoint can be local/private; this never changes generic web_fetch policy. */
export function checkPluginEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { fail('MCP endpoint must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || String(value).includes('#')
    || /^[a-z]+:\/\/[^/?#]*@/i.test(value)) fail('MCP endpoint cannot contain user information, fragments or a non-HTTP protocol.');
  if (url.protocol !== 'https:' && !pluginLoopback(url.hostname)) fail('Non-loopback MCP endpoints require HTTPS.');
  return { level: 'safe', url: url.href, origin: url.origin };
}

export function checkPluginHeaders(headers = {}) {
  const seen = new Set();
  for (const [name, value] of Object.entries(headers)) {
    // Headers validates platform HTTP syntax without expanding any package values.
    try { new Headers([[name, value]]); } catch { fail('Invalid MCP HTTP header.'); }
    const folded = name.toLowerCase();
    if (seen.has(folded)) fail('Duplicate MCP header name with different casing.');
    seen.add(folded);
  }
  return headers;
}

export async function pluginWorkingDirectory(config, root, data) {
  if (config.cwd == null) return fs.realpath(root);
  const value = config.cwd;
  if (value.startsWith('./')) return resolvePluginPath(root, expandPluginString(value, root, data), { missing: true, kind: 'directory' });
  for (const [token, base] of [['${PLUGIN_ROOT}', root], ['${PLUGIN_DATA}', data]]) {
    if (value === token || value.startsWith(token + '/')) {
      const expanded = expandPluginString(value, root, data);
      const realBase = await fs.realpath(base);
      const relative = path.relative(realBase, path.resolve(expanded));
      return relative ? resolvePluginPath(realBase, relative, { missing: true, kind: 'directory' }) : realBase;
    }
  }
  fail('MCP cwd must be ./, PLUGIN_ROOT-rooted or PLUGIN_DATA-rooted.');
}

export function pluginEnvironment(configured, root, data, base = {}, platform = process.platform) {
  const env = { ...base };
  for (const [name, value] of Object.entries(configured ?? {})) {
    const same = (key) => platform === 'win32' ? key.toUpperCase() === name.toUpperCase() : key === name;
    if (['PLUGIN_ROOT', 'PLUGIN_DATA'].some(same)) fail('MCP env cannot declare PLUGIN_ROOT or PLUGIN_DATA.');
    if (platform === 'win32') for (const key of Object.keys(env)) if (same(key)) delete env[key];
    env[name] = expandPluginString(value, root, data);
  }
  for (const name of ['PLUGIN_ROOT', 'PLUGIN_DATA']) {
    if (platform === 'win32') for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key];
  }
  return { ...env, PLUGIN_ROOT: root, PLUGIN_DATA: data };
}

/** Only the plugin manager calls this for its client-owned registry, snapshots and data. */
export async function checkPluginStorage(root, relative, options = {}) {
  if (!/^(state\.json|state-[a-f0-9-]{36}\.tmp|owner\.lock|[a-z0-9-]+(?:[/\\].*)?)$/.test(relative)) fail('Invalid plugin storage path.');
  const resolved = await resolvePluginPath(root, relative, { missing: true, ...options });
  if (key(resolved) !== key(path.resolve(await fs.realpath(root), relative))) fail('Client-owned plugin storage cannot contain link aliases.');
  return resolved;
}

/** Host privileges come from app-owned bindings, never a package name, extension or tool annotation. */
export function checkPluginHostRequest(binding, service, operation, allowActions) {
  if (!binding?.hostServices?.[service]?.includes(operation)) fail('Plugin is not authorized for this host service.');
  if (binding.actionHostOperations?.[service]?.includes(operation) && !allowActions) fail('Supervisor dispatch requires Allow File Edits & Commands.');
}
