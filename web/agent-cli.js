#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { NAME_PATTERN } from '../src/config.js';
import { resolveWebProjects } from '../src/project-rpc.js';
import { startDummyConnector } from './connector.js';
import { startProjectConnector } from './project-connector.js';
import { readAgentProfile, saveAgentProfile, forgetAgentProfile, identifyAgent, localServerOrigin } from './agent-profile.js';
import { readAgentKey } from './secret-input.js';
import { createDiagnostics } from './diagnostics.js';
import { STARTUP_LABELS } from './public/startup.js';

export const AGENT_HELP = `Usage:
  pis --connect register NAME --server http://127.0.0.1:43128 (--project PROJECT | --dummy) [--replace] [--key-stdin]
  pis --connect run NAME [--diagnostics]
  pis --connect forget NAME

Create a matching Pi/dummy registration in the web panel first. Paste its key at
our hidden terminal prompt, never in argv, URLs, shell history or project JSON.
Profiles are private host files under PIS_HOME/web-agents, never sandbox mounts.
Register checks identity and saves locally; run starts a separate local agent.
--replace explicitly replaces an old key after server restart/re-registration.
forget removes only the local key; revoke in the web panel to invalidate it.
Loopback only: no LAN/TLS/server-container support in this first version.
The registered server can prompt/read history/stop this agent; trust it as a
controller. Real project prompts can cost tokens. No Git/apt web approvals.`;
export function parseAgentOptions(args) {
  const [action, name, ...rest] = args;
  if (!['register', 'run', 'forget'].includes(action) || !name || !NAME_PATTERN.test(name)) throw new Error('Invalid agent command.');
  const options = { action, name }, seen = new Set();
  while (rest.length) {
    const flag = rest.shift();
    if (seen.has(flag)) throw new Error('Duplicate option.'); seen.add(flag);
    if (action === 'register' && ['--server', '--project'].includes(flag)) {
      const value = rest.shift(); if (!value || value.startsWith('-')) throw new Error('Missing option value.');
      options[flag.slice(2)] = value;
    } else if (action === 'register' && ['--dummy', '--replace', '--key-stdin'].includes(flag)) options[flag.slice(2)] = true;
    else if (action === 'run' && flag === '--diagnostics') options.diagnostics = true;
    else throw new Error('Unknown agent option.');
  }
  if (action === 'register') {
    options.server = localServerOrigin(options.server);
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
      connector.network.events.on('rejected', () => console.error('pis agent: registreringen nekades. Automatisk återanslutning stoppad, men lokal agent kan fortfarande arbeta. Stoppa här med Ctrl-C, skapa ny nyckel i GUI:t och registrera med --replace.'));
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
if (process.argv[1] === fileURLToPath(import.meta.url)) agentMain(process.argv.slice(2)).catch(() => {
  console.error('pis agent: kommandot misslyckades. Kontrollera --help, lokal profil/filbehörigheter, serveranslutning och registrering. Efter serveromstart krävs ny nyckel och register --replace. Kontrollera projekt/lås på värden vid start- eller stoppfel. Inga råa fel eller nycklar skrivs ut.');
  process.exitCode = 1;
});
