import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Store } from './store.js';
import { pruneImages } from './prune.js';
import { getCodexUsage, hasCodexCredential, importCodexCredential, loginCodex, logoutCodex } from './codex-auth.js';
import { apiProfileStatus, promptApiProfile, logoutApiProfile, readApiProfile } from './api-auth.js';
import { validate } from './config.js';
import { CLAUDE_VERSION, claudeCommand, loginClaude, logoutClaude } from './claude-code.js';
import { CONTAINER_HOME, BASE_IMAGE, PI_VERSION, imagePlan, inspectPodman, launch, piCommand } from './container.js';
import { assert, directory, readJson, run, splitCommand, within, writeJson } from './util.js';

export const HELP = `pis — project-scoped Pi sandbox (Linux / rootless Podman)

Usage:
  pis [--project ID_OR_NAME] [--agent pi|claude] [--fresh] [-- AGENT_ARGS...]
  pis [--project ID_OR_NAME] --wait-codex # wait for quota, resume saved Pi task
  pis [--project ID_OR_NAME] [--fresh] --auto-wait-codex [-- PI_ARGS...]
  pis [--project ID_OR_NAME] --login-claude  # official host login, project-scoped
  pis [--project ID_OR_NAME] --logout-claude # remove local login copies
  pis [--project ID_OR_NAME] --bash
  pis [--project ID_OR_NAME] --exec -- PROGRAM [ARGS...]
  pis --new [--name NAME]
  pis --list
  pis --relocate ID_OR_NAME
  pis [--project ID_OR_NAME] --edit | --check | --show | --build | --rebuild
  pis [--project ID_OR_NAME] --extensions-list
  pis --doctor
  pis --prune [--dry-run]           # old pis images only; no project data
  pis --login-codex                 # global host sign-in
  pis --import-codex FILE            # global host sign-in
  pis --logout-codex                 # remove global host sign-in
  pis --codex-usage                  # print sanitized global Codex quotas
  pis --login-mistral               # global Mistral API-key profile
  pis --logout-mistral
  pis --login openai|berget|mistral|custom
  pis --logout openai|berget|mistral|custom
  pis --login-status

By default runs pi --tui-mode regular --continue; --fresh starts without continuation (but keeps regular TUI mode). Explicit Pi TUI/session options override defaults.
--wait-codex polls host usage before starting Pi, then sends a continuation
prompt to the latest saved session (uses model quota). No --fresh or trailing args.
--wait-codex alone does not monitor a running session. Ctrl-C cancels startup wait.
--auto-wait-codex monitors terminal Pi sessions: after a quota-like model failure,
the host must confirm exhaustion, then waits and continues the SAME session.
Escape, new input/session/model changes or /codex-auto off cancel pending resume.
Auto mode needs extensions and saved sessions; print/JSON/RPC are unsupported.
Agent arguments belong after --. Explicit Pi session selectors override continuation.
Claude starts a new session by default; use --agent claude -- --continue to resume.
Claude uses separate writable state containing REAL tokens, not the Pi proxy.
--login-claude requires official host Claude Code at ~/.local/bin/claude,
or PIS_CLAUDE_BIN set to its absolute executable path. No host home is mounted.
--new registers the current directory; it does not start a conversation.
--edit uses $VISUAL, $EDITOR, or vim and saves only valid JSON configuration.
--show prints effective settings and mounts without credential values.
--rebuild disables build cache. Runtime containers are disposable (--rm).
Old pis images are cleaned in the background after builds by default.
--prune previews with --dry-run; keeps current/previous, recent and used images.
PIS_AUTO_PRUNE=0 disables automatic cleanup; project data is never pruned.

Storage: $PIS_HOME, otherwise $XDG_DATA_HOME/pis or ~/.local/share/pis.
New projects use the global host Codex OAuth proxy. Existing projects are unchanged.
Run --login-codex (or --import-codex ~/.pi/agent/auth.json / ~/.codex/auth.json) once;
the sign-in is shared by every project under this PIS_HOME.
Berget: set credentials.proxy.provider=berget, and use BERGET_API_KEY on the host,
or run --login berget and set credentials.proxy.profile=berget (remove keyEnv).
Mistral: --login-mistral stores an API key; set provider=mistral, profile=mistral.
Custom endpoints: run --login custom, then set provider=custom and profile=custom.
Only an explicit trusted host profile can select a custom destination.
Never run as root. Mounted files and Claude Code's copied login tokens are accessible to the sandbox.
`;

