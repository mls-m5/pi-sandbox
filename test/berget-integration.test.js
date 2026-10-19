import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { launch, imagePlan } from '../src/container.js';
import { saveApiProfile } from '../src/api-auth.js';

const model = 'google/gemma-4-31B-it';
const key = 'integration-fake-berget-key-only';

function streamChatCompletion(res, modelId, { tool = false } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunks = tool ? [
    { id: 'chatcmpl-tool', object: 'chat.completion.chunk', created: 1, model: modelId, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_pis_test', type: 'function', function: { name: 'bash', arguments: '{"command":"printf tool-ok > berget-tool-result.txt"}' } }] }, finish_reason: null }] },
    { id: 'chatcmpl-tool', object: 'chat.completion.chunk', created: 1, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ] : [
    { id: 'chatcmpl-final', object: 'chat.completion.chunk', created: 1, model: modelId, choices: [{ index: 0, delta: { role: 'assistant', content: 'Tool round trip complete.' }, finish_reason: null }] },
    { id: 'chatcmpl-final', object: 'chat.completion.chunk', created: 1, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

test('real Pi Berget and custom profiles complete fake streamed tool round trips without container egress', { skip: process.env.PIS_INTEGRATION !== '1', timeout: 300_000 }, async t => {
  const base = fs.mkdtempSync('/tmp/pis-berget-integration-');
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage'));
  let config = await store.register(root, 'berget-integration');
  config.extensions = [];
  await store.save(config, store.load(config.id));
  const image = imagePlan(config).image;
  const oldBergetKey = process.env.BERGET_API_KEY;
  process.env.BERGET_API_KEY = key;
  const received = [];
  const upstream = http.createServer((req, res) => {
    const parts = [];
    req.on('data', part => parts.push(part));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString());
      received.push({ url: req.url, auth: req.headers.authorization, body });
      streamChatCompletion(res, body.model, { tool: !body.messages.some(message => message.role === 'tool') });
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    if (oldBergetKey === undefined) delete process.env.BERGET_API_KEY; else process.env.BERGET_API_KEY = oldBergetKey;
    spawnSync('podman', ['rmi', image], { stdio: 'ignore' });
    fs.rmSync(base, { recursive: true, force: true });
  });
  const options = { cwd: root, stdio: 'ignore', network: 'none', proxyUpstream: `http://127.0.0.1:${upstream.address().port}` };
  const runPi = async (selectedModel, requestPath) => {
    const start = received.length;
    const status = await launch(store, config, { ...options, mode: 'pi', fresh: true, args: ['--offline', '--no-extensions', '--no-session', '--model', selectedModel, '--thinking', 'off', '-p', 'Use the bash tool to create berget-tool-result.txt containing tool-ok.'] });
    assert.equal(status, 0);
    const exchange = received.slice(start);
    assert.ok(exchange.length >= 2, 'Pi should call the model before and after the tool result.');
    assert.ok(exchange.some(request => request.url === requestPath));
    assert.ok(exchange.some(request => request.body.messages.some(message => message.role === 'tool')));
    assert.ok(fs.readFileSync(path.join(root, 'berget-tool-result.txt'), 'utf8').includes('tool-ok'));
    assert.ok(exchange.every(request => request.auth === `Bearer ${key}`));
    assert.ok(exchange.every(request => !JSON.stringify(request.body).includes(key)));
  };

  config.credentials = { env: [], proxy: { provider: 'berget', keyEnv: 'BERGET_API_KEY', models: [model] } };
  await store.save(config, store.load(config.id));
  await runPi(`berget/${model}`, '/v1/chat/completions');

  await saveApiProfile(store, 'custom', 'https://api.example.com/tenant/v1', key, [{ id: 'vendor/tool-model', contextWindow: 32768, maxTokens: 4096 }]);
  config.credentials = { env: [], proxy: { provider: 'custom', profile: 'custom', models: ['vendor/tool-model'] } };
  await store.save(config, store.load(config.id));
  await runPi('custom/vendor/tool-model', '/tenant/v1/chat/completions');
});
