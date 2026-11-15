#!/usr/bin/env node
import { hashPassword, randomKey, digest } from './common.js';
import { startWebServer } from './server.js';
import { startDummyConnector } from './connector.js';
import { startProjectConnector } from './project-connector.js';
import { STARTUP_LABELS, startupFailure } from './public/startup.js';
import { resolveWebProjects } from '../src/project-rpc.js';
import { createDiagnostics } from './diagnostics.js';

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
  output.write('Adminlösenord (minst 20 tecken, dolt; Enter genererar och visar ett tillfälligt lösenord): ');
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
const options = { port: 43128, agents: 2, piped: false, projects: [], diagnostics: false, standalone: false };
const args = process.argv.slice(2), seen = new Set(), startupController = new AbortController();
let server, connectors = [], stopping, startup, failedProjects = 0;
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
  if (!['demo', 'start'].includes(mode)) throw new Error('Usage: node web/cli.js start [--standalone | --project NAME (repeatable) | --agents 1..8] [--port PORT] [--password-stdin] [--diagnostics]');
  while (args.length) {
    const flag = args.shift();
    if (seen.has(flag) && flag !== '--project') throw new Error('Duplicate option.');
    seen.add(flag);
    if (flag === '--standalone' && mode === 'start') options.standalone = true;
    else if (flag === '--password-stdin') options.piped = true;
    else if (flag === '--diagnostics') options.diagnostics = true;
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
  if (options.standalone && (options.projects.length || seen.has('--agents'))) throw new Error('Standalone mode does not start agents.');
  if (options.projects.length && seen.has('--agents')) throw new Error('Choose real projects or dummy agents, not both.');
  let projects = [];
  if (options.projects.length) {
    try { projects = resolveWebProjects(options.projects); }
    catch { throw Object.assign(new Error('Cannot select local Pi projects.'), { code: 'WEB_PROJECT_SELECTION' }); }
  }
  if (projects.length) console.error('EXPERIMENTAL: Starting real registered Pi sandboxes. Saved sessions/configured extensions and browser prompts may use model quota or incur API costs. Git/apt host approvals and quota-auto are unavailable.');
  const diagnostic = createDiagnostics({ enabled: options.diagnostics });
  if (options.diagnostics) console.error('Säker diagnostik aktiverad: dela bara rader med prefixet "pis web diagnostic:". Dela inte lösenordsraden, hela logg-/state-mappar eller råa nätverkssvar.');
  let password = await readPassword(options.piped), generatedPassword;
  if (password === '') { password = randomKey(); generatedPassword = password; }
  const passwordHash = await hashPassword(password); password = undefined;
  const agents = options.standalone ? [] : projects.length ? projects.map(project => ({ id: `pi-${project.id}`, label: project.label, kind: 'pi', project, token: randomKey() }))
    : Array.from({ length: options.agents }, (_, index) => ({ id: `dummy-${index + 1}`, label: `Dummy ${index + 1}`, kind: 'dummy', token: randomKey() }));
  server = await startWebServer({ passwordHash, port: options.port, diagnostic, agents: agents.map(agent => ({ id: agent.id, label: agent.label, kind: agent.kind, tokenHash: digest(agent.token) })) });
  if (generatedPassword !== undefined) {
    console.error(`Genererat tillfälligt adminlösenord (visas en gång):\n${generatedPassword}\nVarning: lösenordet syns i terminalen och kan hamna i terminalhistorik, inspelningar eller omdirigerad stderr. Det sparas inte av pis; nästa start får ett nytt om du lämnar tomt.`);
    generatedPassword = undefined;
  }
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
    startup = agent.project ? startProjectConnector({ origin: server.origin, token: agent.token, project: agent.project, signal: startupController.signal, onProgress, diagnostic })
      : startDummyConnector({ origin: server.origin, token: agent.token, diagnostic });
    let connector;
    try { connector = await startup; }
    catch (error) {
      if (!agent.project) throw error;
      startup = undefined;
      if (stopping) break;
      failedProjects++;
      const failurePhase = startupFailure(error.phase) ? error.phase : 'failed';
      if (phase !== failurePhase) onProgress(failurePhase);
      console.error(`pis web: ${agent.id} kunde inte startas. ${STARTUP_LABELS[failurePhase]}.\nWebbservern förblir igång på ${server.origin}; felet visas i agentlistan. Ingen automatisk omstart eller omsändning görs. Rätta orsaken på värden och starta om webbkommandot när det är säkert.`);
      continue;
    } finally { clearInterval(heartbeat); }
    if (stopping) { await connector.close(); break; }
    connectors.push(connector); startup = undefined;
  }
  if (!stopping && projects.length && connectors.length) console.error(`${connectors.length} Pi project connection(s) ready. Server och agentanslutningar är igång. Öppna ${server.origin}, logga in och välj projektet i listan.\nTerminalen ska nu stå kvar utan ny prompt: den håller servern igång, det är inte en väntande start.\nCtrl-C stänger server/agenter; containerstopp kan ta omkring en minut. Ej bekräftat stopp behåller projektlåset för kontroll på värden.`);
  if (!stopping && failedProjects) console.error(`Webbservern är igång; ${failedProjects} projekt kunde inte startas. Öppna ${server.origin} och välj agenten för felstatus. Ctrl-C stänger servern.`);
  if (!stopping && options.standalone) console.error(`Fristående lokal webbserver: ${server.origin}\nLogga in och skapa agentnycklar i webbpanelen. Registreringar och inloggningar finns bara i minnet och försvinner vid serveromstart.\nInga lokala agenter startas. Endast loopback; inte TLS/LAN eller en servercontainer. Ctrl-C stänger servern, inte självständiga agenter.`);
  if (!stopping && !projects.length && !options.standalone) console.error(`Lokal dummy-webb: ${server.origin}\nLogga in med lösenordet du nyss valde. ${options.agents} utgående dummy-anslutningar; inga modell-anrop.\nEndast loopback. Ctrl-C stänger server och dummies. Ingen konfiguration eller historik sparas.`);
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? `Webbservern kunde inte starta: port ${options.port} används redan. Välj --port 43129 eller stäng den andra servern.`
    : error.code === 'EACCES' ? 'Webbservern saknar behörighet att öppna den valda porten.'
    : error.code === 'WEB_PROJECT_SELECTION' ? 'Kan inte välja registrerat Pi-projekt. Kör pis --list och pis --project NAMN --check på värden; Claude, okända/dubbla projekt och ogiltig konfiguration stöds inte här.'
    : error.message?.startsWith('Usage:') ? error.message : 'Webbservern kunde inte starta. Kontrollera alternativ, web-beroenden och att lösenordet är minst 20 tecken. Inga råa fel eller inloggningsuppgifter skrivs ut.');
  process.exitCode = 1; await stop();
}
