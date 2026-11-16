// Optional local retrieval trial: Hindsight ranks approved facts; Roamies supplies the original text.
// No transcripts, screenshots, credentials, observations or generated advice enter the live prompt.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SAFE, checkMemoryEndpoint } from './safety.mjs';
import { REDACTION_MARKER, environmentSecrets, redactText } from '@kenkaiiii/gg-ai';

export const documentId = (f) => `fact-${createHash('sha256').update(`${f.id}\n${f.text}`).digest('hex')}`;
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const secretish = /\b(?:\d[ -]?){12,19}\b|\b(?:password|passcode|passphrase|pin code|api key|secret key|access token|2fa code|one-time code)\b/i;
export function safeMemoryText(text, secrets = environmentSecrets(process.env)) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000 || secretish.test(text)) return null;
  const clean = redactText(text, { secrets });
  return clean.includes(REDACTION_MARKER) ? null : clean;
}

// Keep recent defaults, then semantic matches, then the existing lexical selection. IDs are rechecked every call.
export function selectTrialFacts(all, fallback, recalled, limit = 40) {
  if (!recalled.length) return fallback;
  const active = new Map(all.map((f) => [documentId(f), f]));
  const recent = all.slice().sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)).slice(0, 8);
  const chosen = new Map();
  for (const f of [...recent, ...recalled.map((id) => active.get(id)).filter(Boolean), ...fallback]) {
    if (chosen.size >= limit) break;
    chosen.set(f.id, f);
  }
  return [...chosen.values()];
}

export function createHindsight({ endpoint = process.env.ROAMIES_HINDSIGHT_URL, dir, fetcher = fetch, log = () => {},
  recallMs = 700, writeMs = 120_000, retryMs = 30_000 } = {}) {
  const enabled = !!endpoint && checkMemoryEndpoint(endpoint).level === SAFE;
  if (endpoint && !enabled) log('hindsight_disabled', { reason: 'invalid endpoint' });
  const origin = enabled ? new URL(endpoint).origin : '';
  const file = path.join(dir, `hindsight-${hash(origin)}.json`);
  let state, desired = new Map(), worker = null, retry = null, closed = false, unusable = false, revision = 0;
  const secrets = environmentSecrets(process.env);
  const ready = enabled ? (async () => {
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state.version !== 1 || !/^roamies-trial-[a-f0-9-]+$/.test(state.bank) || !state.documents || typeof state.documents !== 'object' || Array.isArray(state.documents)) throw new Error('invalid state');
    } catch (e) {
      // Fail closed on an unreadable manifest: do not lose the list of documents needing deletion.
      if (e.code !== 'ENOENT') throw e;
      state = { version: 1, bank: `roamies-trial-${randomUUID()}`, documents: {} };
    }
  })() : Promise.resolve();
  ready.catch(() => { unusable = true; log('hindsight_failed', { operation: 'state' }); });
  const persist = async () => {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(tmp, file);
  };
  async function request(method, suffix, body, timeout = writeMs) {
    const url = `${origin}/v1/default/banks/${encodeURIComponent(state.bank)}${suffix}`;
    if (checkMemoryEndpoint(origin).level !== SAFE) throw new Error('blocked endpoint');
    const r = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (method === 'DELETE' && r.status === 404) return {};
    if (!r.ok) throw new Error(`Hindsight HTTP ${r.status}`); // Never log response bodies or queries.
    return r.status === 204 ? {} : r.json();
  }
  async function reconcile() {
    await ready;
    let seen;
    do {
      seen = revision;
      for (const id of Object.keys(state.documents)) {
        if (desired.has(id)) continue;
        await request('DELETE', `/documents/${encodeURIComponent(id)}`);
        delete state.documents[id];
        await persist();
      }
      const missing = [...desired].filter(([id]) => state.documents[id] !== 'ready');
      for (let i = 0; i < missing.length && !closed; i += 10) {
        const batch = missing.slice(i, i + 10).filter(([id]) => desired.has(id));
        if (!batch.length) continue;
        // Journal before sending: a crash or ambiguous timeout must still leave a deletable source.
        for (const [id] of batch) state.documents[id] = 'pending';
        await persist();
        const result = await request('POST', '/memories', { async: false, items: batch.map(([id, f]) => ({ content: f.text, document_id: id,
          context: 'A lasting fact stated by the user, curated by Roamies. Do not infer additional preferences.',
          timestamp: Number.isFinite(f.createdAt) ? new Date(f.createdAt).toISOString() : 'unset' })) });
        if (result.success !== true) throw new Error('retain failed');
        for (const [id] of batch) state.documents[id] = 'ready';
        await persist();
      }
    } while (seen !== revision && !closed);
    log('hindsight_synced', { facts: desired.size });
  }
  function start() {
    if (!enabled || closed || worker) return worker;
    clearTimeout(retry); retry = null;
    worker = reconcile().catch(() => {
      log('hindsight_failed', { operation: 'sync' });
      if (!closed) { retry = setTimeout(start, retryMs); retry.unref?.(); }
    }).finally(() => { worker = null; });
    return worker;
  }
  return {
    enabled,
    sync(facts) {
      if (!enabled || closed || unusable) return;
      const next = new Map(facts.flatMap((f) => safeMemoryText(f.text, secrets) ? [[documentId(f), { ...f }]] : []));
      const changed = [...next.keys()].join() !== [...desired.keys()].join();
      desired = next;
      if (changed) revision++;
      if (changed || !state || Object.keys(state.documents).some((id) => !desired.has(id))) start();
    },
    async recall(query) {
      if (!enabled || closed) return [];
      const clean = safeMemoryText(query, secrets);
      if (!clean) return [];
      const t = Date.now();
      try {
        await ready;
        const r = await request('POST', '/memories/recall', { query: clean, types: ['world', 'experience'], budget: 'low', max_tokens: 1200 }, recallMs);
        if (!Array.isArray(r.results)) throw new Error('invalid recall');
        const ids = [...new Set(r.results.slice(0, 100).map((f) => f.document_id).filter((id) => desired.has(id)))];
        log('hindsight_recall', { ms: Date.now() - t, facts: ids.length });
        return ids;
      } catch { log('hindsight_failed', { operation: 'recall', ms: Date.now() - t }); return []; }
    },
    async flush() { await worker; },
    close() { closed = true; clearTimeout(retry); },
  };
}
