#!/usr/bin/env node
import path from 'node:path';
import { inspectLock } from '../src/locks.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { NAME_PATTERN } from '../src/config.js';
import { resolveWebProjects, resolveConnectProject } from '../src/project-rpc.js';
import { startDummyConnector } from './connector.js';
import { startProjectConnector } from './project-connector.js';
import { readAgentProfile, saveAgentProfile, forgetAgentProfile, identifyAgent, enrollAgent, localServerOrigin } from './agent-profile.js';
import { readAgentKey } from './secret-input.js';
import { createDiagnostics } from './diagnostics.js';
import { STARTUP_LABELS } from './public/startup.js';

export const AGENT_HELP = `Usage:
  pis --connect NAME --server http://127.0.0.1:43128 [--project PROJECT | --dummy] [--key-stdin] [--diagnostics]
  pis --connect register NAME --server http://127.0.0.1:43128 (--project PROJECT | --dummy) [--replace] [--key-stdin]
  pis --connect run NAME [--diagnostics]
  pis --connect forget NAME

Default: create a one-use enrollment key in the GUI, then connect NAME. Project
selection defaults to NAME (registered ID/name or unique last folder component).
This replaces the private local profile after successful enrollment and runs it.
Existing running projects are never stopped or stolen. GUI uses the folder name.
Advanced register/run/forget commands below remain supported for legacy keys.
Create a matching Pi/dummy registration in the legacy API first for register. Paste its key at
our hidden terminal prompt, never in argv, URLs, shell history or project JSON.
Profiles are private host files under PIS_HOME/web-agents, never sandbox mounts.
Register checks identity and saves locally; run starts a separate local agent.
Short connect always replaces the profile after enrollment; --replace is only
needed for the legacy register command with a direct agent key.
forget removes only the local key; revoke in the web panel to invalidate it.
Loopback only: no LAN/TLS/server-container support in this first version.
The registered server can prompt/read history/stop this agent; trust it as a
controller. Real project prompts can cost tokens. No Git/apt web approvals.`;
export function parseAgentOptions(args) {
  const explicit = ['register', 'run', 'forget'].includes(args[0]);
  const action = explicit ? args[0] : 'connect', name = args[explicit ? 1 : 0], rest = args.slice(explicit ? 2 : 1);
  if (!name || !NAME_PATTERN.test(name)) throw new Error('Invalid agent command.');
  const options = { action, name }, seen = new Set();
  while (rest.length) {
    const flag = rest.shift();
    if (seen.has(flag)) throw new Error('Duplicate option.'); seen.add(flag);
    if (['register', 'connect'].includes(action) && ['--server', '--project'].includes(flag)) {
      const value = rest.shift(); if (!value || value.startsWith('-')) throw new Error('Missing option value.');
      options[flag.slice(2)] = value;
    } else if (['register', 'connect'].includes(action) && ['--dummy', '--replace', '--key-stdin'].includes(flag)) options[flag.slice(2)] = true;
    else if (['run', 'connect'].includes(action) && flag === '--diagnostics') options.diagnostics = true;
    else throw new Error('Unknown agent option.');
  }
  if (['register', 'connect'].includes(action)) {
    options.server = localServerOrigin(options.server);
    if (action === 'connect' && !options.dummy) options.project ||= name;
    if (action === 'connect') options.replace = true;
    if (Boolean(options.project) === Boolean(options.dummy)) throw new Error('Choose exactly one project or dummy.');
  }
  return options;
}
async function runProfile(store, name, diagnostic) {
  const record = readAgentProfile(store.root, name);
  if (!record) throw new Error('Missing agent profile.');
  // Reject expired/incorrect registrations before launching Podman or a runtime.
  const identity = await identifyAgent(record.origin, record.token);
  if (identity.id !== record.agentId || identity.kind !== record.kind) throw new Error('Registration mismatch.');
  const project = record.kind === 'pi' ? resolveWebProjects([record.projectId], store)[0] : undefined;
  {
    let connector, finish;
    const controller = new AbortController(), stopped = new Promise(resolve => { finish = resolve; });
    const stop = () => { controller.abort(); finish(); };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
    try {
      if (project) console.error('EXPERIMENTAL: Startar lokalt Pi-projekt i Podman. Servern kan läsa historik, skicka promptar (kan kosta tokens) och stoppa agentarbete. Inga Git/apt-godkännanden eller quota-auto.');
      connector = project ? await startProjectConnector({ project, origin: record.origin, token: record.token, signal: controller.signal, diagnostic,
        onProgress: phase => console.error(`pis agent: ${STARTUP_LABELS[phase]}`) })
        : await startDummyConnector({ origin: record.origin, token: record.token, diagnostic });
      const ready = () => console.error('pis agent: ansluten och registrerad. Ctrl-C stänger denna lokala agent; servern fortsätter.');
      connector.network.events.on('registered', ready);
      connector.network.events.on('disconnected', () => console.error('pis agent: webbanslutningen bröts. Lokalt arbete kan fortsätta; inga promptar skickas om.'));
      connector.network.events.on('rejected', () => console.error('pis agent: registreringen nekades. Automatisk återanslutning stoppad, men lokal agent kan fortfarande arbeta. Stoppa här med Ctrl-C, skapa ny engångsnyckel i GUI:t och kör pis --connect NAMN --server ADRESS igen.'));
      connector.rpc.once('closed', finish);
      if (project) ready();
      if (connector.rpc.closed) finish();
      if (controller.signal.aborted) finish();
      await stopped;
    } finally {
      try { await connector?.close(); }
      finally { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop); }
    }
  }
}
export async function agentMain(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(AGENT_HELP); return; }
  const options = parseAgentOptions(args), store = new Store();
  if (options.action === 'forget') {
    await forgetAgentProfile(store.root, options.name); console.error('Lokal agentnyckel borttagen. Detta återkallar inte serverns nyckel och stoppar inte en körande agent.'); return;
  }
  if (options.action === 'connect') {
    const project = options.dummy ? undefined : resolveConnectProject(options.project, store);
    if (project && inspectLock(path.join(store.projectDir(project.id), 'project.lock')).status !== 'absent') throw Object.assign(new Error('Project busy or lock requires inspection.'), { code: 'CONNECT_PROJECT_BUSY' });
    const previous = readAgentProfile(store.root, options.name);
    const same = previous && previous.origin === options.server && previous.kind === (project ? 'pi' : 'dummy') && previous.projectId === (project?.id || null);
    const key = await readAgentKey({ piped: options['key-stdin'] });
    const clientId = same && previous.clientId ? previous.clientId : randomUUID();
    const identity = await enrollAgent(options.server, key, { clientId, label: project ? path.basename(project.root).slice(0, 80) : options.name, kind: project ? 'pi' : 'dummy', previousToken: same ? previous.token : null });
    await saveAgentProfile(store.root, options.name, { version: 1, origin: options.server, token: identity.token, agentId: identity.id, kind: identity.kind, projectId: project?.id || null, clientId }, { replace: true });
    console.error('Engångsnyckeln är förbrukad. Anslutningen är sparad privat; startar agenten nu.');
    await runProfile(store, options.name, createDiagnostics({ enabled: options.diagnostics })); return;
  }
  if (options.action === 'register') {
    const project = options.project ? resolveWebProjects([options.project], store)[0] : undefined;
    if (!options.replace && readAgentProfile(store.root, options.name)) throw new Error('Profile already exists.');
    const token = await readAgentKey({ piped: options['key-stdin'] });
    const identity = await identifyAgent(options.server, token), kind = project ? 'pi' : 'dummy';
    if (identity.kind !== kind) throw new Error('Registration kind does not match.');
    await saveAgentProfile(store.root, options.name, { version: 1, origin: options.server, token, agentId: identity.id, kind, projectId: project?.id || null }, { replace: options.replace });
    console.error('Registrering verifierad och sparad privat på värden. Kör pis --connect run med samma profilnamn för att starta agenten. Ingen agent eller modell startades av registreringen.'); return;
  }
  await runProfile(store, options.name, createDiagnostics({ enabled: options.diagnostics }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) agentMain(process.argv.slice(2)).catch(error => {
  if (error.code === 'ENROLLMENT_CONFLICT') console.error('pis agent: agenten är redan ansluten eller tidigare identitet kunde inte verifieras. Inget arbete stoppades och den lokala profilen ersattes inte. Stoppa din gamla anslutning först; vid förlorad registreringsbekräftelse, återkalla rätt GUI-post och skapa en ny nyckel.');
  if (error.code === 'CONNECT_PROJECT_BUSY') console.error('pis agent: projektet körs redan eller har ett lås som måste kontrolleras på värden. Ingen registrering byttes och inget arbete stoppades.');
  if (error.code === 'CONNECT_PROJECT_AMBIGUOUS') console.error('pis agent: flera registrerade projekt har samma sista mappnamn. Ange --project med ett unikt ID eller registrerat namn.');
  console.error('pis agent: kommandot misslyckades. Kontrollera --help, lokal profil/filbehörigheter, serveranslutning och registrering. Skapa en ny engångsnyckel och kör pis --connect NAMN --server ADRESS. Efter ett osäkert registreringsutfall kan GUI-posten behöva återkallas först. Kontrollera projekt/lås på värden vid start- eller stoppfel. Inga råa fel eller nycklar skrivs ut.');
  process.exitCode = 1;
});
