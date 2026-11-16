// Agent Plugins 1.0.0 format, with the normative text's non-fatal exceptions and failure boundaries.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parseDocument } from 'yaml';
import { checkRead, insidePluginRoot, resolvePluginPath, checkPluginCommand, checkPluginEndpoint, checkPluginHeaders, pluginEnvironment } from './safety.mjs';

export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
export const PLUGIN_LIMITS = Object.freeze({ documentBytes: 2 << 20, files: 10000, bytes: 128 << 20, depth: 32 });
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const knownManifest = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
let validators;
async function validation() {
  return validators ??= (async () => {
    const load = async (file) => {
      const p = fileURLToPath(new URL(`./plugin-schemas/${file}.schema.json`, import.meta.url));
      const v = checkRead(p, os.homedir()); if (v.level === 'block') throw new Error(v.reason);
      return JSON.parse(await fs.readFile(p, 'utf8'));
    };
    const [manifest, mcp] = await Promise.all([load('plugin'), load('mcp')]);
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    ajv.addSchema(mcp);
    return { manifest: ajv.compile(manifest), server: ajv.getSchema(`${MCP_SCHEMA}#/$defs/server`),
      envelope: ajv.compile({ type: 'object', properties: { $schema: { const: MCP_SCHEMA }, mcpServers: { type: 'object' } }, required: ['$schema', 'mcpServers'], additionalProperties: false }) };
  })();
}
const reason = (validator) => (validator.errors ?? []).slice(0, 6).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');

