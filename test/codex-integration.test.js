import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { imagePlan, launch } from '../src/container.js';
import { saveCodexCredential, readCodexCredential, codexClaims } from '../src/codex-auth.js';
import { fakeCodexCredential, fakeCodexAccess } from './fixtures/codex.js';

function toolCall(res) {
  const item = { id: 'fc_search', type: 'function_call', call_id: 'call_search', name: 'web_search', arguments: JSON.stringify({ query: 'test sandbox search', provider: 'openai', workflow: 'none' }) };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id: 'codex_tool_response', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'codex_tool_response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function conversation(res, hostedSearch = false) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const message = { id: 'codex_msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Codex proxy works.', annotations: [] }] };
  const search = { id: 'search_test', type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: 'https://example.test/source', title: 'Test source' }] } };
  const events = [
    ...(hostedSearch ? [{ type: 'response.output_item.done', output_index: 1, item: search }] : []),
    { type: 'response.created', response: { id: 'codex_response', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Codex proxy works.' },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id: 'codex_response', status: 'completed', output: hostedSearch ? [search, message] : [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ];
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

test('real Codex Pi provider: host refresh, synthetic JWT, compressed SSE fallback, and no container egress', { skip: process.env.PIS_INTEGRATION !== '1', timeout: 300_000 }, async t => {
  const base = fs.mkdtempSync('/tmp/pis-codex-integration-');
  const root = path.join(base, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(base, 'storage'));
  const config = await store.register(root);
  const model = 'gpt-5.3-codex-spark';
  config.credentials = { env: [], proxy: { provider: 'openai-codex', models: [model] } };
  await store.save(config, store.load(config.id));
  const expired = fakeCodexCredential({ expires: Math.floor(Date.now() / 1000) - 10 });
  await saveCodexCredential(store, expired);
  const access = fakeCodexAccess({ signature: 'rotated-host-codex-access' });
  const refresh = 'rotated-host-codex-refresh';
  let refreshes = 0;
  const codexAuthFetch = async (url, options) => {
    refreshes++;
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    assert.equal(new URLSearchParams(options.body).get('refresh_token'), expired.refresh);
    return new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600 }));
  };
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined });
      if (req.url === '/backend-api/wham/usage') {
        res.end(JSON.stringify({ account_id: expired.accountId, email: 'private@example.test', access_token: access, rate_limit: { primary_window: { used_percent: 25, reset_after_seconds: 120, limit_window_seconds: 18000 }, secondary_window: null } }));
      } else {
        const request = received.at(-1).body;
        const hostedSearch = request.tools?.some(tool => tool.type === 'web_search');
        const hasToolResult = Array.isArray(request.input) && request.input.some(item => item.type === 'function_call_output');
        if (request.tools?.length && !hostedSearch && !hasToolResult) toolCall(res);
        else conversation(res, hostedSearch);
      }
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const image = imagePlan(config).image;
  t.after(async () => {
    const names = spawnSync('podman', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '';
    for (const name of names.trim().split('\n').filter(name => name.startsWith(`pis-${config.id}-`))) spawnSync('podman', ['rm', '-f', '--time', '1', name], { stdio: 'ignore', timeout: 15_000 });
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    spawnSync('podman', ['rmi', image], { stdio: 'ignore' });
    fs.rmSync(base, { recursive: true, force: true });
  });
  const agent = path.join(store.projectDir(config.id), 'state/.pi/agent');
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, 'web-search.json'), JSON.stringify({ openaiSearchModel: model, toolActivation: 'eager' }));
  const options = { cwd: root, stdio: ['ignore', 1, 2], network: 'none', proxyUpstream: `http://127.0.0.1:${upstream.address().port}`, codexAuthFetch };
  const script = `
    const fs = require('fs');
    (async () => {
      const response = await fetch(process.env.PIS_PROXY_BASE_URL + '/codex/responses', {
        method: 'POST', headers: { Authorization: 'Bearer ' + process.env.PIS_PROXY_TOKEN, 'content-type': 'application/json', 'chatgpt-account-id': 'spoofed-account' },
        body: JSON.stringify({ model: ${JSON.stringify(model)}, input: 'test', stream: true })
      });
      const auth = JSON.parse(fs.readFileSync(process.env.HOME + '/.pi/agent/auth.json', 'utf8'));
      const quota = await fetch('https://chatgpt.com/backend-api/wham/usage', { headers: { authorization: 'Bearer ' + auth['openai-codex'].access } });
      fs.writeFileSync('codex-report.json', JSON.stringify({ quota: await quota.json(), status: response.status, text: await response.text(), token: process.env.PIS_PROXY_TOKEN, apiKey: process.env.OPENAI_API_KEY, provider: process.env.PIS_PROXY_PROVIDER, hostCredentialVisible: fs.existsSync(${JSON.stringify(path.join(store.root, 'auth/openai-codex.json'))}), auth: fs.readFileSync(process.env.HOME + '/.pi/agent/auth.json', 'utf8') }));
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  assert.equal(await launch(store, config, { ...options, mode: 'exec', args: ['node', '-e', script] }), 0);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'codex-report.json')));
  assert.equal(report.status, 200);
  assert.equal(report.quota.rate_limit.primary_window.used_percent, 25);
  assert.ok(!JSON.stringify(report).includes('private@example.test'));
  assert.equal(codexClaims(report.token).accountId, 'pis-proxy-account');
  assert.equal(report.provider, 'openai-codex');
  assert.equal(report.apiKey, '');
  assert.equal(report.hostCredentialVisible, false);
  assert.equal(refreshes, 1);
  assert.equal(readCodexCredential(store).refresh, refresh);
  for (const secret of [expired.access, expired.refresh, access, refresh, expired.accountId]) assert.ok(!JSON.stringify(report).includes(secret));

  const extension = path.join(root, 'probe.ts');
  fs.writeFileSync(extension, `import fs from 'node:fs'; export default function(pi) { pi.on('session_start', async (_event, ctx) => {
    const packages = JSON.parse(fs.readFileSync('/opt/pis/extensions.json', 'utf8'));
    const tools = pi.getAllTools().map(tool => tool.name);
    fs.writeFileSync('codex-extension.json', JSON.stringify({ token: process.env.PIS_PROXY_TOKEN, uid: process.getuid(), tools, packages: packages.map(pkg => ({ source: pkg.source, version: JSON.parse(fs.readFileSync(pkg.path + '/package.json', 'utf8')).version })) }));
  }); }`);
  assert.equal(await launch(store, config, { ...options, mode: 'pi', fresh: true, args: ['--offline', '-e', extension, '--no-session', '--model', `openai-codex/${model}`, '--thinking', 'off', '-p', 'Say hello.'] }), 0);
  const extensionReport = JSON.parse(fs.readFileSync(path.join(root, 'codex-extension.json')));
  assert.notEqual(extensionReport.token, report.token);
  assert.equal(extensionReport.uid, process.getuid());
  for (const secret of [access, refresh, expired.accountId]) assert.ok(!JSON.stringify(extensionReport).includes(secret));
  assert.ok(extensionReport.tools.includes('web_search'));
  assert.ok(received.some(request => request.body?.tools?.some(tool => tool.type === 'web_search')));
  assert.ok(received.some(request => request.body?.input?.some?.(item => item.type === 'function_call_output' && JSON.stringify(item).includes('Codex proxy works'))));
  assert.deepEqual(extensionReport.packages.map(pkg => pkg.version), ['0.5.0', '0.40.0']);
  assert.equal(received.length, 5);
  for (const request of received) {
    assert.ok(['/backend-api/codex/responses', '/backend-api/wham/usage'].includes(request.url));
    assert.equal(request.headers.authorization, `Bearer ${access}`);
    assert.equal(request.headers['chatgpt-account-id'], expired.accountId);
    assert.equal(request.headers['content-encoding'], undefined);
    if (request.body) {
      assert.equal(request.body.model, model);
      assert.equal(request.body.stream, true);
    }
  }
  assert.equal(refreshes, 1);
});
