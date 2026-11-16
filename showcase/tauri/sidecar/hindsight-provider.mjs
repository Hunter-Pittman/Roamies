// Personal trial bridge: Hindsight uses Roamies' ChatGPT credential resolver without owning its refresh token.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { AuthStorage, getAuthStorageKeys } from '@kenkaiiii/gg-core';
import { SAFE, checkMemoryEndpoint, checkUrl } from './safety.mjs';

const UPSTREAM = 'https://api.openai.com/v1/responses';
export function planRequest(input, model) {
  if (input.model !== model || input.stream === true || (input.tools?.length ?? 0) > 0 || !Array.isArray(input.input)) throw new Error('unsupported request');
  // Allow only text inference fields; no arbitrary URLs, tools, persisted responses, or upstream headers.
  const body = { model, input: input.input.map((m) => {
    if (!['system', 'developer', 'user', 'assistant'].includes(m.role)) throw new Error('unsupported input');
    if (typeof m.content !== 'string' && (!Array.isArray(m.content) || m.content.some((c) => !['input_text', 'output_text'].includes(c.type) || typeof c.text !== 'string'))) throw new Error('text only');
    return { role: m.role === 'system' ? 'developer' : m.role, content: m.content };
  }), store: false, stream: true };
  if (typeof input.instructions === 'string') body.instructions = input.instructions;
  if (input.text?.format) body.text = { format: input.text.format };
  body.reasoning = { effort: 'low' };
  return body;
}

async function completedResponse(response) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', completed = null;
  const items = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r/g, '');
      if (buffer.length > 8 * 1024 * 1024) throw new Error('oversized event');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data);
        if (event.type === 'response.output_item.done') items.push(event.item);
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error('upstream response failed');
        if (event.type === 'response.completed') {
          completed = event.response;
          if (!completed.output?.length && items.length) completed.output = items;
          return completed;
        }
      }
      if (done) break;
    }
    throw new Error('stream ended without completion');
  } finally { await reader.cancel().catch(() => {}); }
}

export async function startProviderBridge({ model, resolveCredentials, token = randomBytes(32).toString('hex'), port = 9078, fetcher = fetch } = {}) {
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return reply(401, { error: 'unauthorized' });
    if (req.method !== 'POST' || req.url !== '/v1/responses') return reply(404, { error: 'unsupported route' });
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { reply(413, { error: 'request too large' }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = planRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')), model); } catch { return reply(400, { error: 'unsupported request' }); }
      if (checkUrl(UPSTREAM).level !== SAFE) throw new Error('blocked upstream');
      const credentials = await resolveCredentials();
      if (!credentials.clientId || !credentials.accessToken || (credentials.baseUrl && new URL(credentials.baseUrl).origin !== 'https://api.openai.com')) throw new Error('incompatible credentials');
      const upstream = await fetcher(UPSTREAM, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${credentials.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]) });
      if (!upstream.ok) { await upstream.body?.cancel(); return reply(upstream.status, { error: 'Roamies provider rejected memory inference' }); }
      reply(200, await completedResponse(upstream));
    } catch { if (!res.destroyed) reply(502, { error: 'Roamies provider unavailable' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { token, port: server.address().port, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

export async function hindsightServiceReady(fetcher = fetch) {
  const origin = 'http://127.0.0.1:8888';
  if (checkMemoryEndpoint(origin).level !== SAFE) return false;
  try {
    const r = await fetcher(`${origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
    return r.ok && (await r.json()).status === 'healthy';
  } catch { return false; }
}

export async function runHindsightSetup() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const configFile = process.env.ROAMIES_DATA_DIR ? path.join(process.env.ROAMIES_DATA_DIR, 'sidekick.json') : path.join(os.homedir(), '.gg', 'sidekick.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  if (config.provider !== 'openai' || typeof config.model !== 'string') throw new Error('This bridge currently supports the existing Roamies ChatGPT provider only.');
  const auth = new AuthStorage();
  const resolveCredentials = () => auth.resolveCredentials('openai', { storageKeys: getAuthStorageKeys('openai', config.model) });
  const credentials = await resolveCredentials();
  if (!credentials.clientId) throw new Error('The selected Roamies credentials are not a ChatGPT sign-in.');
  if (await hindsightServiceReady()) {
    // Reuse a running trial without trying to seize its provider port or rotate its bridge key.
    const r = await fetch('http://127.0.0.1:9078/v1/responses', { redirect: 'error', signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (r?.status === 401) {
      console.log('Hindsight is already running. Enable Hindsight memory on the Roamies Memory page.');
      return;
    }
    throw new Error('A Hindsight service is already using port 8888. Stop it before setting up the Roamies bridge.');
  }
  const bridge = await startProviderBridge({ model: config.model, resolveCredentials });
  console.log(`Roamies provider bridge listening on 127.0.0.1:${bridge.port}; model ${config.model}.`);
  const stop = () => bridge.close().finally(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const env = { ...process.env, HINDSIGHT_API_LLM_PROVIDER: 'openai-responses', HINDSIGHT_API_LLM_MODEL: config.model,
    HINDSIGHT_API_LLM_API_KEY: bridge.token, HINDSIGHT_API_LLM_BASE_URL: `http://host.docker.internal:${bridge.port}/v1` };
  await new Promise((resolve, reject) => execFile('docker', ['compose', '-p', 'roamies-hindsight-trial', '-f', path.join(dir, 'hindsight.compose.yml'), 'up', '-d'],
    { env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => { if (stdout.trim()) console.log(stdout.trim()); error ? reject(new Error('Hindsight container startup failed. Check Docker.')) : resolve(); })).catch(async (e) => { await bridge.close(); throw e; });
  console.log('Waiting for Hindsight to finish starting...');
  const deadline = Date.now() + 180_000;
  while (!(await hindsightServiceReady())) {
    if (Date.now() >= deadline) { await bridge.close(); throw new Error('Hindsight did not become ready. Check Docker startup logs and retry setup.'); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('Hindsight is ready. Enable Hindsight memory on the Roamies Memory page.');
  console.log('Keep this terminal open. Press Ctrl+C to stop the provider bridge; stored memories are kept.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runHindsightSetup().catch((e) => { console.error(e.code === 'EADDRINUSE' ? 'Provider port 9078 is already in use. Stop the existing bridge before retrying.' : 'Provider bridge failed; check Roamies ChatGPT sign-in and Docker availability.'); process.exitCode = 1; });
