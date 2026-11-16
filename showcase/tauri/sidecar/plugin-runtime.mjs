import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsResultSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { z } from 'zod';
import { OwnedStdioTransport, approvedMcpFetch } from './plugin-transport.mjs';

export function normalizeMcpResult(result, redact = (v) => v) {
  if (Buffer.byteLength(JSON.stringify(result)) > 8 << 20) throw new Error('MCP result exceeds client size limit.');
  const content = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text') content.push({ type: 'text', text: redact(block.text) });
    else if (block.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(block.mimeType)) content.push({ type: 'image', data: block.data, mediaType: block.mimeType });
    else content.push({ type: 'text', text: redact(JSON.stringify(block)) });
  }
  if (result.structuredContent != null) content.push({ type: 'text', text: redact(JSON.stringify(result.structuredContent)) });
  if (result.isError) throw new Error(redact(content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || 'MCP server reported a tool failure.'));
  return { content: content.length ? content : [{ type: 'text', text: redact(JSON.stringify(result)) }] };
}

function compileSchema(schema, label) {
  if (JSON.stringify(schema).length > 128_000) throw new Error(`MCP ${label} schema exceeds client size limit.`);
  // MCP defaults to 2020-12. Do not infer dialects from substrings or silently ignore newer keywords.
  const dialect = schema.$schema?.replace(/#$/, '') ?? 'https://json-schema.org/draft/2020-12/schema';
  const modern = dialect === 'https://json-schema.org/draft/2020-12/schema';
  if (!modern && !['http://json-schema.org/draft-07/schema', 'https://json-schema.org/draft-07/schema'].includes(dialect)) throw new Error(`Unsupported MCP ${label} schema dialect: ${dialect}`);
  const ajv = new (modern ? Ajv2020 : Ajv)({ strict: false, validateFormats: false, allErrors: false, ownProperties: true });
  let valid;
  try { valid = ajv.compile({ ...schema, $schema: modern ? 'https://json-schema.org/draft/2020-12/schema' : 'http://json-schema.org/draft-07/schema#' }); }
  catch { throw new Error(`MCP tool declares an unsupported or invalid ${label} schema (remote references are not fetched).`); }
  return (value) => { if (!valid(value)) throw new Error(`MCP ${label} does not match its schema: ${ajv.errorsText(valid.errors)}`); };
}

export function createPluginRuntime({ timeout = 30_000, redact = (v) => v, token = async () => null, hostRequest = async () => { throw new Error('This client does not provide a plugin host bridge.'); } } = {}) {
  const connections = new Map();
  const generations = new Map();
  let closed = false, epoch = 0;
  async function connect(identity, server, descriptor, signal) {
    if (closed) throw new Error('Plugin runtime is closed.');
    const key = `${identity}:${server}`;
    if (connections.has(key)) { const entry = connections.get(key); if (entry.revoked) throw new Error('MCP connection is revoked; cleanup must finish before reconnecting.'); return entry.ready; }
    const generation = epoch, localGeneration = generations.get(identity) ?? 0;
    const client = new Client({ name: 'Roamies', version: '1.0.0' }, { capabilities: {} });
    client.setRequestHandler(z.object({ method: z.literal('io.roamies/host'), params: z.object({ service: z.string().max(80), operation: z.string().max(80), argumentsJson: z.string().max(100000) }).strict() }),
      (request, extra) => hostRequest(identity, server, request.params, extra.signal));
    const credential = descriptor.type === 'stdio' ? null : await token(identity, server, descriptor.origin);
    if (closed || signal?.aborted || generation !== epoch || localGeneration !== (generations.get(identity) ?? 0)) throw new Error('Plugin connection was revoked.');
    if (connections.has(key)) { const entry = connections.get(key); if (entry.revoked) throw new Error('MCP connection is revoked.'); return entry.ready; }
    const transport = descriptor.type === 'stdio' ? new OwnedStdioTransport(descriptor) : new StreamableHTTPClientTransport(new URL(descriptor.url), {
      fetch: approvedMcpFetch(descriptor.url, descriptor.headers, credential),
      reconnectionOptions: { maxRetries: 0 },
    });
    const entry = { client, transport, state: 'connecting' };
    client.onerror = () => {}; // errors are returned by the request, without leaking stderr or headers into logs
    client.onclose = () => { entry.state = 'disconnected'; };
    connections.set(key, entry);
    entry.ready = (async () => {
      try { await client.connect(transport, { timeout, signal }); if (closed || entry.revoked || connections.get(key) !== entry) throw new Error('Plugin connection was revoked.'); entry.state = 'ready'; return entry; }
      catch (e) {
        entry.state = 'failed'; await transport.close();
        if (transport.cleanupError) { entry.revoked = true; entry.state = 'cleanup_failed'; throw new Error(redact(`${e.message} ${transport.cleanupError.message}`)); }
        if (connections.get(key) === entry) connections.delete(key); throw new Error(redact(String(e.message)));
      }
    })();
    return entry.ready;
  }
  async function invoke(identity, server, descriptor, request, signal) {
    if (signal?.aborted) throw new Error('Plugin request cancelled.');
    const { client } = await connect(identity, server, descriptor, signal);
    if (signal?.aborted) throw new Error('Plugin request cancelled.');
    const options = { timeout: request.timeout ?? timeout, signal };
    const capabilities = client.getServerCapabilities() ?? {};
    const list = async (kind) => {
      const meta = { tools: ['tools', 'listTools'], resources: ['resources', 'listResources'], resourceTemplates: ['resources', 'listResourceTemplates'], prompts: ['prompts', 'listPrompts'] }[kind];
      if (!capabilities[meta[0]]) throw new Error(`MCP server does not advertise ${meta[0]}.`);
      const all = [], seen = new Set(); let cursor;
      for (let i = 0; i < 50; i++) {
        // SDK 1.32.2 listTools replaces a shared metadata cache on EACH page. Read protocol pages directly;
        // input/output schemas and execution mode are captured per invocation from our complete local catalog.
        const params = cursor ? { cursor } : {};
        const page = kind === 'tools' ? await client.request({ method: 'tools/list', params }, ListToolsResultSchema, options) : await client[meta[1]](params, options);
        all.push(...(page[kind] ?? []));
        if (all.length > 1000 || JSON.stringify(all).length > 2 << 20) throw new Error('MCP catalog exceeds client limits.');
        if (!page.nextCursor) return all;
        if (seen.has(page.nextCursor)) throw new Error('MCP server repeated a pagination cursor.');
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
      throw new Error('MCP pagination limit reached.');
    };
    try {
      if (request.method === 'discover') {
        const result = { capabilities, instructions: client.getInstructions() ?? null };
        for (const kind of ['tools', 'resources', 'resourceTemplates', 'prompts']) {
          if (capabilities[kind === 'resourceTemplates' ? 'resources' : kind]) result[kind] = await list(kind);
        }
        return normalizeMcpResult(result, redact);
      }
      if (request.method === 'host_operation') {
        const result = await client.request({ method: request.rpcMethod, params: { operation: request.name, argumentsJson: request.argumentsJson } }, z.object({ value: z.string().max(8 << 20) }), options);
        return JSON.parse(result.value);
      }
      if (request.method === 'call_tool') {
        const tool = (await list('tools')).find((t) => t.name === request.name);
        if (!tool) throw new Error('MCP tool is not currently advertised.');
        if (tool.execution?.taskSupport === 'required') throw new Error('This MCP tool requires task-based execution, which Roamies does not support. No tool was called.');
        const input = JSON.parse(request.argumentsJson ?? '{}'); compileSchema(tool.inputSchema, 'input')(input);
        const validateOutput = tool.outputSchema ? compileSchema(tool.outputSchema, 'output') : null;
        const result = await client.request({ method: 'tools/call', params: { name: request.name, arguments: input } }, CallToolResultSchema, options);
        if (!result.isError && validateOutput) {
          if (result.structuredContent === undefined) throw new Error('MCP tool declared an output schema but returned no structured content.');
          validateOutput(result.structuredContent);
        }
        return normalizeMcpResult(result, redact);
      }
      if (request.method === 'read_resource') {
        if (!capabilities.resources) throw new Error('MCP resources unavailable.');
        // URI is sent only to this approved server; the client never fetches it as an arbitrary URL.
        return normalizeMcpResult(await client.readResource({ uri: request.name }, options), redact);
      }
      if (request.method === 'get_prompt') {
        if (!(await list('prompts')).some((p) => p.name === request.name)) throw new Error('MCP prompt is not currently advertised.');
        const args = JSON.parse(request.argumentsJson ?? '{}');
        if (!args || Array.isArray(args) || typeof args !== 'object' || Object.values(args).some((v) => typeof v !== 'string')) throw new Error('Prompt arguments must be string values.');
        return normalizeMcpResult(await client.getPrompt({ name: request.name, arguments: args }, options), redact);
      }
      throw new Error('Unsupported plugin MCP operation.');
    } catch (e) {
      const error = new Error(redact(String(e.message)));
      if (request.method === 'host_operation' && e.data) {
        error.uncertain = e.data.uncertain === true;
        if (typeof e.data.operationId === 'string' && e.data.operationId.length <= 200) error.operationId = e.data.operationId;
      }
      throw error;
    }
  }
  async function revoke(identity) {
    if (identity == null) epoch++; else generations.set(identity, (generations.get(identity) ?? 0) + 1);
    const selected = [...connections].filter(([key]) => identity == null || key.startsWith(identity + ':'));
    for (const [, entry] of selected) { entry.revoked = true; entry.state = 'closing'; }
    const results = await Promise.allSettled(selected.map(async ([key, entry]) => { await entry.transport.close(); if (entry.transport.cleanupError) throw entry.transport.cleanupError; await entry.client.close(); if (connections.get(key) === entry) connections.delete(key); }));
    const failure = results.find((r) => r.status === 'rejected'); if (failure) throw failure.reason;
  }
  return { invoke, revoke, status: () => [...connections].map(([id, c]) => ({ id, state: c.state })), close: async () => { closed = true; await revoke(); } };
}