export function parse(argv) {
  const separator = argv.indexOf('--');
  const wrapper = separator === -1 ? argv : argv.slice(0, separator);
  const args = separator === -1 ? [] : argv.slice(separator + 1);
  const options = { action: 'run', mode: 'pi', fresh: false, args };
  let action, mode;
  for (let i = 0; i < wrapper.length; i++) {
    const token = wrapper[i];
    const equals = token.indexOf('=');
    const key = equals === -1 ? token : token.slice(0, equals);
    if (['--project', '--agent', '--name', '--relocate', '--import-codex', '--login', '--logout'].includes(key)) {
      const value = equals === -1 ? wrapper[++i] : token.slice(equals + 1);
      assert(value && !value.startsWith('-'), `${key} requires a value.`);
      if (['--relocate', '--import-codex', '--login', '--logout'].includes(key)) {
        assert(!action, 'Choose only one management action.');
        action = key.slice(2); options.target = value;
      } else {
        const property = key.slice(2);
        assert(options[property] === undefined, `Repeated option: ${key}`);
        options[property] = value;
      }
    } else if (key === '--dry-run' && equals === -1) {
      assert(!options.dryRun, 'Repeated option: --dry-run'); options.dryRun = true;
    } else if (key === '--auto-wait-codex' && equals === -1) {
      assert(!options.autoWaitCodex, 'Repeated option: --auto-wait-codex'); options.autoWaitCodex = true;
    } else if (key === '--wait-codex' && equals === -1) {
      assert(!options.waitCodex, 'Repeated option: --wait-codex'); options.waitCodex = true;
    } else if (key === '--fresh' && equals === -1) {
      assert(!options.fresh, 'Repeated option: --fresh'); options.fresh = true;
    } else if (['--bash', '--exec'].includes(key) && equals === -1) {
      assert(!mode, 'Choose either --bash or --exec.'); mode = key.slice(2);
    } else if (['--new', '--list', '--edit', '--check', '--show', '--build', '--rebuild', '--extensions-list', '--doctor', '--prune', '--login-codex', '--logout-codex', '--login-claude', '--logout-claude', '--login-mistral', '--logout-mistral', '--codex-usage', '--login-status', '--help', '-h', '--version'].includes(key) && equals === -1) {
      assert(!action, 'Choose only one management action.'); action = key === '-h' ? 'help' : key.slice(2);
    } else throw new Error(`Unknown pis option: ${token}. Pass Pi/Claude arguments after --; see pis --help.`);
  }
  options.action = action || 'run';
  options.mode = mode || 'pi';
  assert(options.agent === undefined || ['pi', 'claude'].includes(options.agent), '--agent must be pi or claude.');
  assert(!options.agent || !action || ['show', 'build', 'rebuild', 'check'].includes(action), '--agent is only valid for launches, --show, --check, --build or --rebuild. Set project.agent via --edit for a persistent choice.');
  assert(!options.autoWaitCodex || (!action && !mode && (!options.agent || options.agent === 'pi')), '--auto-wait-codex is only valid for a normal Pi launch.');
  assert(!options.waitCodex || (!action && !mode && !options.fresh && !args.length && (!options.agent || options.agent === 'pi')), '--wait-codex is only valid for a normal Pi launch without --fresh or trailing arguments.');
  assert(!options.name || action === 'new', '--name is only valid with --new.');
  assert(!options.dryRun || action === 'prune', '--dry-run is only valid with --prune.');
  assert(!mode || !action, 'Shell/exec modes cannot be combined with management actions.');
  assert(!options.fresh || (!action && !mode), '--fresh is only valid when running an agent.');
  assert(!args.length || (!action && mode !== 'bash'), 'Trailing arguments are only valid for an agent or --exec.');
  assert(mode !== 'exec' || args.length > 0, '--exec requires a command after --.');
  assert(!options.project || !['new', 'list', 'relocate', 'doctor', 'prune', 'login-codex', 'logout-codex', 'login-mistral', 'logout-mistral', 'codex-usage', 'import-codex', 'login', 'logout', 'login-status', 'help', 'version'].includes(action), '--project is not valid with this action.');
  return options;
}

