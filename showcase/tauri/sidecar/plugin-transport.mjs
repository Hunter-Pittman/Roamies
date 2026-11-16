// MCP v1 transport ownership. No shell expansion and no ambient API/Orca credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { checkRead, checkPluginCommand, resolvePluginPath, checkPluginEndpoint, checkPluginHeaders, pluginEnvironment, pluginWorkingDirectory, expandPluginString } from './safety.mjs';

const inherited = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL'];
export const pluginBaseEnvironment = () => Object.fromEntries(inherited.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]]));
export async function launchDescriptor(config, root, data, { executables = {}, environment = {} } = {}) {
  if (config.type !== 'stdio') { const endpoint = checkPluginEndpoint(config.url); checkPluginHeaders(config.headers); return { ...config, url: endpoint.url, origin: endpoint.origin }; }
  checkPluginCommand(config.command);
  const env = pluginEnvironment(config.env, root, data, { ...pluginBaseEnvironment(), ...environment });
  let executable;
  if (!config.command.startsWith('./') && Object.hasOwn(executables, config.command)) executable = await fs.realpath(executables[config.command]);
  else if (config.command.startsWith('./')) executable = await resolvePluginPath(root, config.command, { kind: 'file' });
  else {
    const pathValue = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
    const extensions = process.platform === 'win32' ? (path.extname(config.command) ? [''] : ['.exe', '.com', '.cmd', '.bat']) : [''];
    for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
      if (!path.isAbsolute(dir)) continue; // never search a mutable current directory
      for (const ext of extensions) {
        try { const candidate = await fs.realpath(path.join(dir, config.command + ext)); const st = await fs.stat(candidate); if (st.isFile() && (process.platform === 'win32' || st.mode & 0o111)) { executable = candidate; break; } } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e; }
      }
      if (executable) break;
    }
  }
  if (!executable) throw new Error(`MCP executable not found: ${config.command}`);
  if (process.platform === 'win32' && !/\.(exe|com)$/i.test(executable)) throw new Error('Windows MCP script launchers (.cmd/.bat) are unsupported. Configure a native executable such as node with the script in args.');
  const read = checkRead(executable, os.homedir()); if (read.level === 'block') throw new Error(read.reason);
  const stat = await fs.stat(executable); if (stat.size > 256 << 20) throw new Error('MCP executable exceeds the client identity limit.');
  const executableDigest = createHash('sha256').update(await fs.readFile(executable)).digest('hex');
  return { type: 'stdio', executable, executableDigest, args: (config.args ?? []).map((v) => expandPluginString(v, root, data)),
    env, cwd: await pluginWorkingDirectory(config, root, data) };
}

export class OwnedStdioTransport {
  constructor(descriptor) { this.descriptor = descriptor; this.buffer = new ReadBuffer({ maxBufferSize: 8 << 20 }); this.closed = false; }
  async start() {
    if (this.child || this.closed) throw new Error('MCP transport already started or closed.');
    const d = this.descriptor;
    const child = this.child = spawn(d.executable, d.args, { cwd: d.cwd, env: d.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.alive = true;
    child.stdin.on('error', (e) => this.onerror?.(e));
    child.stdout.on('data', (chunk) => { try { this.buffer.append(chunk); for (;;) { const message = this.buffer.readMessage(); if (message == null) break; this.onmessage?.(message); } } catch (e) { this.onerror?.(e); void this.close().catch((error) => this.onerror?.(error)); } });
    // Drain without logging: server stderr may contain authentication tokens.
    child.stderr.on('data', () => {});
    child.on('error', (e) => this.onerror?.(e));
    child.on('close', () => { this.alive = false; this.onclose?.(); });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  send(message) {
    if (this.closed || !this.alive) return Promise.reject(new Error('MCP process is closed.'));
    return new Promise((resolve, reject) => this.child.stdin.write(serializeMessage(message), (e) => e ? reject(e) : resolve()));
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const child = this.child; if (!child || !this.alive || !Number.isSafeInteger(child.pid)) return;
      // Terminate the owned tree while the launcher is still alive; ending stdin first can orphan npx children.
      if (process.platform === 'win32') {
        await new Promise((resolve, reject) => execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, (e) => e && this.alive ? reject(new Error('Could not stop the owned MCP process tree.')) : resolve()));
        if (this.alive) await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('MCP process did not close after termination.')), 2000); child.once('close', () => { clearTimeout(t); resolve(); }); });
      }
      else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
        await new Promise((resolve) => { const t = setTimeout(resolve, 300); child.once('close', () => { clearTimeout(t); resolve(); }); });
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    })();
    // SDK initialization failure invokes close() without awaiting it. Keep that path non-rejecting;
    // the runtime checks cleanupError explicitly and retains ownership for a retry.
    try { await this.closing; this.cleanupError = null; }
    catch (e) { this.closing = null; this.cleanupError = e; this.onerror?.(e); }
  }
}

/** Applied to EVERY SDK request, including session DELETE and the optional SSE GET stream. */
export function approvedMcpFetch(endpoint, headers = {}, token = null, fetcher = fetch) {
  const approved = checkPluginEndpoint(endpoint); checkPluginHeaders(headers);
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    checkPluginEndpoint(url.href);
    if (url.origin !== approved.origin) throw new Error('MCP request changed its approved origin.');
    const all = new Headers(headers);
    const supplied = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [k, v] of new Headers(init.headers)) supplied.set(k, v);
    for (const [k, v] of supplied) all.set(k, v); // SDK-generated protocol headers win
    if (token) all.set('Authorization', `Bearer ${token}`);
    const response = await fetcher(input, { ...init, headers: all, redirect: 'manual' });
    if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw new Error(`MCP authentication required or denied (HTTP ${response.status}); configure a client bearer token if supported. OAuth onboarding is unavailable.`); }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('MCP redirects require a newly reviewed endpoint.'); }
    if (response.url && new URL(response.url).origin !== approved.origin) { await response.body?.cancel(); throw new Error('MCP response changed origin.'); }
    const size = Number(response.headers.get('content-length'));
    if (size > 8 << 20) { await response.body?.cancel(); throw new Error('MCP response exceeds client size limit.'); }
    if (!response.body) return response;
    // Bound chunks/events before the SDK parser buffers them. Streams may be long-lived.
    const reader = response.body.getReader(); let pending = 0, lineBytes = 0;
    const events = response.headers.get('content-type')?.includes('text/event-stream');
    const body = new ReadableStream({
      async pull(controller) { try { const { done, value } = await reader.read(); if (done) { controller.close(); return; } for (const byte of value) { pending++; if (pending > 8 << 20) throw new Error('MCP event exceeds client size limit.'); if (events && byte === 10) { if (lineBytes <= 1) pending = 0; lineBytes = 0; } else lineBytes++; } controller.enqueue(value); } catch (e) { await reader.cancel().catch(() => {}); controller.error(e); } },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
