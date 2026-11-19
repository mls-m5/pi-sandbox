import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { startAptRequestServer } from '../src/apt-requests.js';
import { launchArgs, restartOptions } from '../src/container.js';
import { CLAUDE_HOST_MCP_CONFIG, claudeCommand } from '../src/claude-code.js';
import { callTool, handle } from '../src/runtime/claude-host-mcp.mjs';

const server = fileURLToPath(new URL('../src/runtime/claude-host-mcp.mjs', import.meta.url));

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pis-mcp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(dir, 'store'));
  const config = { ...(await store.register(root)), agent: 'claude' };
  return { dir, store, config };
}

test('MCP protocol: initialize, ping, tool list only with a socket, unknown methods, silent notifications', async () => {
  const env = { PIS_APT_SOCKET: '/nowhere.sock' };
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, env);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 2, method: 'ping' }, env)).result, {});
  const list = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, env);
  assert.deepEqual(list.result.tools.map(tool => tool.name), ['request_apt_packages']);
  assert.equal(list.result.tools[0].action, undefined);
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, {})).result.tools, []);
  assert.equal((await handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, env)).error.code, -32601);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, env), undefined);
});

test('tool call sends only the typed proposal to the real host socket and stops Claude once accepted', async t => {
  const { store, config } = await fixture(t);
  const requests = await startAptRequestServer(config, store);
  t.after(() => requests.close());
  const env = { PIS_APT_SOCKET: path.join(requests.directory, 'request.sock') };
  let stops = 0;
  const stop = () => { stops++; };
  const bad = await callTool({ name: 'request_apt_packages', arguments: { packages: ['curl; rm -rf /'], reason: 'x' } }, env, stop);
  assert.equal(bad.isError, true);
  assert.equal(stops, 0);
  assert.equal(requests.proposal, undefined);
  assert.equal((await callTool({ name: 'request_apt_packages', arguments: { packages: ['curl'], reason: 'r', approved: true } }, env, stop)).isError, true);
  assert.equal((await callTool({ name: 'request_host_git', arguments: {} }, env, stop)).isError, true);
  assert.equal((await callTool({ name: 'request_apt_packages', arguments: ['curl'] }, env, stop)).isError, true);
  const ok = await callTool({ name: 'request_apt_packages', arguments: { packages: ['curl'], reason: 'task needs curl' } }, env, stop);
  assert.equal(ok.isError, false);
  assert.match(ok.content[0].text, /Nothing has been executed or approved yet/);
  assert.equal(stops, 1);
  assert.deepEqual(requests.proposal, { type: 'apt-packages', packages: ['curl'], reason: 'task needs curl' });
  assert.deepEqual(store.load(config.id).image.packages, ['build-essential', 'python3']);
  assert.equal((await callTool({ name: 'request_apt_packages', arguments: { packages: ['vim'], reason: 'second' } }, env, stop)).isError, true);
  assert.equal((await callTool({ name: 'request_apt_packages', arguments: { packages: ['vim'], reason: 'r' } }, { PIS_APT_SOCKET: '/nonexistent.sock' }, stop)).isError, true);
});

test('stdio server answers JSON-RPC and SIGTERMs its parent (Claude) after an accepted request', async t => {
  const { store, config } = await fixture(t);
  const requests = await startAptRequestServer(config, store);
  t.after(() => requests.close());
  // Stand-in for Claude Code: spawns the MCP server as its child and reports a received SIGTERM.
  const parent = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [process.argv[1]], { stdio: ['pipe', 'pipe', 'inherit'] });
    process.on('SIGTERM', () => { console.log('PARENT_SIGTERM'); process.exit(0); });
    process.stdin.pipe(child.stdin);
    child.stdout.on('data', chunk => process.stdout.write(chunk));
    child.on('exit', () => setTimeout(() => process.exit(2), 5000));
  `;
  const fake = spawn(process.execPath, ['-e', parent, server], {
    env: { ...process.env, PIS_APT_SOCKET: path.join(requests.directory, 'request.sock') },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => fake.kill('SIGKILL'));
  let output = '';
  fake.stdout.on('data', chunk => { output += chunk; });
  const done = new Promise(resolve => fake.on('exit', resolve));
  fake.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  fake.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'request_apt_packages', arguments: { packages: ['jq'], reason: 'parse json' } } })}\n`);
  assert.equal(await done, 0);
  assert.match(output, /"id":1/);
  assert.match(output, /Nothing has been executed or approved yet/);
  assert.match(output, /PARENT_SIGTERM/);
  assert.equal(requests.proposal.packages[0], 'jq');
});

test('Claude launch gets the proposal socket and MCP config, but still never Pi proxy, quota or web-Git sockets', async t => {
  const { store, config } = await fixture(t);
  const requests = await startAptRequestServer(config, store);
  t.after(() => requests.close());
  const args = launchArgs(store, config, ['claude'], { cwd: config.root, image: 'img', aptRequests: requests, tty: false, stdinIsTTY: true }).args;
  assert.ok(args.includes('PIS_APT_SOCKET=/pis/apt/request.sock'));
  assert.ok(args.includes(`${requests.directory}:/pis/apt:ro`));
  assert.throws(() => launchArgs(store, config, ['claude'], { cwd: config.root, image: 'img', aptRequests: { ...requests, gitOnly: true } }), /web Git-only/);
  const mcp = JSON.parse(CLAUDE_HOST_MCP_CONFIG).mcpServers['pis-host'];
  assert.deepEqual(mcp.args, ['/opt/pis/claude-host-mcp.mjs']);
  assert.deepEqual(Object.keys(mcp.env), ['PIS_APT_SOCKET']);
  assert.deepEqual(claudeCommand(['--continue']), ['claude', '--continue']);
});

test('restart after approval keeps the Claude agent selection and sends the notice as a continued prompt', () => {
  const next = restartOptions({ mode: 'pi', agent: 'claude', fresh: true, args: ['hello'] }, ['curl']);
  assert.equal(next.agent, 'claude');
  assert.equal(next.fresh, false);
  assert.deepEqual(next.args.slice(0, 1), ['--continue']);
  assert.match(next.args[1], /apt packages curl/);
  assert.deepEqual(claudeCommand(next.args).slice(0, 2), ['claude', '--continue']);
});
