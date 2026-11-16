import assert from 'node:assert/strict';
import { startProviderBridge, planRequest } from '../hindsight-provider.mjs';

const request = { model: 'test-model', input: [{ role: 'system', content: 'Extract facts.' }, { role: 'user', content: 'User likes tea.' }],
  max_output_tokens: 65000, temperature: 0, store: true, text: { format: { type: 'json_object' } } };
const translated = planRequest(request, 'test-model');
assert.equal(translated.store, false); assert.equal(translated.stream, true);
assert.equal(translated.input[0].role, 'developer');
assert.ok(!('temperature' in translated)); assert.ok(!('max_output_tokens' in translated));
for (const patch of [{ model: 'other' }, { tools: [{ type: 'web_search' }] }, { stream: true },
  { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com' }] }] }]) {
  assert.throws(() => planRequest({ ...request, ...patch }, 'test-model'));
}
let calls = 0, resolved = 0, mode = 'success';
const bridge = await startProviderBridge({ model: 'test-model', port: 0, token: 'private-test-bridge-key',
  resolveCredentials: async () => { resolved++; return { clientId: 'app', accessToken: 'upstream-private-token', baseUrl: 'https://api.openai.com/v1' }; },
  fetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer upstream-private-token');
    assert.equal(options.redirect, 'error');
    if (mode === 'rejected') return new Response('secret upstream error body', { status: 429 });
    const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"facts":[]}' }] };
    const events = mode === 'incomplete' ? [{ type: 'response.incomplete' }] : [
      { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id: 'test-response', output: [], status: 'completed' } }];
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
try {
  const url = `http://127.0.0.1:${bridge.port}/v1/responses`;
  const send = (body = request, auth = 'Bearer private-test-bridge-key', endpoint = url) => fetch(endpoint, { method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send(request, '')).status, 401); assert.equal(resolved, 0);
  assert.equal((await send(request, 'Bearer wrong')).status, 401);
  assert.equal((await send(request, 'Bearer private-test-bridge-key', url + '/other')).status, 404);
  assert.equal((await send({ ...request, model: 'other' })).status, 400); assert.equal(calls, 0);
  const r = await send(); assert.equal(r.status, 200);
  assert.equal((await r.json()).output[0].content[0].text, '{"facts":[]}');
  mode = 'rejected'; const bad = await send(); assert.equal(bad.status, 429);
  assert.ok(!(await bad.text()).includes('secret upstream'));
  mode = 'incomplete'; assert.equal((await send()).status, 502);
  assert.equal(resolved, 3, 'resolve current credentials for each authorized inference');
} finally { await bridge.close(); }
console.log('hindsight provider tests: passed');