async function edit(store, original) {
  const [editor, ...editorArgs] = splitCommand(process.env.VISUAL || process.env.EDITOR || 'vim');
  const draft = path.join(store.projectDir(original.id), `edit-${randomBytes(6).toString('hex')}.json`);
  writeJson(draft, original);
  let saved = false;
  try {
    while (true) {
      const code = await run(editor, [...editorArgs, draft]);
      assert(code === 0, `Editor exited with status ${code}. Draft retained at ${draft}`);
      try {
        const candidate = readJson(draft);
        await store.save(candidate, original);
        saved = true;
        console.log(`Saved ${store.configPath(original.id)}`);
        return 0;
      } catch (error) {
        console.error(`pis: ${error.message}`);
        if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`Configuration was not saved. Draft retained at ${draft}`);
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        let response;
        try { response = await prompt.question('Reopen draft, discard, or keep draft? [r/d/k] '); }
        finally { prompt.close(); }
        if (response.toLowerCase() === 'r') continue;
        if (response.toLowerCase() === 'd') { fs.rmSync(draft, { force: true }); return 1; }
        throw new Error(`Configuration was not saved. Draft retained at ${draft}`);
      }
    }
  } finally {
    if (saved) fs.rmSync(draft, { force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  const options = parse(argv);
  if (options.action === 'help') { console.log(HELP); return 0; }
  if (options.action === 'version') { console.log('pis 0.1.0'); return 0; }
  assert(process.platform === 'linux', 'pis supports Linux only.');
  assert(process.getuid() !== 0, 'Run pis as your normal user, not root or sudo.');
  const store = new Store();
  const cwd = directory(process.cwd());
  if (options.action === 'prune') {
    const result = await pruneImages(store, { dryRun: Boolean(options.dryRun) });
    console.log(JSON.stringify({ dryRun: Boolean(options.dryRun), ...result }, null, 2));
    return result.failed.length ? 1 : 0;
  }
  if (options.action === 'login' || options.action === 'login-mistral') {
    const provider = options.action === 'login-mistral' ? 'mistral' : options.target;
    await promptApiProfile(store, provider);
    console.log(`Saved host ${provider} API-key profile. Set credentials.proxy.provider and credentials.proxy.profile to ${provider} and remove keyEnv in pis --edit.`);
    return 0;
  }
  if (options.action === 'logout' || options.action === 'logout-mistral') {
    const provider = options.action === 'logout-mistral' ? 'mistral' : options.target;
    await logoutApiProfile(store, provider);
    console.log(`Removed host ${provider} API-key profile (the key is not revoked at the provider).`);
    return 0;
  }
  if (options.action === 'login-status') {
    const codexPresent = hasCodexCredential(store);
    console.log(JSON.stringify([...apiProfileStatus(store), { provider: 'openai-codex', profilePresent: codexPresent, credentialPresent: codexPresent }], null, 2));
    return 0;
  }
  if (options.action === 'login-codex') {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try { await loginCodex(store, { signal: controller.signal }); }
    finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
    console.log('Global Codex sign-in saved on the host. It is shared by all projects using the openai-codex proxy.');
    return 0;
  }
  if (options.action === 'import-codex') {
    await importCodexCredential(store, options.target);
    console.log('Codex OAuth sign-in copied to private host storage. Original file unchanged.\nAvoid concurrent token refresh by the original client; a dedicated pis --login-codex session is recommended.');
    return 0;
  }
  if (options.action === 'logout-codex') {
    await logoutCodex(store);
    console.log('Removed the shared host Codex sign-in. This does not revoke tokens at OpenAI.');
    return 0;
  }
  if (options.action === 'codex-usage') {
    console.log(JSON.stringify(await getCodexUsage(store)));
    return 0;
  }
  if (options.action === 'doctor') {
    const info = inspectPodman();
    console.log(`Node: ${process.version}\nPodman: ${info.version.Version} (local, rootless)\nUID:GID: ${process.getuid()}:${process.getgid()}\nRuntime: ${info.host.ociRuntime?.name}\nCgroups: ${info.host.cgroupVersion}\nSELinux: ${info.host.security.selinuxEnabled ? 'enabled (shared project labels)' : 'disabled on host'}\nStorage: ${store.root}\nBase image: ${BASE_IMAGE}\nPi: ${PI_VERSION}\nRootless Podman is operational.`);
    return 0;
  }
  if (options.action === 'new') {
    const config = await store.register(cwd, options.name);
    console.log(`Registered ${config.id}${config.name ? ` (${config.name})` : ''}: ${config.root}\nConfiguration: ${store.configPath(config.id)}\nRun pis --edit to customize, then pis to start.`);
    return 0;
  }
  if (options.action === 'list') {
    const all = await store.lock(async () => { const all = store.all(); store.index(all); return all; });
    console.log(all.length ? all.map(p => `${p.id}\t${p.name || '-'}\t${p.root}${fs.existsSync(p.root) ? '' : ' [missing]'}`).join('\n') : 'No registered projects. Run pis --new in a project directory.');
    return 0;
  }
  if (options.action === 'relocate') {
    const config = await store.relocate(options.target, cwd);
    console.log(`Relocated ${config.id}: ${config.root}`);
    return 0;
  }
  const selected = store.select(cwd, options.project);
  let config = await store.refresh(selected.id);
  if (options.action === 'login-claude') {
    assert(process.stdin.isTTY && process.stdout.isTTY, 'Run pis --login-claude interactively on the host.');
    await loginClaude(store, config);
    console.log('Claude subscription login copied to this project\'s writable Claude sandbox state. Real tokens are visible inside the Claude sandbox.\nThe host snapshot is not mounted. Tokens renewed in the sandbox are never copied back or overwritten at startup.\nStart with pis --agent claude; if login expires, stop the sandbox and run pis --login-claude again.');
    return 0;
  }
  if (options.action === 'logout-claude') {
    await logoutClaude(store, config.id);
    console.log('Removed this project\'s host snapshot and sandbox credential file. Sessions/backups remain; tokens are not revoked at Anthropic.');
    return 0;
  }
  if (options.agent) config = { ...config, agent: options.agent };
  if (options.action === 'edit') return edit(store, config);
  validate(config, { storage: store.root });
  if (options.action === 'extensions-list') {
    console.log(config.extensions.length ? `Image extension install sources:\n${config.extensions.join('\n')}` : 'No image extensions configured (extensions: []).');
    return 0;
  }
  if (options.action === 'check') { console.log(`Valid: ${store.configPath(config.id)}`); return 0; }
  if (options.action === 'show') {
    const plan = imagePlan(config);
    const workdir = within(config.root, cwd) ? cwd : config.root;
    const proxyKeyEnv = config.credentials.proxy?.keyEnv || (config.credentials.proxy?.provider === 'berget' ? 'BERGET_API_KEY' : config.credentials.proxy?.provider === 'mistral' ? 'MISTRAL_API_KEY' : 'OPENAI_API_KEY');
    const isClaude = config.agent === 'claude';
    const isCodex = !isClaude && config.credentials.proxy?.provider === 'openai-codex';
    const credentialVariables = !isClaude && config.credentials.proxy
      ? (isCodex || config.credentials.proxy.profile ? [] : [{ name: proxyKeyEnv, present: Boolean(process.env[proxyKeyEnv]), handling: 'host-proxy' }])
      : [];
    const credentialSource = isClaude ? { kind: 'sandbox-oauth-copy', provider: 'claude-code', warning: 'Real tokens are readable and writable inside the sandbox. Pi proxy is not used.' } : isCodex ? { kind: 'host-oauth', provider: 'openai-codex', present: hasCodexCredential(store) } : config.credentials.proxy?.profile ? { kind: 'host-api-key', provider: config.credentials.proxy.profile, present: Boolean(readApiProfile(store, config.credentials.proxy.profile)) } : undefined;
    console.log(JSON.stringify({ config, configurationFile: store.configPath(config.id), image: plan.image, workingDirectory: workdir, containerHome: CONTAINER_HOME, agentCommand: isClaude ? claudeCommand() : piCommand(), piCommand: piCommand(), claudeVersion: CLAUDE_VERSION, mounts: [{ source: config.root, target: config.root, access: 'read-write' }, ...config.mounts.map(m => ({ source: m.source, target: m.source, access: m.access || 'read-only' }))], credentialVariables, credentialSource }, null, 2));
    return 0;
  }
  return launch(store, config, { ...options, cwd, rebuild: options.action === 'rebuild', buildOnly: ['build', 'rebuild'].includes(options.action) });
}
