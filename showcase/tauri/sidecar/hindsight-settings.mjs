// Persisted UI setting wins over the developer environment flag, including an explicit false.
import { createHindsight } from './hindsight.mjs';
import { SAFE, checkMemoryEndpoint } from './safety.mjs';

export const hindsightOn = (config, env = process.env) => typeof config.hindsight === 'boolean' ? config.hindsight : !!env.ROAMIES_HINDSIGHT_URL;
export function createHindsightSettings({ dir, endpoint = process.env.ROAMIES_HINDSIGHT_URL || 'http://127.0.0.1:8888',
  facts, log = () => {}, changed = () => {}, factory = createHindsight, fetcher = fetch } = {}) {
  let client = null, on = false, generation = 0, retired = Promise.resolve(), closed = false, checking = false;
  let status = { on: false, phase: 'off', ms: null };
  const update = (phase, extra = {}) => { status = { ...status, on, phase, ...extra }; changed(); };
  async function check() {
    const g = generation;
    if (!on || closed) return;
    if (checkMemoryEndpoint(endpoint).level !== SAFE) { update('invalid'); return; }
    checking = true; update('checking');
    try {
      const r = await fetcher(`${new URL(endpoint).origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(2000) });
      if (!r.ok || (await r.json()).status !== 'healthy') throw new Error('unavailable');
      if (g === generation && on && !closed) update('ready');
    } catch { if (g === generation && on && !closed) update('offline'); }
    finally { if (g === generation) checking = false; }
  }
  return {
    state: () => ({ ...status }), check,
    async setEnabled(value) {
      if (closed || on === !!value) return;
      on = !!value;
      const g = ++generation, old = client; client = null;
      if (old) { old.close(); retired = retired.then(() => old.flush()).catch(() => {}); }
      update(on ? 'checking' : 'off', { ms: null });
      if (!on) return;
      await retired; // Never run two manifest writers during rapid off/on toggles.
      if (g !== generation || !on || closed) return;
      client = factory({ dir, endpoint, log: (kind, data) => {
        log(kind, data);
        if (g !== generation || !on || closed) return;
        if (kind === 'hindsight_disabled') update('invalid');
        else if (kind === 'hindsight_failed') update('offline');
        else if (kind === 'hindsight_synced' && !checking) update('ready');
        else if (kind === 'hindsight_recall') update('ready', { ms: data.ms });
      } });
      if (!client.enabled) { update('invalid'); return; }
      client.sync(facts());
      await check();
    },
    sync(values) { if (on && !closed) client?.sync(values); },
    async recall(text) {
      const g = generation;
      const ids = on && !closed && client ? await client.recall(text) : [];
      return g === generation && on && !closed ? ids : [];
    },
    close() { closed = true; generation++; client?.close(); },
  };
}
