// Trusted installed-Pi compatibility probe. All responses are in-memory SSE;
// a preload rejects real socket access. No credentials or model are contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [pkg, overlay] = process.argv.slice(2);
let calls = 0, body;
globalThis.fetch = async (url, options) => {
  assert.equal(String(url), 'http://127.0.0.1:43127/v1/chat/completions'); calls++;
  assert.equal(calls, 1); body = JSON.parse(options.body);
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'local-probe', object: 'chat.completion.chunk', created: 0, model: 'qwen2.5-coder:7b', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return new Response(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-probe', type: 'function', function: { name: 'probe_tool', arguments: '{"value":1}' } }] }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};
const { streamSimple } = await import(pathToFileURL(path.join(pkg, 'dist/core/extensions/pi-ai-extension-view.js')));
const provider = JSON.parse(fs.readFileSync(overlay, 'utf8')).providers.ollama;
const model = { ...provider.models[0], api: provider.api, provider: 'ollama', baseUrl: provider.baseUrl, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const stream = streamSimple(model, { systemPrompt: 'Synthetic local probe.', messages: [{ role: 'user', content: 'Synthetic request, no model contacted.', timestamp: 0 }], tools: [{ name: 'probe_tool', description: 'Never executed by this probe.', parameters: { type: 'object', properties: { value: { type: 'number' } } } }] }, { apiKey: 'fake-local-probe-capability', maxTokens: 2048 });
const result = await stream.result();
assert.equal(calls, 1); assert.equal(body.model, model.id); assert.equal(body.max_tokens, 2048); assert.equal(body.max_completion_tokens, undefined); assert.equal(body.store, undefined); assert.ok(body.messages.every(message => message.role !== 'developer'));
assert.equal(result.stopReason, 'toolUse'); assert.ok(result.content.some(block => block.type === 'toolCall' && block.name === 'probe_tool' && block.arguments.value === 1));
console.log(JSON.stringify({ calls, maxTokensField: 'max_tokens', toolCallParsed: true }));
