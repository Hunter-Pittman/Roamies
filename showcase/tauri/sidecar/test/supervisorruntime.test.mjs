// Exercise the REAL agent tool executor, not just domain methods. No network or paid model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '@kenkaiiii/gg-agent';
import { createSupervisors } from '../supervisors.mjs';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roamies-supervisor-runtime-')));
let opened = 0, requests = 0;
const manager = createSupervisors({ root, intervalMs: 0, open: () => opened++, orca: {
  runs: async () => ({ runs: [{ id: 'run_123', title: 'Experiments' }], nextCursor: null }),
  status: async () => ({ summary: { working: 1 }, agents: [{ name: 'Ordinary agent chat', activity: 'working' }] }),
} });
await manager.ready;
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const agent = new Agent({ provider: 'anthropic', model: 'claude-sonnet-5-5', tools: manager.tools, maxTurns: 3, maxTurnExtensions: 0,
  resolveCredentials: async () => ({ apiKey: 'local-test-only' }),
  fetch: async (_url, options) => {
    const body = JSON.parse(options.body); requests++;
    let sse = event('message_start', { message: { id: `msg_${requests}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 0 } } });
    if (requests === 1) {
      for (const [index, name, input] of [[0, 'orca_tasks', { runId: null, cursor: null }], [1, 'supervisors', { id: null, open: true }], [2, 'orca_status', {}], [3, 'interruption_rules', { failures: null, questions: null, completions: 'off', snoozeMinutes: null }]]) {
        sse += event('content_block_start', { index, content_block: { type: 'tool_use', id: `call_${index}`, name, input: {} } });
        sse += event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
        sse += event('content_block_stop', { index });
      }
    } else {
      const results = body.messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((p) => p.type === 'tool_result') : []);
      assert.equal(results.length, 4);
      const texts = results.map((r) => typeof r.content === 'string' ? r.content : r.content.map((b) => b.text).join(''));
      assert.ok(texts.some((t) => JSON.parse(t).runs?.[0]?.id === 'run_123'));
      assert.ok(texts.some((t) => JSON.parse(t).activity?.summary?.working === 1), 'legacy Run listings cannot hide live activity');
      assert.ok(texts.some((t) => Array.isArray(JSON.parse(t).supervisors)));
      assert.ok(texts.some((t) => JSON.parse(t).summary?.working === 1));
      assert.ok(texts.some((t) => JSON.parse(t).completions === 'off'));
      sse += event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      sse += event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Your supervisors and Orca status are ready.' } });
      sse += event('content_block_stop', { index: 0 });
    }
    sse += event('message_delta', { delta: { stop_reason: requests === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } });
    sse += event('message_stop', {});
    return new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
  },
});
try {
  const events = [];
  for await (const e of agent.prompt('Show my supervisors and tell me what is running in Orca.')) events.push(e);
  assert.equal(requests, 2, 'the agent continues after both tool results');
  assert.equal(opened, 1);
  const results = events.filter((e) => e.type === 'tool_call_end');
  assert.equal(results.length, 4); assert.ok(results.every((e) => !e.isError && typeof e.result === 'string'));
  assert.ok(events.some((e) => e.type === 'agent_done'));
  console.log('Supervisor real agent runtime tests: passed');
} finally {
  await manager.close(); await fs.rm(root, { recursive: true, force: true });
}
