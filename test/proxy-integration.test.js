import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { imagePlan, launch } from '../src/container.js';

function sendConversation(req, res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const text = 'Proxy integration works.';
  if (req.url === '/v1/chat/completions') {
    for (const delta of [{ role: 'assistant' }, { content: text }, {}]) {
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
    return;
  }
  const message = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: 'resp_test', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ];
  events.forEach(event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  res.end();
}

test('real Podman proxy: private socket, dummy-only sandbox, HTTP access, and Pi streamed conversation', { skip: process.env.PIS_INTEGRATION !== '1', timeout: 300_000 }, async t => {
  const base = fs.mkdtempSync('/tmp/pis-proxy-integration-');
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage'));
  const config = await store.register(root, 'proxy-integration');
  config.credentials.proxy.models = ['gpt-4o'];
  await store.save(config, store.load(config.id));
  const image = imagePlan(config).image;
  const oldKey = process.env.OPENAI_API_KEY;
  const key = 'sk-host-only-fake-openai-credential-for-integration';
  process.env.OPENAI_API_KEY = key;
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({ authorization: req.headers.authorization, url: req.url, body: Buffer.concat(chunks).toString() });
      if (req.url === '/v1/models') { res.end('{"object":"list","data":[{"id":"gpt-4o"}]}'); return; }
      sendConversation(req, res, JSON.parse(Buffer.concat(chunks)).model);
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    spawnSync('podman', ['rmi', image], { stdio: 'ignore' });
    fs.rmSync(base, { recursive: true, force: true });
  });
  const options = { cwd: root, stdio: ['ignore', 1, 2], proxyUpstream: `http://127.0.0.1:${upstream.address().port}` };
  const script = `
    const fs = require('fs');
    (async () => {
      const url = process.env.OPENAI_BASE_URL;
      const headers = { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY };
      const models = await fetch(url + '/models', { headers });
      const denied = await fetch(url + '/files', { headers });
      const unauthenticated = await fetch(url + '/models');
      fs.writeFileSync('proxy-report.json', JSON.stringify({
        key: process.env.OPENAI_API_KEY, uid: process.getuid(),
        modelsStatus: models.status, models: await models.json(),
        denied: denied.status, unauthenticated: unauthenticated.status,
        auth: fs.readFileSync(process.env.HOME + '/.pi/agent/auth.json', 'utf8'),
        config: fs.readFileSync(process.env.HOME + '/.pi/agent/models.json', 'utf8')
      }));
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  assert.equal(await launch(store, config, { ...options, mode: 'exec', args: ['node', '-e', script] }), 0);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'proxy-report.json')));
  assert.match(report.key, /^sk-pis-/);
  assert.notEqual(report.key, key);
  assert.ok(!JSON.stringify(report).includes(key));
  assert.equal(report.uid, process.getuid());
  assert.equal(report.modelsStatus, 200);
  assert.equal(report.models.data[0].id, 'gpt-4o');
  assert.equal(report.denied, 403);
  assert.equal(report.unauthenticated, 401);
  assert.equal(received.length, 1);
  assert.equal(received[0].authorization, `Bearer ${key}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.projectDir(config.id), 'state/.pi/agent/models.json'))), {});

  // Exercise Pi itself, including its models.json override, extension boundary, and streaming SDK.
  const extension = path.join(root, 'probe.ts');
  fs.writeFileSync(extension, `import fs from 'node:fs';\nexport default function(pi) { pi.on('session_start', async () => { fs.writeFileSync('extension-report.json', JSON.stringify({ key: process.env.OPENAI_API_KEY, uid: process.getuid() })); }); }\n`);
  assert.equal(await launch(store, config, { ...options, mode: 'pi', fresh: true, args: ['--offline', '--no-extensions', '-e', extension, '--no-session', '--model', 'openai/gpt-4o', '--thinking', 'off', '-p', 'Say hello.'] }), 0);
  const extensionReport = JSON.parse(fs.readFileSync(path.join(root, 'extension-report.json')));
  assert.match(extensionReport.key, /^sk-pis-/);
  assert.notEqual(extensionReport.key, key);
  assert.equal(extensionReport.uid, process.getuid());
  assert.ok(received.some(req => ['/v1/responses', '/v1/chat/completions'].includes(req.url)));
  for (const req of received) assert.equal(req.authorization, `Bearer ${key}`);
  // Every proxy capability is scoped to one launch and dies when that launch ends.
  assert.equal(await launch(store, config, { ...options, mode: 'exec', args: ['node', '-e', `require('fs').writeFileSync('second-token', process.env.OPENAI_API_KEY)`] }), 0);
  assert.notEqual(fs.readFileSync(path.join(root, 'second-token'), 'utf8'), report.key);
});
