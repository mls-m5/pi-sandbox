import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PI_VERSION } from '../src/container.js';
import { startOpenAIProxy } from '../src/proxy.js';
import { Store } from '../src/store.js';
import { saveCodexCredential, useCodexAccount } from '../src/codex-auth.js';
import { createCodexAccountRouter } from '../src/codex-accounts.js';
import { fakeCodexAccess } from './fixtures/codex.js';

// Supply an already-installed package. This suite never installs dependencies,
// reads personal auth, calls real model services or needs Podman.
test('pinned real Pi CLI: Codex SSE across host accounts, full context, TypeBox tools and settlement hooks', {
  skip: !process.env.PIS_PI_PACKAGE, timeout: 60_000,
}, async t => {
  const pkg = path.resolve(process.env.PIS_PI_PACKAGE);
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  assert.equal(manifest.version, PI_VERSION, 'Compatibility probe must use the image-pinned Pi version.');
  const cli = path.join(pkg, typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.pi);
  const base = fs.mkdtempSync('/tmp/pis-pi-compat-');
  const cwd = path.join(base, 'project'), home = path.join(base, 'home'), agent = path.join(home, '.pi/agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agent, { recursive: true, mode: 0o700 });
  const access = fakeCodexAccess(), secondAccess = fakeCodexAccess({ accountId: 'second-fake-account', signature: 'second-fake-signature' });
  const store = new Store(path.join(base, 'host-auth'));
  await saveCodexCredential(store, { access, refresh: 'probe-default-refresh' });
  await saveCodexCredential(store, { access: secondAccess, refresh: 'probe-spare-refresh' }, undefined, 'spare');
  const router = createCodexAccountRouter(store, { fetchImpl: async () => assert.fail('Manual profile switching must not need an online quota request') });
  const received = [], proposals = [], sockets = new Set();
  const model = 'gpt-6-luna'; // Present in the pinned 1.5 catalogue; old spark was removed upstream.
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      received.push({ url: req.url, authorization: req.headers.authorization, account: req.headers['chatgpt-account-id'], body: JSON.parse(Buffer.concat(chunks)) });
      const index = received.length;
      if (index === 1) await useCodexAccount(store, 'spare');
      const item = index <= 2
        ? { id: `fc_${index}`, type: 'function_call', call_id: `call_${index}`, name: 'request_apt_packages', arguments: JSON.stringify({ packages: index === 1 ? [] : ['git'], reason: 'Compatibility probe only' }) }
        : { id: 'msg_done', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Compatibility probe OK.', annotations: [] }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'response.created', response: { id: `resp_${index}`, status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, content: [] } },
        item.type === 'function_call'
          ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }
          : { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Compatibility probe OK.' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `resp_${index}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      ];
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startOpenAIProxy({ provider: 'openai-codex', socketPath: path.join(base, 'api.sock'), apiKey: access, getCredentials: router.credentials, models: [model], upstream: `http://127.0.0.1:${upstream.address().port}` });
  const relay = net.createServer(client => {
    const host = net.createConnection(path.join(base, 'api.sock'));
    for (const socket of [client, host]) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }
    client.on('error', () => host.destroy()); host.on('error', () => client.destroy());
    client.pipe(host).pipe(client);
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  const proposalPath = path.join(base, 'proposal.sock');
  const proposalServer = net.createServer(socket => {
    let text = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      text += chunk;
      if (text.includes('\n')) { proposals.push(JSON.parse(text)); socket.end('{"ok":false}\n'); }
    });
  });
  await new Promise(resolve => proposalServer.listen(proposalPath, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => relay.close(resolve));
    await proxy.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await new Promise(resolve => proposalServer.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${relay.address().port}`;
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { 'openai-codex': { baseUrl: `${origin}/backend-api/codex/responses`, apiKey: proxy.token } } }));
  fs.writeFileSync(path.join(agent, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'api_key', key: proxy.token, access: proxy.token, accountId: 'pis-proxy-account' } }));
  fs.writeFileSync(path.join(agent, 'web-search.json'), JSON.stringify({ toolActivation: 'eager', workflow: 'none', openaiSearchProviders: ['openai-codex'], openaiSearchModel: model, openaiUseProviderBaseUrl: true }));
  const webAccess = process.env.PIS_PI_WEB_ACCESS ? path.resolve(process.env.PIS_PI_WEB_ACCESS) : undefined;
  const report = path.join(base, 'report.json'), eventsFile = path.join(base, 'events.jsonl');
  const probe = path.join(base, 'probe.mjs');
  fs.writeFileSync(probe, `import fs from 'node:fs'; export default function(pi) {
    pi.on('session_start', (_event, ctx) => fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
      model: ctx.model.id, commands: pi.getCommands().map(command => command.name), tools: pi.getAllTools().map(tool => ({ name: tool.name, parameters: tool.parameters }))
    })));
    for (const event of ['agent_settled', 'session_shutdown']) pi.on(event, () => { fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(event) + '\\n'); });
  }`);
  const guard = path.join(base, 'network-guard.mjs');
  fs.writeFileSync(guard, `import net from 'node:net';
    const allowedPort = ${relay.address().port}, allowedSocket = ${JSON.stringify(proposalPath)};
    const connect = net.Socket.prototype.connect;
    function check(args) {
      if (Array.isArray(args[0])) return check(args[0]);
      const first = args[0];
      const options = typeof first === 'object' ? first : typeof first === 'number' ? { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' } : { path: first };
      if (options?.path === allowedSocket) return;
      if (options && !options.path && options.host === '127.0.0.1' && Number(options.port) === allowedPort) return;
      throw new Error('Network blocked by offline compatibility probe');
    }
    net.Socket.prototype.connect = function(...args) { check(args); return connect.apply(this, args); };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.origin !== ${JSON.stringify(origin)}) throw new Error('External fetch blocked by offline compatibility probe');
      return originalFetch(input, options);
    };
  `);
  const source = name => fileURLToPath(new URL(`../src/runtime/${name}`, import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', guard, cli, '--offline', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-mcp', '-e', source('request-apt.mjs'), '-e', source('codex-auto.mjs'), ...(webAccess ? ['-e', webAccess] : []), '-e', probe, '--model', `openai-codex/${model}`, '--thinking', 'off', '-p', 'Run the local compatibility probe.'], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: home, TERM: 'dumb', NO_COLOR: '1', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: agent, PIS_APT_SOCKET: proposalPath, PIS_CODEX_AUTO_SOCKET: path.join(base, 'not-used-in-print.sock') },
    });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 45_000);
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Compatibility probe OK/);
  assert.doesNotMatch(result.output, /Failed to load extension|External fetch blocked|Network blocked/);
  assert.ok(!result.output.includes(access) && !result.output.includes(secondAccess));
  const loaded = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(loaded.model, model);
  assert.ok(loaded.commands.includes('codex-auto'));
  assert.ok(loaded.tools.some(tool => tool.name === 'request_host_git'));
  if (webAccess) assert.ok(loaded.tools.some(tool => tool.name === 'web_search'));
  assert.equal(loaded.tools.find(tool => tool.name === 'request_apt_packages').parameters.properties.packages.minItems, 1);
  assert.equal(received.length, 3);
  assert.ok(received.every(req => req.url === '/backend-api/codex/responses' && req.body.model === model));
  assert.deepEqual(received.map(req => req.authorization), [access, secondAccess, secondAccess].map(value => `Bearer ${value}`));
  assert.deepEqual(received.map(req => req.account), ['host-account-only', 'second-fake-account', 'second-fake-account']);
  assert.ok(received.slice(1).every(req => Array.isArray(req.body.input) && req.body.input.length > 1 && !req.body.previous_response_id && !req.body.conversation), 'Cross-account SSE continuation requires full context, not account-bound remote history.');
  assert.deepEqual(proposals, [{ type: 'apt-packages', packages: ['git'], reason: 'Compatibility probe only' }]); // Invalid [] never executed.
  assert.match(fs.readFileSync(eventsFile, 'utf8'), /agent_settled/);
});
