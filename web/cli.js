#!/usr/bin/env node
import { hashPassword, randomKey, digest } from './common.js';
import { startWebServer } from './server.js';
import { startDummyConnector } from './connector.js';
import { startProjectConnector } from './project-connector.js';
import { STARTUP_LABELS } from './public/startup.js';
import { resolveWebProjects } from '../src/project-rpc.js';

async function readPassword(piped) {
  const input = process.stdin, output = process.stderr;
  if (piped) {
    let text = '';
    for await (const chunk of input) { text += chunk; if (Buffer.byteLength(text) > 1026) throw new Error('Password input too large.'); }
    if (/\r?\n$/.test(text)) text = text.replace(/\r?\n$/, '');
    if (/[\r\n]/.test(text)) throw new Error('Provide one password line.');
    return text;
  }
  if (!input.isTTY || !output.isTTY) throw new Error('Use a terminal or explicit --password-stdin.');
  output.write('Välj ett tillfälligt adminlösenord (minst 20 tecken, dolt): ');
  return new Promise((resolve, reject) => {
    let text = '';
    const wasRaw = input.isRaw;
    const finish = error => {
      input.off('data', onData); input.off('end', onEnd);
      for (const signal of ['SIGTERM', 'SIGHUP']) process.off(signal, onSignal);
      input.setRawMode(Boolean(wasRaw)); input.pause(); output.write('\n');
      if (error) reject(error); else resolve(text);
    };
    const onEnd = () => finish(new Error('Password input closed.'));
    const onSignal = () => finish(new Error('Cancelled.'));
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\x03' || char === '\x04') { finish(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\x7f' || char === '\b') text = Array.from(text).slice(0, -1).join('');
        else if (char >= ' ') text += char;
        if (Buffer.byteLength(text) > 1024) { finish(new Error('Password input too large.')); return; }
      }
    };
    for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
    input.setEncoding('utf8'); input.setRawMode(true); input.on('data', onData); input.once('end', onEnd); input.resume();
  });
}
const options = { port: 43128, agents: 2, piped: false, projects: [] };
const args = process.argv.slice(2), seen = new Set(), startupController = new AbortController();
let server, connectors = [], stopping, startup;
async function stop() {
  return stopping ||= (async () => {
    const deadline = setTimeout(() => process.exit(1), options.projects.length ? 90_000 : 10_000); deadline.unref();
    startupController.abort();
    try {
      const results = await Promise.allSettled([...connectors.map(connector => connector.close()), ...(startup ? [startup.then(connector => connector.close())] : [])]);
      await server?.close();
      if (results.some(result => result.status === 'rejected')) process.exitCode = 1;
    } finally { clearTimeout(deadline); }
  })();
}
try {
  const mode = args.shift();
  if (!['demo', 'start'].includes(mode)) throw new Error('Usage: node web/cli.js start [--project NAME (repeatable) | --agents 1..8] [--port PORT] [--password-stdin]');
  while (args.length) {
    const flag = args.shift();
    if (seen.has(flag) && flag !== '--project') throw new Error('Duplicate option.');
    seen.add(flag);
    if (flag === '--password-stdin') options.piped = true;
    else if (flag === '--project' && mode === 'start') {
      const selector = args.shift();
      if (!selector || selector.startsWith('-') || options.projects.length >= 8) throw new Error('Expected a registered project name/ID (maximum eight).');
      options.projects.push(selector);
    } else if (['--port', '--agents'].includes(flag)) {
      const value = args.shift();
      if (!/^\d+$/.test(value || '')) throw new Error('Expected numeric option.');
      options[flag.slice(2)] = Number(value);
    } else throw new Error('Unknown option.');
  }
  if (options.port < 1024 || options.port > 65535 || options.agents < 1 || options.agents > 8) throw new Error('Invalid local demo port/agent count.');
  if (options.projects.length && seen.has('--agents')) throw new Error('Choose real projects or dummy agents, not both.');
  const projects = options.projects.length ? resolveWebProjects(options.projects) : [];
  if (projects.length) console.error('EXPERIMENTAL: Starting real registered Pi sandboxes. Saved sessions/configured extensions and browser prompts may use model quota or incur API costs. Git/apt host approvals and quota-auto are unavailable.');
  let password = await readPassword(options.piped);
  const passwordHash = await hashPassword(password); password = undefined;
  const agents = projects.length ? projects.map(project => ({ id: `pi-${project.id}`, label: project.label, kind: 'pi', project, token: randomKey() }))
    : Array.from({ length: options.agents }, (_, index) => ({ id: `dummy-${index + 1}`, label: `Dummy ${index + 1}`, kind: 'dummy', token: randomKey() }));
  server = await startWebServer({ passwordHash, port: options.port, agents: agents.map(agent => ({ id: agent.id, label: agent.label, kind: agent.kind, tokenHash: digest(agent.token) })) });
  for (const agent of agents) if (agent.project) server.setStartup(agent.id, 'queued');
  if (projects.length) console.error(`Lokal Pi-webb: ${server.origin}\nWebbservern är igång. Öppna adressen och logga in redan nu för att följa agentstarten i GUI:t.\nSandbox-start kan ta flera minuter; inget startprompt skickas av anslutningen.`);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void stop(); });
  for (const agent of agents) {
    if (stopping) break;
    let phase = 'queued';
    const startedAt = Date.now();
    const onProgress = next => {
      phase = next; server.setStartup(agent.id, next);
      console.error(`pis web: [${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${agent.id}: ${STARTUP_LABELS[next]}`);
    };
    const heartbeat = agent.project ? setInterval(() => {
      console.error(`pis web: [${Math.floor((Date.now() - startedAt) / 1000)}s] ${agent.id}: väntar fortfarande · ${STARTUP_LABELS[phase]} (ingen uppskattning av återstående tid).`);
    }, 10_000) : undefined;
    startup = agent.project ? startProjectConnector({ origin: server.origin, token: agent.token, project: agent.project, signal: startupController.signal, onProgress })
      : startDummyConnector({ origin: server.origin, token: agent.token });
    let connector;
    try { connector = await startup; } finally { clearInterval(heartbeat); }
    if (stopping) { await connector.close(); break; }
    connectors.push(connector); startup = undefined;
  }
  if (!stopping && projects.length) console.error(`${projects.length} Pi project connection(s) ready. Server och agentanslutningar är igång. Öppna ${server.origin}, logga in och välj projektet i listan.\nTerminalen ska nu stå kvar utan ny prompt: den håller servern igång, det är inte en väntande start.\nCtrl-C stänger server/agenter; containerstopp kan ta omkring en minut. Ej bekräftat stopp behåller projektlåset för kontroll på värden.`);
  if (!stopping && !projects.length) console.error(`Lokal dummy-webb: ${server.origin}\nLogga in med lösenordet du nyss valde. ${options.agents} utgående dummy-anslutningar; inga modell-anrop.\nEndast loopback. Ctrl-C stänger server och dummies. Ingen konfiguration eller historik sparas.`);
} catch (error) {
  console.error(['EADDRINUSE', 'EACCES'].includes(error.code) ? 'Could not bind the local demo port.' : error.message?.startsWith('Usage:') ? error.message : 'Local web demo could not start. Check dependency installation, options and password length.');
  process.exitCode = 1; await stop();
}
