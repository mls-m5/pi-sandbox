// Candidate-only smoke test. Run in a read-only --network=none container with
// writable /tmp, no project/state/auth mounts, and no real proxy capability.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { zstdDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const check = (condition) => {
  if (!condition) throw new Error('Candidate compatibility check failed.');
};

export async function runUpdateProbe({
  root = '/opt/pis',
  cli = '/usr/local/bin/pis-pi-real',
  timeoutMs = 45_000,
} = {}) {
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'probe-policy.json'), 'utf8'));
  const extensions = JSON.parse(fs.readFileSync(path.join(root, 'extensions.json'), 'utf8'));
  check(
    /^\d+\.\d+\.\d+$/.test(policy.piVersion) &&
      Array.isArray(extensions) &&
      extensions.length <= 99 &&
      JSON.stringify(extensions.map((entry) => entry.source)) === JSON.stringify(policy.extensions),
  );
  const required = JSON.parse(process.env.PIS_PROBE_REQUIRED_MODELS || '[]');
  check(
    Array.isArray(required) &&
      required.length <= 1000 &&
      required.every(
        (item) =>
          typeof item.provider === 'string' && typeof item.id === 'string' && item.id.length <= 256,
      ),
  );
  const base = fs.mkdtempSync('/tmp/pis-update-probe-');
  const home = path.join(base, 'home'),
    agent = path.join(home, '.pi/agent'),
    cwd = path.join(base, 'project');
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(cwd);
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TERM: 'dumb',
    NO_COLOR: '1',
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
  };
  const version = spawnSync(process.execPath, [cli, '--version'], {
    env,
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
  });
  check(version.status === 0 && version.stdout.trim() === policy.piVersion);
  for (const entry of extensions) {
    const installed = JSON.parse(fs.readFileSync(path.join(entry.path, 'package.json'), 'utf8'));
    check(installed.name === entry.name && (!entry.version || installed.version === entry.version));
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'pis-update-fake' } })}.fake-signature`;
  let calls = 0,
    proposals = 0,
    proxy;
  const peers = new Set();
  const apiSocket = path.join(base, 'api.sock');
  const relay = net.createServer((client) => {
    const remote = net.createConnection(apiSocket);
    for (const socket of [client, remote]) {
      peers.add(socket);
      socket.once('close', () => peers.delete(socket));
    }
    client.on('error', () => remote.destroy());
    remote.on('error', () => client.destroy());
    client.once('close', () => remote.destroy());
    remote.once('close', () => client.destroy());
    client.pipe(remote).pipe(client);
  });
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        check(
          req.method === 'POST' &&
            req.url === '/backend-api/codex/responses' &&
            req.headers.authorization === `Bearer ${token}`,
        );
        const raw = Buffer.concat(chunks);
        const data = JSON.parse(
          req.headers['content-encoding'] === 'zstd'
            ? zstdDecompressSync(raw, { maxOutputLength: 4 * 1024 * 1024 }).toString()
            : raw.toString(),
        );
        check(data.model === 'gpt-6-luna' && data.stream === true);
        const index = ++calls;
        check(index <= 3);
        const item =
          index <= 2
            ? {
                id: `fc_${index}`,
                type: 'function_call',
                call_id: `call_${index}`,
                name: 'request_apt_packages',
                arguments: JSON.stringify({
                  packages: index === 1 ? [] : ['git'],
                  reason: 'Candidate probe only',
                }),
              }
            : {
                id: 'msg_done',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'pis update probe OK', annotations: [] }],
              };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [
          { type: 'response.created', response: { id: `resp_${index}`, status: 'in_progress' } },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item:
              item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, content: [] },
          },
          item.type === 'function_call'
            ? {
                type: 'response.function_call_arguments.delta',
                output_index: 0,
                delta: item.arguments,
              }
            : {
                type: 'response.output_text.delta',
                output_index: 0,
                content_index: 0,
                delta: 'pis update probe OK',
              },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: {
              id: `resp_${index}`,
              status: 'completed',
              output: [item],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        ])
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
  });
  upstream.on('upgrade', (_req, socket) =>
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'),
  );
  const proposalPath = path.join(base, 'proposal.sock');
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.once('close', () => peers.delete(socket));
    socket.on('error', () => {});
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) {
        socket.destroy();
        return;
      }
      if (data.includes('\n')) {
        try {
          const request = JSON.parse(data);
          check(request.packages?.length === 1 && request.packages[0] === 'git');
          proposals++;
        } catch {
          proposals = -100;
        }
        socket.end('{"ok":false}\n');
      }
    });
  });
  let child;
  try {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    await new Promise((resolve) => server.listen(proposalPath, resolve));
    const { startOpenAIProxy } = await import(
      pathToFileURL(path.join(root, 'probe-lib/proxy.js')).href
    );
    proxy = await startOpenAIProxy({
      provider: 'openai-codex',
      socketPath: apiSocket,
      apiKey: token,
      models: ['gpt-6-luna'],
      upstream: `http://127.0.0.1:${upstream.address().port}`,
    });
    await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${relay.address().port}`;
    fs.writeFileSync(
      path.join(agent, 'models.json'),
      JSON.stringify({
        providers: {
          'openai-codex': { baseUrl: `${origin}/backend-api/codex/responses`, apiKey: proxy.token },
        },
      }),
    );
    fs.writeFileSync(
      path.join(agent, 'auth.json'),
      JSON.stringify({
        'openai-codex': {
          type: 'api_key',
          key: proxy.token,
          access: proxy.token,
          accountId: 'pis-update-fake',
        },
      }),
    );
    fs.writeFileSync(
      path.join(agent, 'web-search.json'),
      JSON.stringify({
        toolActivation: 'eager',
        workflow: 'none',
        openaiSearchProviders: ['openai-codex'],
        openaiSearchModel: 'gpt-6-luna',
        openaiUseProviderBaseUrl: true,
      }),
    );
    const report = path.join(base, 'report.json'),
      settled = path.join(base, 'settled');
    const observer = path.join(base, 'observer.mjs');
    fs.writeFileSync(
      observer,
      `import fs from 'node:fs'; export default function(pi) {
      pi.on('session_start', (_event, ctx) => fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
        tools: pi.getAllTools().map(tool => tool.name), commands: pi.getCommands().map(cmd => cmd.name),
        missing: ${JSON.stringify(required)}.filter(item => !ctx.modelRegistry.find(item.provider, item.id))
      })));
      pi.on('agent_settled', () => fs.writeFileSync(${JSON.stringify(settled)}, 'ok'));
    }`,
    );
    const guard = path.join(base, 'guard.mjs');
    fs.writeFileSync(
      guard,
      `import net from 'node:net'; const connect=net.Socket.prototype.connect;
      function allowed(args) { if(Array.isArray(args[0])) return allowed(args[0]); const first=args[0]; const opts=typeof first==='object'?first:typeof first==='number'?{port:first,host:args[1]}:{path:first}; if(opts?.path===${JSON.stringify(proposalPath)})return; if(!opts?.path&&opts?.host==='127.0.0.1'&&Number(opts.port)===${relay.address().port})return; throw new Error('Probe network blocked'); }
      net.Socket.prototype.connect=function(...args){allowed(args);return connect.apply(this,args)};
      const fetch=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin!==${JSON.stringify(origin)})throw new Error('Probe fetch blocked');return fetch(input,options)};
    `,
    );
    const args = [
      '--import',
      guard,
      cli,
      '--offline',
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-mcp',
      ...extensions.flatMap((entry) => ['-e', entry.path]),
      '-e',
      path.join(root, 'request-apt.mjs'),
      '-e',
      path.join(root, 'codex-auto.mjs'),
      '-e',
      observer,
      '--model',
      'openai-codex/gpt-6-luna',
      '--thinking',
      'off',
      '-p',
      'Run the local candidate compatibility probe.',
    ];
    const result = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, args, {
        cwd,
        env: {
          ...env,
          PIS_APT_SOCKET: proposalPath,
          PIS_CODEX_AUTO_SOCKET: path.join(base, 'unused.sock'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const capture = (chunk) => {
        output += chunk;
        if (output.length > 4 * 1024 * 1024) child.kill('SIGKILL');
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
    check(
      result.code === 0 &&
        result.output.includes('pis update probe OK') &&
        calls === 3 &&
        proposals === 1 &&
        fs.existsSync(settled),
    );
    const loaded = JSON.parse(fs.readFileSync(report, 'utf8'));
    check(
      loaded.missing.length === 0 &&
        loaded.commands.includes('codex-auto') &&
        loaded.tools.includes('request_host_git'),
    );
    if (extensions.some((entry) => entry.name === 'pi-web-access'))
      check(loaded.tools.includes('web_search'));
    return { ok: true, piVersion: policy.piVersion, extensions: policy.extensions };
  } finally {
    child?.kill('SIGKILL');
    for (const peer of peers) peer.destroy();
    if (relay.listening) await new Promise((resolve) => relay.close(resolve));
    if (proxy) await proxy.close();
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runUpdateProbe()));
  } catch {
    console.error('pis: candidate probe failed (no live model requests).');
    process.exitCode = 1;
  }
}