async function readFile(root, relative, limit = PLUGIN_LIMITS.documentBytes) {
  const file = await resolvePluginPath(root, relative, { kind: 'file' });
  const allowed = checkRead(file, os.homedir()); if (allowed.level === 'block') throw new Error(allowed.reason);
  if ((await fs.stat(file)).size > limit) throw new Error(`Plugin document exceeds the client ${limit}-byte resource limit.`);
  return { file, text: await fs.readFile(file, 'utf8') };
}
async function present(root, relative) {
  // lstat sees dangling links too. A present but broken location is invalid, not silently absent.
  try { await fs.lstat(path.join(root, relative)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

export function parsePluginSkill(text, folder) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md requires YAML frontmatter followed by Markdown.');
  const doc = parseDocument(match[1], { uniqueKeys: true, version: '1.2' });
  if (doc.errors.length || doc.warnings.length) throw new Error('Invalid or unsupported skill YAML.');
  const meta = doc.toJS({ maxAliasCount: 0 });
  if (!object(meta)) throw new Error('Skill frontmatter must be a mapping.');
  // Interpret the normative Unicode wording literally: lowercase letters/numbers, NFC, and hyphens.
  const name = meta.name;
  if (typeof name !== 'string' || [...name].length < 1 || [...name].length > 64 || name !== name.normalize('NFC') || name !== name.toLowerCase()
    || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(name) || name !== folder) throw new Error('Skill name must match its folder and contain 1–64 lowercase alphanumeric characters or single hyphens.');
  if (typeof meta.description !== 'string' || !meta.description.trim() || [...meta.description].length > 1024) throw new Error('Skill description must contain 1–1024 characters.');
  for (const key of ['license', 'allowed-tools']) if (Object.hasOwn(meta, key) && typeof meta[key] !== 'string') throw new Error(`Invalid skill ${key}.`);
  if (Object.hasOwn(meta, 'compatibility') && (typeof meta.compatibility !== 'string' || !meta.compatibility.length || [...meta.compatibility].length > 500)) throw new Error('Invalid skill compatibility.');
  if (Object.hasOwn(meta, 'metadata') && (!object(meta.metadata) || Object.values(meta.metadata).some((v) => typeof v !== 'string'))) throw new Error('Skill metadata values must be strings.');
  return { ...meta, body: match[2], text };
}

/** Returns diagnostics alongside usable siblings. Fatal manifest errors return valid:false and no components. */
export async function inspectPlugin(directory) {
  const diagnostics = [], skills = [], servers = [];
  const note = (component, message, entry = null) => diagnostics.push({ component, ...(entry ? { entry } : {}), message });
  let root, manifest;
  const v = await validation();
  try {
    const policy = checkRead(directory, os.homedir()); if (policy.level === 'block') throw new Error(policy.reason);
    root = await fs.realpath(directory);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Plugin root must be a directory.');
    const raw = JSON.parse((await readFile(root, 'plugin.json')).text);
    if (!object(raw)) throw new Error('plugin.json must be an object.');
    manifest = Object.fromEntries(Object.entries(raw).filter(([key]) => knownManifest.has(key)));
    for (const key of Object.keys(raw)) if (!knownManifest.has(key)) note('manifest', `Unknown field ${key} ignored.`);
    if ('extensions' in manifest) {
      if (!object(manifest.extensions)) note('manifest', 'Non-object extensions ignored.');
      // No client extensions are implemented. Their values are not validated or assigned semantics.
      delete manifest.extensions;
    }
    if (!v.manifest(manifest)) throw new Error(reason(v.manifest));
  } catch (e) {
    return { valid: false, root: root ?? path.resolve(directory), manifest: null, skills: [], servers: [], diagnostics: [{ component: 'manifest', message: e.message }] };
  }
  if (await present(root, 'skills').catch((e) => { note('skills', e.message); return false; })) {
    try {
      const location = await resolvePluginPath(root, 'skills', { kind: 'directory' });
      for (const name of await fs.readdir(location)) {
        const relative = `skills/${name}`;
        try {
          const candidate = await resolvePluginPath(root, relative);
          if (!(await fs.stat(candidate)).isDirectory()) continue;
          if (!await present(candidate, 'SKILL.md')) continue;
          const loaded = await readFile(root, `${relative}/SKILL.md`);
          const skill = parsePluginSkill(loaded.text, name);
          skills.push({ ...skill, relative: `${relative}/SKILL.md` });
        } catch (e) { note('skills', e.message, name); }
      }
    } catch (e) { note('skills', e.message); }
  }
  if (await present(root, 'mcp.json').catch((e) => { note('mcp', e.message); return false; })) {
    try {
      const config = JSON.parse((await readFile(root, 'mcp.json')).text);
      if (!v.envelope(config)) throw new Error(reason(v.envelope));
      for (const [name, server] of Object.entries(config.mcpServers)) {
        try {
          if (!v.server(server)) throw new Error(reason(v.server));
          if (server.type === 'stdio') {
            checkPluginCommand(server.command);
            if (server.command.startsWith('./')) await resolvePluginPath(root, server.command, { kind: 'file' });
            // Checks reserved environment names with this host's environment-name semantics.
            pluginEnvironment(server.env, root, root);
            if (server.cwd?.startsWith('./')) await resolvePluginPath(root, server.cwd, { missing: true, kind: 'directory' });
            if (server.cwd?.startsWith('${PLUGIN_ROOT}')) {
              const rel = server.cwd.slice('${PLUGIN_ROOT}'.length).replace(/^\//, '') || '.';
              await resolvePluginPath(root, rel, { missing: true, kind: 'directory' });
            }
            if (server.cwd?.startsWith('${PLUGIN_DATA}')) {
              const rel = server.cwd.slice('${PLUGIN_DATA}'.length).replace(/^\//, '') || '.';
              const virtualData = path.join(root, '__plugin_data__');
              if (path.isAbsolute(rel) || /^[a-z]:/i.test(rel) || !insidePluginRoot(virtualData, path.resolve(virtualData, rel))) throw new Error('MCP cwd escapes plugin data.');
            }
          } else { checkPluginEndpoint(server.url); checkPluginHeaders(server.headers); }
          servers.push({ name, config: server, supported: server.type !== 'sse' });
          if (server.type === 'sse') note('mcp', 'Legacy SSE is not supported by this client; server skipped.', name);
        } catch (e) { note('mcp', e.message, name); }
      }
    } catch (e) { note('mcp', e.message); }
  }
  return { valid: true, root, manifest, skills, servers, diagnostics };
}

export const readPluginFile = readFile;
