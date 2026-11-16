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
import {
  readAgentProfile,
  saveAgentProfile,
  forgetAgentProfile,
  identifyAgent,
  enrollAgent,
  readDefaultServer,
  saveDefaultServer,
} from './agent-profile.js';
import { readAgentKey } from './secret-input.js';
import { pairAgent } from './pairing-client.js';
import { createDiagnostics } from './diagnostics.js';
import { STARTUP_LABELS } from './public/startup.js';
import { serverAddress } from './server-address.js';
import { openServerTransport } from './ssh-transport.js';
import { readTerminalLine } from '../src/terminal-input.js';

export const AGENT_HELP = `Usage:
  pis --connect [NAME] [--server http://127.0.0.1:43128] [--project PROJECT | --dummy] [--diagnostics]
  pis --connect NAME [--enrollment-key | --key-stdin] [other connect options]
  pis --connect --set-server ssh://[USER@]HOST[:SSH_PORT][/PIS_PORT]
  pis --connect --set-server http://127.0.0.1:43128
  pis --connect register NAME --server http://127.0.0.1:43128 (--project PROJECT | --dummy) [--replace] [--key-stdin]
  pis --connect run NAME [--diagnostics]
  pis --connect forget NAME

Default: request connection, then enter the displayed two-digit code under
Väntande klienter in the authenticated server UI. Without NAME/--project, select
the registered Pi project containing the current directory. Save a global server
with --set-server; --server overrides it for one invocation and does not save it.
No saved server? Bare --connect asks for the address in an interactive terminal
and saves your validated answer. Noninteractive use requires a saved/explicit address.

SSH examples (ports default to SSH 22 and pis 43128):
  pis --connect --set-server ssh://192.0.2.10
  pis --connect --set-server ssh://alice@server.example
  pis --connect --server ssh://alice@server.example:2222/43129
Then run pis --connect from the registered project. Omit USER to use your host
login name. --set-server saves only the address, does not open SSH or start an agent.
The remote server must run pis --server --standalone on 127.0.0.1:PIS_PORT.
Each client owns one ssh -N -L tunnel until it exits. Forwarding uses a private
local Unix socket (no TCP-port clash); Host/Origin checks are not weakened.
Install OpenSSH on the client HOST. Key login and a verified known_hosts entry
are required. Test first with ssh -p SSH_PORT USER@HOST; verify its fingerprint
independently. Tunnels use BatchMode=yes and StrictHostKeyChecking=yes: no password
prompts or automatic acceptance of unknown/changed keys. Host ~/.ssh/config is
not loaded (no aliases/ProxyCommand); normal default key files/SSH agent can be used.
Your public web domain works only if SSH is separately reachable there; HTTPS/CDN
reachability is not SSH. No SSH keys/agents are mounted into Pi containers.

With NAME, project selection defaults to NAME (registered ID/name or unique last folder component).
Legacy GUI keys use --enrollment-key (hidden prompt) or --key-stdin.
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
Direct HTTP remains loopback-only. Explicit ssh:// provides encrypted host-to-host
forwarding without a public HTTP listener; direct LAN/TLS remains unsupported.
The registered server can prompt/read history/stop this agent; trust it as a
controller. Real project prompts can cost tokens. Apt web approvals remain unavailable.
Optional --allow-web-git (connect/run, real Pi only) trusts this server's authenticated
admins to approve exact non-force Git pushes on THIS host after sandbox shutdown.
Not saved in profiles; opt in on every launch. Supports individual in-project submodules.
Verified Git-flow completion reconnects a fresh idle runtime; no automatic push,
recursive push, credential prompt, model continuation or retry.`;
export function parseAgentOptions(args) {
  const explicit = ['register', 'run', 'forget'].includes(args[0]);
  const action = explicit ? args[0] : 'connect';
  let index = explicit ? 1 : 0;
  const name = explicit || (args[0] && !args[0].startsWith('-')) ? args[index++] : undefined;
  const rest = args.slice(index);
  if (explicit && (!name || !NAME_PATTERN.test(name))) throw new Error('Invalid agent command.');
  const options = { action, ...(name ? { name } : {}) },
    seen = new Set();
  while (rest.length) {
    const flag = rest.shift();
    if (seen.has(flag)) throw new Error('Duplicate option.');
    seen.add(flag);
    if (action === 'connect' && flag === '--set-server') {
      const value = rest.shift();
      if (!value || value.startsWith('-')) throw new Error('Missing option value.');
      options.setServer = value;
    } else if (
      ['register', 'connect'].includes(action) &&
      ['--server', '--project'].includes(flag)
    ) {
      const value = rest.shift();
      if (!value || value.startsWith('-')) throw new Error('Missing option value.');
      options[flag.slice(2)] = value;
    } else if (
      ['register', 'connect'].includes(action) &&
      [
        '--dummy',
        '--replace',
        '--key-stdin',
        ...(action === 'connect' ? ['--enrollment-key'] : []),
      ].includes(flag)
    )
      options[flag.slice(2)] = true;
    else if (['run', 'connect'].includes(action) && flag === '--diagnostics')
      options.diagnostics = true;
    else if (['run', 'connect'].includes(action) && flag === '--allow-web-git')
      options.allowWebGit = true;
    else throw new Error('Unknown agent option.');
  }
  if (options.setServer) {
    if (
      name ||
      options.server ||
      options.project ||
      options.dummy ||
      options['key-stdin'] ||
      options['enrollment-key'] ||
      options.replace ||
      options.diagnostics ||
      options.allowWebGit
    )
      throw new Error('--set-server cannot be combined with connection options.');
    options.server = serverAddress(options.setServer).address;
    options.action = 'set-server';
    return options;
  }
  if (['register', 'connect'].includes(action)) {
    if (action === 'connect' && !name) options.unnamed = true;
    if (name && !NAME_PATTERN.test(name)) throw new Error('Invalid agent command.');
    if (action === 'connect' && !options.dummy && name) options.project ||= name;
    if (action === 'connect') options.replace = true;
    if (action === 'register') options.server = serverAddress(options.server).address;
    if (action === 'connect' && options.server)
      options.server = serverAddress(options.server).address;
    if (
      (options.project && options.dummy) ||
      (action === 'register' && !options.project && !options.dummy)
    )
      throw new Error('Choose exactly one project or dummy.');
  }
  if (options.allowWebGit && options.dummy) throw new Error('Web Git requires a real Pi project.');
  return options;
}
async function runProfile(store, name, diagnostic, transport, signal, allowWebGit = false) {
  signal?.throwIfAborted();
  const record = readAgentProfile(store.root, name);
  if (!record) throw new Error('Missing agent profile.');
  // Reject expired/incorrect registrations before launching Podman or a runtime.
  const identity = await identifyAgent(transport.origin, record.token, {
    fetchImpl: transport.fetchImpl,
  });
  if (identity.id !== record.agentId || identity.kind !== record.kind)
    throw new Error('Registration mismatch.');
  const project =
    record.kind === 'pi' ? resolveWebProjects([record.projectId], store)[0] : undefined;
  if (allowWebGit && !project) throw new Error('Web Git requires a real Pi project.');
  {
    let connector, finish;
    const controller = new AbortController(),
      stopped = new Promise((resolve) => {
        finish = resolve;
      });
    const stop = () => {
      controller.abort();
      finish();
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      signal?.throwIfAborted();
      if (project)
        console.error(
          'EXPERIMENTAL: Startar lokalt Pi-projekt i Podman. Servern kan läsa historik, skicka promptar (kan kosta tokens) och stoppa agentarbete. Git kräver separat --allow-web-git; inga apt-godkännanden eller quota-auto.',
        );
      if (allowWebGit)
        console.error(
          'Web Git opt-in: authenticated admins of this server may approve one exact non-force push after this sandbox stops. SSH host authentication stays local. Verified Git completion reconnects Pi idle; no automatic model continuation or push retry.',
        );
      connector = project
        ? await startProjectConnector({
            project,
            allowWebGit,
            origin: transport.origin,
            token: record.token,
            createConnection: transport.createConnection,
            signal: controller.signal,
            diagnostic,
            onProgress: (phase) => console.error(`pis agent: ${STARTUP_LABELS[phase]}`),
          })
        : await startDummyConnector({
            origin: transport.origin,
            token: record.token,
            diagnostic,
            createConnection: transport.createConnection,
          });
      const ready = () =>
        console.error(
          'pis agent: ansluten och registrerad. Ctrl-C stänger denna lokala agent; servern fortsätter.',
        );
      connector.network.events.on('registered', ready);
      connector.network.events.on('disconnected', () =>
        console.error(
          'pis agent: webbanslutningen bröts. Lokalt arbete kan fortsätta; inga promptar skickas om.',
        ),
      );
      connector.network.events.on('rejected', () =>
        console.error(
          'pis agent: registreringen nekades. Automatisk återanslutning stoppad, men lokal agent kan fortfarande arbeta. Stoppa här med Ctrl-C och kör pis --connect igen med en ny kod som godkänns i GUI:t.',
        ),
      );
      if (connector.events) connector.events.once('closed', finish);
      else connector.rpc.once('closed', finish);
      if (project) ready();
      if (connector.events ? connector.isClosed : connector.rpc.closed) finish();
      if (controller.signal.aborted) finish();
      await stopped;
    } finally {
      try {
        await connector?.close();
      } finally {
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
        signal?.removeEventListener('abort', stop);
      }
    }
  }
}
export async function agentMain(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(AGENT_HELP);
    return;
  }
  const options = parseAgentOptions(args),
    store = new Store();
  if (options.action === 'set-server') {
    await saveDefaultServer(store.root, options.server);
    console.error('Standardserver sparad privat. Ingen registrering eller agent startades.');
    return;
  }
  if (options.action === 'forget') {
    await forgetAgentProfile(store.root, options.name);
    console.error(
      'Lokal agentnyckel borttagen. Detta återkallar inte serverns nyckel och stoppar inte en körande agent.',
    );
    return;
  }
  if (options.action === 'connect') {
    options.server ||= readDefaultServer(store.root);
    if (!options.server) {
      const entered = await readTerminalLine({
        hidden: false,
        maxBytes: 256,
        prompt: 'Serveradress (ssh://[användare@]server eller http://127.0.0.1:43128): ',
        ttyError:
          'No saved server. Use pis --connect --set-server ssh://[USER@]HOST or --server ADDRESS.',
      });
      options.server = serverAddress(entered).address;
      await saveDefaultServer(store.root, options.server);
      console.error('Standardserver sparad privat.');
    }
    if (!options.dummy) {
      const project = resolveConnectProject(options.project, store);
      if (inspectLock(path.join(store.projectDir(project.id), 'project.lock')).status !== 'absent')
        throw Object.assign(new Error('Project busy or lock requires inspection.'), {
          code: 'CONNECT_PROJECT_BUSY',
        });
    }
  }
  const address =
    options.action === 'run' ? readAgentProfile(store.root, options.name)?.origin : options.server;
  if (!address) throw new Error('Missing agent profile.');
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  let transport;
  try {
    transport = await openServerTransport(address, { signal: controller.signal });
    return await connectedAction(store, options, transport, controller.signal);
  } finally {
    try {
      await transport?.close();
    } finally {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
    }
  }
}
async function connectedAction(store, options, transport, signal) {
  signal.throwIfAborted();
  if (options.action === 'connect') {
    const project = options.dummy ? undefined : resolveConnectProject(options.project, store);
    options.name ||= project ? `p-${project.id}` : 'dummy';
    options.server ||= readDefaultServer(store.root);
    if (!options.server)
      throw new Error(
        'No default server. Save one with pis --connect --set-server http://127.0.0.1:43128, or use --server.',
      );
    if (
      project &&
      inspectLock(path.join(store.projectDir(project.id), 'project.lock')).status !== 'absent'
    )
      throw Object.assign(new Error('Project busy or lock requires inspection.'), {
        code: 'CONNECT_PROJECT_BUSY',
      });
    const previous = readAgentProfile(store.root, options.name);
    const same =
      previous &&
      previous.origin === options.server &&
      previous.kind === (project ? 'pi' : 'dummy') &&
      previous.projectId === (project?.id || null);
    const clientId = same && previous.clientId ? previous.clientId : randomUUID();
    const enrollment = {
      clientId,
      label: project ? path.basename(project.root).slice(0, 80) : options.name,
      kind: project ? 'pi' : 'dummy',
      previousToken: same ? previous.token : null,
    };
    let identity;
    if (options['key-stdin'] || options['enrollment-key']) {
      const key = await readAgentKey({ piped: options['key-stdin'] });
      identity = await enrollAgent(transport.origin, key, enrollment, {
        fetchImpl: transport.fetchImpl,
      });
    } else {
      const controller = new AbortController();
      const stop = () => controller.abort();
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
      try {
        console.error(
          'Servern kan läsa historik, skicka promptar (kan kosta tokens) och stoppa agenten. Godkänn bara rätt server och klient.',
        );
        identity = await pairAgent(transport.origin, enrollment, {
          fetchImpl: transport.fetchImpl,
          signal: AbortSignal.any([controller.signal, signal]),
          onCode: (code) =>
            console.error(
              `pis connect: kod ${code} · ange koden under Väntande klienter på servern (giltig i högst 2 minuter).`,
            ),
        });
      } finally {
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
      }
    }
    await saveAgentProfile(
      store.root,
      options.name,
      {
        version: 1,
        origin: options.server,
        token: identity.token,
        agentId: identity.id,
        kind: identity.kind,
        projectId: project?.id || null,
        clientId,
      },
      { replace: true },
    );
    console.error('Anslutningen är godkänd och sparad privat; startar agenten nu.');
    await runProfile(
      store,
      options.name,
      createDiagnostics({ enabled: options.diagnostics }),
      transport,
      signal,
      options.allowWebGit,
    );
    return;
  }
  if (options.action === 'register') {
    const project = options.project ? resolveWebProjects([options.project], store)[0] : undefined;
    if (!options.replace && readAgentProfile(store.root, options.name))
      throw new Error('Profile already exists.');
    const token = await readAgentKey({ piped: options['key-stdin'] });
    const identity = await identifyAgent(transport.origin, token, {
        fetchImpl: transport.fetchImpl,
      }),
      kind = project ? 'pi' : 'dummy';
    if (identity.kind !== kind) throw new Error('Registration kind does not match.');
    await saveAgentProfile(
      store.root,
      options.name,
      {
        version: 1,
        origin: options.server,
        token,
        agentId: identity.id,
        kind,
        projectId: project?.id || null,
      },
      { replace: options.replace },
    );
    console.error(
      'Registrering verifierad och sparad privat på värden. Kör pis --connect run med samma profilnamn för att starta agenten. Ingen agent eller modell startades av registreringen.',
    );
    return;
  }
  await runProfile(
    store,
    options.name,
    createDiagnostics({ enabled: options.diagnostics }),
    transport,
    signal,
    options.allowWebGit,
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  agentMain(process.argv.slice(2)).catch((error) => {
    if (error.code === 'ENROLLMENT_CONFLICT')
      console.error(
        'pis agent: agenten är redan ansluten eller tidigare identitet kunde inte verifieras. Inget arbete stoppades och den lokala profilen ersattes inte. Stoppa din gamla anslutning först; vid förlorad registreringsbekräftelse, återkalla rätt GUI-post och gör en ny godkänd anslutning.',
      );
    if (error.code === 'CONNECT_PROJECT_BUSY')
      console.error(
        'pis agent: projektet körs redan eller har ett lås som måste kontrolleras på värden. Ingen registrering byttes och inget arbete stoppades.',
      );
    if (error.code === 'CONNECT_PROJECT_AMBIGUOUS')
      console.error(
        'pis agent: flera registrerade projekt har samma sista mappnamn. Ange --project med ett unikt ID eller registrerat namn.',
      );
    console.error(
      'pis agent: kommandot misslyckades. Kontrollera --help, lokal profil/filbehörigheter, serveranslutning och registrering. Vid SSH: kontrollera OpenSSH, nyckelinloggning och verifierad värdnyckel på klientvärden. Kör pis --connect för en ny godkänd kodanslutning. Efter ett osäkert registreringsutfall kan GUI-posten behöva återkallas först. Kontrollera projekt/lås på värden vid start- eller stoppfel. Inga råa fel eller nycklar skrivs ut.',
    );
    process.exitCode = 1;
  });
