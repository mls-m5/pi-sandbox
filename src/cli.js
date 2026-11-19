import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Store } from './store.js';
import { pruneImages } from './prune.js';
import { unlockLocks } from './locks.js';
import {
  updatesAction,
  scheduleUpdates,
  readUpdateState,
  updateSourceKey,
  managedPlan,
} from './updates.js';
import {
  getCodexUsage,
  hasCodexCredential,
  importCodexCredential,
  loginCodex,
  logoutCodex,
  codexAccountName,
  readCodexAccountsPolicy,
  codexAccountsStatus,
  useCodexAccount,
  setCodexAutoSwitch,
  renameCodexAccount,
} from './codex-auth.js';
import {
  apiProfileStatus,
  promptApiProfile,
  logoutApiProfile,
  readApiProfile,
} from './api-auth.js';
import { validate } from './config.js';
import {
  CLAUDE_VERSION,
  claudeCommand,
  claudeNeedsLogin,
  loginClaude,
  logoutClaudeToken,
  readClaudeToken,
  removeLegacyClaudeCredentials,
} from './claude-code.js';
import { readTerminalLine } from './terminal-input.js';
import { forgetProject } from './forget.js';
import { readClaudeUsage } from './claude-usage.js';
import {
  CONTAINER_HOME,
  BASE_IMAGE,
  PI_VERSION,
  imagePlan,
  inspectPodman,
  launch,
  piCommand,
} from './container.js';
import { assert, directory, readJson, run, splitCommand, within, writeJson } from './util.js';

export const HELP = `pis — project-scoped Pi sandbox (Linux / rootless Podman)

Usage:
  pis --server [--port PORT] [--agents 1..8] # local dummy web UI by default
  pis --server --project NAME [--project OTHER] # experimental real Pi projects
  pis --server --diagnostics         # safe request metadata; no chat/auth payloads
  pis --server --help                # server startup options
  pis --server --standalone          # private persistent registry, no local agents
  pis --connect                     # request code approval for this local project
  pis --connect --allow-web-git     # opt in to reviewed exact-commit host pushes
  pis --connect --help               # saved server/overrides and advanced commands
  pis --forward ssh://[USER@]HOST    # Browser link via SSH; defaults 22/43128
  pis --forward --help              # Ports, known hosts and shutdown details
  pis [--project ID_OR_NAME] [--agent pi|claude] [--fresh] [-- AGENT_ARGS...]
  pis [--project ID_OR_NAME] --claude [-- CLAUDE_ARGS...] # same as --agent claude
  pis [--project ID_OR_NAME] --wait-codex # wait for quota, resume saved Pi task
  pis [--project ID_OR_NAME] [--fresh] --auto-wait-codex [-- PI_ARGS...]
  pis --login claude                 # global Claude subscription token (setup-token)
  pis --logout claude                # remove the saved Claude token (not revoked)
  pis --logout-claude                # also removes this project's old per-project copies
  pis [--project ID_OR_NAME] --bash
  pis [--project ID_OR_NAME] --exec -- PROGRAM [ARGS...]
  pis --new [--name NAME] [--from PROJECT]  # --from copies another project's settings
  pis --list
  pis --relocate ID_OR_NAME
  pis --forget ID_OR_NAME           # delete a project's registration, sessions and image tags
  pis [--project ID_OR_NAME] --edit | --check | --show | --build | --rebuild
  pis [--project ID_OR_NAME] --rebuild-defaults
  pis [--project ID_OR_NAME] --extensions-list
  pis [--project ID_OR_NAME] --updates on|all|off|status|check|rollback
  pis --doctor
  pis --prune [--dry-run]           # old pis images only; no project data
  pis [--project ID_OR_NAME] --unlock [--dry-run] # recover only proven stale locks
  pis --login-codex [--codex-account NAME] # add/re-authenticate a host profile
  pis --import-codex FILE [--codex-account NAME]
  pis --logout-codex [--codex-account NAME] # remove only that local profile
  pis --codex-usage [--codex-account NAME] # sanitized quota, no auto-switch
  pis --claude-usage                 # cached Claude 5h/7d usage seen by the proxy
  pis --codex-accounts               # aliases, active account, explicit pool
  pis --codex-use NAME               # change live proxies' subsequent requests
  pis --codex-rename NEW [--codex-account OLD] # rename without signing in again
  pis --codex-auto-switch off|on|NAME,NAME # opt-in quota-confirmed switching
  pis --login-mistral               # global Mistral API-key profile
  pis --logout-mistral
  pis --login openai|berget|mistral|custom|ollama|claude
  pis --logout openai|berget|mistral|custom|ollama|claude
  pis --login-status

--server or --connect must be the first argument. It starts the host loopback web server;
the server itself is NOT sandboxed. Real Pi agents retain their Podman sandbox.
Without --project it starts only token-free dummies; real Pi prompts can spend
model quota/API credits. Install optional web dependencies first (from checkout):
  npm --prefix web ci --ignore-scripts --omit=optional --no-audit --no-fund
--server --diagnostics traces bounded fixed error codes and request references.
Share only lines prefixed "pis web diagnostic:" or the GUI diagnostic codes,
not full state/log folders or the separately displayed generated password.
At the server password prompt, Enter generates a random password displayed once
in the terminal (can enter terminal/log captures); a supplied password stays hidden.
The launcher selects supported Node or uses npm-provided Node 24 (may download).
No public listening, remote host approvals or production quota-auto in web/RPC.

By default runs pi --tui-mode regular --continue; --fresh starts without continuation (but keeps regular TUI mode). Explicit Pi TUI/session options override defaults.
--wait-codex polls host usage before starting Pi, then sends a continuation
prompt to the latest saved session (uses model quota). No --fresh or trailing args.
--wait-codex alone does not monitor a running session. Ctrl-C cancels startup wait.
--auto-wait-codex monitors terminal Pi sessions: after a quota-like model failure,
the host must confirm exhaustion, then waits and continues the SAME session.
Escape, new input/session/model changes or /codex-auto off cancel pending resume.
Auto mode needs extensions and saved sessions; print/JSON/RPC are unsupported.
Agent arguments belong after --. Explicit Pi session selectors override continuation.
Claude starts a new session by default; use --claude -- --continue to resume.
--login claude runs official host "claude setup-token" (~/.local/bin/claude or
PIS_CLAUDE_BIN) and saves the subscription token on the host for all projects.
Claude containers get only a placeholder and a private Unix socket; the host proxy
adds the token to model calls. API keys (per-token billing) are refused.
--new registers the current directory; it does not start a conversation.
--edit uses $VISUAL, $EDITOR, or vim and saves only valid JSON configuration.
--show prints effective settings and mounts without credential values.
--rebuild disables build cache. Runtime containers are disposable (--rm).
--rebuild-defaults explicitly adds missing default Pi extensions (even to []),
preserves custom extensions and existing version pins, then rebuilds without cache.
It does not reset credentials, mounts, apt packages or other explicit choices.
Run on the host; no agent/model starts. Added sources remain saved if build fails.
Old pis images are cleaned in the background after builds by default.
--prune previews with --dry-run; keeps current/previous, recent and used images.
PIS_AUTO_PRUNE=0 disables automatic cleanup; project data is never pruned.
--unlock checks registry/prune-worker/Codex-auth locks and current project/update locks on the host.
Live/unknown owners and project containers are never force-stopped or unlocked.
--updates on enables daily background Pi patch/unpinned npm image checks
(and retains any prior 'all' pin-movement choice);
--updates all also opts exact npm pins into compatible updates. No sources are rewritten.
Checked candidates activate only on later launches. Off freezes the active release.
Check prepares a candidate now (may build); rollback switches images and disables updates.
Git/state-installed plugins and Claude updates are not managed. PIS_AUTO_UPDATE=0
suppresses background checks/activation. --rebuild rebuilds the declared baseline.

Storage: $PIS_HOME, otherwise $XDG_DATA_HOME/pis or ~/.local/share/pis.
New projects use the global host Codex OAuth proxy. Existing projects are unchanged.
Run --login-codex (or --import-codex ~/.pi/agent/auth.json / ~/.codex/auth.json) once;
the selected sign-in is shared by every Codex project under this PIS_HOME.
Without --codex-account, login/import/logout/usage/rename address the selected profile
(legacy sign-in is named default). Adding another profile does not switch it.
Auto-switch on snapshots currently saved profiles; newly added accounts are NOT
joined automatically. Prefer an explicit ordered NAME,NAME pool. Only enroll
accounts authorized to receive the same project/history. No API-key fallback,
no blind upstream replay, and no switching on auth/network/ordinary 429 errors.

Codex examples — run in a HOST terminal, not inside Pi or pis --bash:
  # Add a DIFFERENT Codex account under the local alias extra:
  pis --login-codex --codex-account extra
  # List saved aliases, the selected account and the automatic pool:
  pis --codex-accounts
  # Switch manually (subsequent requests in live Codex proxies):
  pis --codex-use extra
  # Switch back to the original account:
  pis --codex-use default
  # Explicitly enable automatic switching between these accounts:
  pis --codex-auto-switch default,extra

Use a private browser window/session if login otherwise selects your first account.
Replace default above if your original account has another alias. An alias alone
creates no extra quota. Automatic switching is OFF by default; merely adding a
login does not enable it or add that account to an existing pool.
Manual selection affects subsequent requests across Codex projects in this
PIS_HOME; an in-flight request keeps its original account. It does not require
automatic switching to be enabled. Selecting outside the automatic pool stays
manual until you select a pool member again; a selected pool member can still
switch automatically when its quota is exhausted. Disable that policy with:
  pis --codex-auto-switch off
Automatic switching requires confirmed exhausted quota AND verified available quota on
another enrolled account. The selection/pool is global for Codex projects in the
same PIS_HOME; both accounts must be authorized for the same prompts/history/tools.

Account switching is NOT automatic resumption of an already stopped chat.
For automatic continuation in terminal Pi, opt in separately when starting it:
  pis --auto-wait-codex
This requires saved sessions/extensions and host-confirmed exhaustion/availability.
It sends one continuation prompt (uses model quota), not a replay of the original
prompt/tools. Web/RPC mode does NOT support --auto-wait-codex.

API providers: run --login openai|berget|mistral|custom|ollama, then set
credentials.proxy.provider to that provider. Host login profiles are selected
automatically; no keyEnv/environment-key source is supported.
Mistral also accepts --login-mistral. Custom endpoints use --login custom.
Only an explicit trusted host profile can select a custom destination.
--login ollama stores a keyless loopback HTTP /v1 profile on the agent host;
enter installed tool-capable model IDs and actual configured context limits.
No live connection/model test, LAN access or public-custom URL relaxation.
Never run as root. Mounted files are accessible to the sandbox.
`;

// Tab-separated: ID, name, root (+ [missing]), network ('-' when none). Columns are only appended.
export function formatProjectList(projects, exists = fs.existsSync) {
  return projects.length
    ? projects
        .map(
          (p) =>
            `${p.id}\t${p.name || '-'}\t${p.root}${exists(p.root) ? '' : ' [missing]'}\t${p.network || '-'}`,
        )
        .join('\n')
    : 'No registered projects. Run pis --new in a project directory.';
}

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
    if (
      [
        '--project',
        '--agent',
        '--name',
        '--from',
        '--codex-account',
        '--codex-use',
        '--codex-rename',
        '--codex-auto-switch',
        '--relocate',
        '--forget',
        '--import-codex',
        '--login',
        '--logout',
        '--updates',
      ].includes(key)
    ) {
      const value = equals === -1 ? wrapper[++i] : token.slice(equals + 1);
      assert(value && !value.startsWith('-'), `${key} requires a value.`);
      if (
        [
          '--relocate',
          '--forget',
          '--import-codex',
          '--login',
          '--logout',
          '--updates',
          '--codex-use',
          '--codex-rename',
          '--codex-auto-switch',
        ].includes(key)
      ) {
        assert(!action, 'Choose only one management action.');
        action = key.slice(2);
        options.target = value;
      } else {
        const property = key === '--codex-account' ? 'codexAccount' : key.slice(2);
        assert(
          options[property] === undefined,
          `Repeated option: ${key === '--agent' ? '--claude/--agent' : key}`,
        );
        options[property] = value;
      }
    } else if (key === '--dry-run' && equals === -1) {
      assert(!options.dryRun, 'Repeated option: --dry-run');
      options.dryRun = true;
    } else if (key === '--auto-wait-codex' && equals === -1) {
      assert(!options.autoWaitCodex, 'Repeated option: --auto-wait-codex');
      options.autoWaitCodex = true;
    } else if (key === '--wait-codex' && equals === -1) {
      assert(!options.waitCodex, 'Repeated option: --wait-codex');
      options.waitCodex = true;
    } else if (key === '--claude' && equals === -1) {
      assert(options.agent === undefined, 'Repeated option: --claude/--agent');
      options.agent = 'claude';
    } else if (key === '--fresh' && equals === -1) {
      assert(!options.fresh, 'Repeated option: --fresh');
      options.fresh = true;
    } else if (['--bash', '--exec'].includes(key) && equals === -1) {
      assert(!mode, 'Choose either --bash or --exec.');
      mode = key.slice(2);
    } else if (
      [
        '--new',
        '--list',
        '--edit',
        '--check',
        '--show',
        '--build',
        '--rebuild',
        '--rebuild-defaults',
        '--extensions-list',
        '--doctor',
        '--prune',
        '--unlock',
        '--login-codex',
        '--logout-codex',
        '--login-claude',
        '--logout-claude',
        '--login-mistral',
        '--logout-mistral',
        '--codex-usage',
        '--claude-usage',
        '--codex-accounts',
        '--login-status',
        '--help',
        '-h',
        '--version',
      ].includes(key) &&
      equals === -1
    ) {
      assert(!action, 'Choose only one management action.');
      action = key === '-h' ? 'help' : key.slice(2);
    } else
      throw new Error(
        `Unknown pis option: ${token}. Pass Pi/Claude arguments after --; see pis --help.`,
      );
  }
  options.action = action || 'run';
  options.mode = mode || 'pi';
  assert(
    action !== 'updates' ||
      ['on', 'all', 'off', 'status', 'check', 'rollback'].includes(options.target),
    'Use --updates on|all|off|status|check|rollback.',
  );
  if (options.codexAccount !== undefined) {
    codexAccountName(options.codexAccount);
    assert(
      ['login-codex', 'import-codex', 'logout-codex', 'codex-usage', 'codex-rename'].includes(
        action,
      ),
      '--codex-account is only valid with Codex login/import/logout/usage/rename. Use --codex-use to select globally.',
    );
  }
  if (['codex-use', 'codex-rename'].includes(action)) codexAccountName(options.target);
  if (action === 'codex-auto-switch' && !['on', 'off'].includes(options.target)) {
    const names = options.target.split(',');
    names.forEach(codexAccountName);
    assert(
      names.length >= 2 && names.length <= 16 && new Set(names).size === names.length,
      'Choose 2–16 distinct Codex profile names, or on/off.',
    );
  }
  assert(
    options.agent === undefined || ['pi', 'claude'].includes(options.agent),
    '--agent must be pi or claude.',
  );
  assert(
    !options.agent || !action || ['show', 'build', 'rebuild', 'check'].includes(action),
    '--agent is only valid for launches, --show, --check, --build or --rebuild. Set project.agent via --edit for a persistent choice.',
  );
  assert(
    !options.autoWaitCodex || (!action && !mode && (!options.agent || options.agent === 'pi')),
    '--auto-wait-codex is only valid for a normal Pi launch.',
  );
  assert(
    !options.waitCodex ||
      (!action &&
        !mode &&
        !options.fresh &&
        !args.length &&
        (!options.agent || options.agent === 'pi')),
    '--wait-codex is only valid for a normal Pi launch without --fresh or trailing arguments.',
  );
  assert(!options.name || action === 'new', '--name is only valid with --new.');
  assert(!options.from || action === 'new', '--from is only valid with --new.');
  assert(
    !options.dryRun || ['prune', 'unlock'].includes(action),
    '--dry-run is only valid with --prune or --unlock.',
  );
  assert(!mode || !action, 'Shell/exec modes cannot be combined with management actions.');
  assert(!options.fresh || (!action && !mode), '--fresh is only valid when running an agent.');
  assert(
    !args.length || (!action && mode !== 'bash'),
    'Trailing arguments are only valid for an agent or --exec.',
  );
  assert(mode !== 'exec' || args.length > 0, '--exec requires a command after --.');
  assert(
    !options.project ||
      ![
        'new',
        'list',
        'relocate',
        'forget',
        'doctor',
        'prune',
        'login-codex',
        'logout-codex',
        'login-mistral',
        'logout-mistral',
        'login-claude',
        'codex-usage',
        'claude-usage',
        'codex-accounts',
        'codex-use',
        'codex-rename',
        'codex-auto-switch',
        'import-codex',
        'login',
        'logout',
        'login-status',
        'help',
        'version',
      ].includes(action),
    '--project is not valid with this action.',
  );
  return options;
}

async function edit(store, original) {
  const [editor, ...editorArgs] = splitCommand(process.env.VISUAL || process.env.EDITOR || 'vim');
  const draft = path.join(
    store.projectDir(original.id),
    `edit-${randomBytes(6).toString('hex')}.json`,
  );
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
        if (!process.stdin.isTTY || !process.stdout.isTTY)
          throw new Error(`Configuration was not saved. Draft retained at ${draft}`);
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        let response;
        try {
          response = await prompt.question('Reopen draft, discard, or keep draft? [r/d/k] ');
        } finally {
          prompt.close();
        }
        if (response.toLowerCase() === 'r') continue;
        if (response.toLowerCase() === 'd') {
          fs.rmSync(draft, { force: true });
          return 1;
        }
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
  if (options.action === 'help') {
    console.log(HELP);
    return 0;
  }
  if (options.action === 'version') {
    console.log('pis 0.1.0');
    return 0;
  }
  assert(process.platform === 'linux', 'pis supports Linux only.');
  assert(process.getuid() !== 0, 'Run pis as your normal user, not root or sudo.');
  const store = new Store();
  const cwd = directory(process.cwd());
  if (options.action === 'unlock')
    return unlockLocks(store, { cwd, project: options.project, dryRun: Boolean(options.dryRun) });
  if (options.action === 'prune') {
    const result = await pruneImages(store, { dryRun: Boolean(options.dryRun) });
    console.log(JSON.stringify({ dryRun: Boolean(options.dryRun), ...result }, null, 2));
    return result.failed.length ? 1 : 0;
  }
  if (
    (options.action === 'login' && options.target === 'claude') ||
    options.action === 'login-claude'
  ) {
    await loginClaude(store);
    console.log(
      'Saved the Claude subscription token on the host (shared by all Claude projects; never mounted).\nStart Claude Code with pis --claude, or set "agent": "claude" via pis --edit.',
    );
    return 0;
  }
  if (options.action === 'logout' && options.target === 'claude') {
    await logoutClaudeToken(store);
    console.log('Removed the saved Claude token from this host. It is not revoked at Anthropic.');
    return 0;
  }
  if (options.action === 'login' || options.action === 'login-mistral') {
    const provider = options.action === 'login-mistral' ? 'mistral' : options.target;
    await promptApiProfile(store, provider);
    console.log(
      `Saved host ${provider} ${provider === 'ollama' ? 'local model' : 'API-key'} profile. Set credentials.proxy.provider to ${provider} in pis --edit; its login profile is selected automatically. Remove any obsolete keyEnv field.`,
    );
    return 0;
  }
  if (options.action === 'logout' || options.action === 'logout-mistral') {
    const provider = options.action === 'logout-mistral' ? 'mistral' : options.target;
    await logoutApiProfile(store, provider);
    console.log(
      provider === 'ollama'
        ? 'Removed local Ollama profile; the Ollama server and installed models are unchanged.'
        : `Removed host ${provider} API-key profile (the key is not revoked at the provider).`,
    );
    return 0;
  }
  if (options.action === 'login-status') {
    const codexPresent = hasCodexCredential(store);
    console.log(
      JSON.stringify(
        [
          ...apiProfileStatus(store),
          {
            provider: 'claude',
            profilePresent: Boolean(readClaudeToken(store)),
            credentialPresent: Boolean(readClaudeToken(store)),
          },
          {
            provider: 'openai-codex',
            profilePresent: codexPresent,
            credentialPresent: codexPresent,
            ...codexAccountsStatus(store),
          },
        ],
        null,
        2,
      ),
    );
    return 0;
  }
  if (options.action === 'codex-accounts') {
    console.log(JSON.stringify(codexAccountsStatus(store), null, 2));
    return 0;
  }
  if (options.action === 'codex-use') {
    await useCodexAccount(store, options.target);
    console.log(
      `Selected host Codex profile ${options.target}. Subsequent requests in all Codex projects use it; in-flight requests are unchanged.`,
    );
    return 0;
  }
  if (options.action === 'codex-rename') {
    console.log(
      JSON.stringify(
        await renameCodexAccount(
          store,
          options.codexAccount || readCodexAccountsPolicy(store).active,
          options.target,
        ),
        null,
        2,
      ),
    );
    return 0;
  }
  if (options.action === 'codex-auto-switch') {
    console.log(JSON.stringify(await setCodexAutoSwitch(store, options.target), null, 2));
    return 0;
  }
  if (options.action === 'login-codex') {
    const account = options.codexAccount || readCodexAccountsPolicy(store).active;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
      await loginCodex(store, { signal: controller.signal, account });
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
    console.log(
      `Codex sign-in saved as host profile ${account}. Use --codex-accounts to list, --codex-use NAME to select. Adding a profile does not expand an automatic pool.`,
    );
    return 0;
  }
  if (options.action === 'import-codex') {
    await importCodexCredential(store, options.target, { account: options.codexAccount });
    console.log(
      'Codex OAuth sign-in copied to private host storage. Original file unchanged.\nAvoid concurrent token refresh by the original client; a dedicated pis --login-codex session is recommended.',
    );
    return 0;
  }
  if (options.action === 'logout-codex') {
    const account = options.codexAccount || readCodexAccountsPolicy(store).active;
    await logoutCodex(store, { account });
    console.log(
      `Removed local Codex profile ${account}; other profiles remain. Tokens are not revoked. If it was active, select another profile explicitly with --codex-use.`,
    );
    return 0;
  }
  if (options.action === 'claude-usage') {
    console.log(JSON.stringify(readClaudeUsage(store)));
    return 0;
  }
  if (options.action === 'codex-usage') {
    console.log(JSON.stringify(await getCodexUsage(store, { account: options.codexAccount })));
    return 0;
  }
  if (options.action === 'doctor') {
    const info = inspectPodman();
    console.log(
      `Node: ${process.version}\nPodman: ${info.version.Version} (local, rootless)\nUID:GID: ${process.getuid()}:${process.getgid()}\nRuntime: ${info.host.ociRuntime?.name}\nCgroups: ${info.host.cgroupVersion}\nSELinux: ${info.host.security.selinuxEnabled ? 'enabled (shared project labels)' : 'disabled on host'}\nStorage: ${store.root}\nBase image: ${BASE_IMAGE}\nPi: ${PI_VERSION}\nRootless Podman is operational.`,
    );
    return 0;
  }
  if (options.action === 'new') {
    const config = await store.register(cwd, options.name, options.from);
    console.log(
      `Registered ${config.id}${config.name ? ` (${config.name})` : ''}: ${config.root}\nConfiguration: ${store.configPath(config.id)}${options.from ? `\nSettings copied from ${options.from} (image, mounts, credentials, extensions, updates, agent); sessions and state are not copied. The first start builds the image.` : ''}\nRun pis --edit to customize, then pis to start.`,
    );
    return 0;
  }
  if (options.action === 'list') {
    const all = await store.lock(async () => {
      const all = store.all();
      store.index(all);
      return all;
    });
    console.log(formatProjectList(all));
    return 0;
  }
  if (options.action === 'forget') {
    assert(
      process.stdin.isTTY && process.stdout.isTTY,
      'pis --forget needs an interactive terminal for confirmation.',
    );
    const result = await forgetProject(store, options.target, {
      confirm: async ({ id, name, root, storage }) => {
        console.log(
          `This permanently deletes the pis registration, configuration and ALL sandbox state (sessions, history, backups) of:\n  ${id}${name ? ` (${name})` : ''}\n  ${storage}\nThe project source folder ${root}, its mounts and host credentials are NOT touched.`,
        );
        const answer = await readTerminalLine({
          output: process.stdout,
          prompt: `Type the project ID (${id}) to confirm, anything else cancels: `,
          hidden: false,
          cancelError: 'Cancelled; nothing was removed.',
        });
        return answer.trim() === id;
      },
    });
    console.log(
      `Forgot ${result.id}${result.name ? ` (${result.name})` : ''}. Source folder untouched.\n` +
        (result.images.checked
          ? `Image tags removed: ${result.images.removed.length}${result.images.failed.length ? `; could not remove ${result.images.failed.length} (in use?)` : ''}.`
          : 'Podman was not available; remove any localhost/pis-' + result.id + ':* images manually if wanted.'),
    );
    return 0;
  }
  if (options.action === 'relocate') {
    const config = await store.relocate(options.target, cwd);
    console.log(`Relocated ${config.id}: ${config.root}`);
    return 0;
  }
  const selected = store.select(cwd, options.project);
  let config = await store.refresh(selected.id);
  if (options.action === 'updates') {
    const result = await updatesAction(store, config, options.target);
    console.log(JSON.stringify(result, null, 2));
    if (['on', 'all'].includes(options.target))
      scheduleUpdates(store, store.load(config.id, false));
    return result.failed ? 1 : 0;
  }
  if (options.action === 'logout-claude') {
    await logoutClaudeToken(store);
    const removed = await removeLegacyClaudeCredentials(store, config.id);
    console.log(
      `Removed the saved host Claude token${removed ? ` and ${removed} old per-project credential file(s)` : ''}. Sessions remain; tokens are not revoked at Anthropic.`,
    );
    return 0;
  }
  if (options.agent) config = { ...config, agent: options.agent };
  if (options.action === 'edit') return edit(store, config);
  validate(config, { storage: store.root });
  if (options.action === 'extensions-list') {
    console.log(
      config.extensions.length
        ? `Image extension install sources:\n${config.extensions.join('\n')}`
        : 'No image extensions configured (extensions: []).',
    );
    return 0;
  }
  if (options.action === 'check') {
    console.log(`Valid: ${store.configPath(config.id)}`);
    return 0;
  }
  if (options.action === 'show') {
    let plan = imagePlan(config),
      managedUpdate = null;
    try {
      const state = readUpdateState(store, config.id);
      if (config.agent === 'pi' && state?.sourceKey === updateSourceKey(config)) {
        plan = managedPlan(config, state.active);
        managedUpdate = {
          active: state.active,
          candidate: state.candidate,
          lastError: state.lastError,
        };
      }
    } catch {
      managedUpdate = { status: 'invalid-state', fallback: 'declared-image' };
    }
    const workdir = within(config.root, cwd) ? cwd : config.root;
    const isClaude = config.agent === 'claude';
    const isCodex = !isClaude && config.credentials.proxy?.provider === 'openai-codex';
    const credentialVariables = [];
    const credentialSource = isClaude
      ? { kind: 'host-oauth-proxy', provider: 'claude', present: Boolean(readClaudeToken(store)) }
      : isCodex
        ? { kind: 'host-oauth', provider: 'openai-codex', present: hasCodexCredential(store) }
        : config.credentials.proxy
          ? {
              kind:
                config.credentials.proxy.provider === 'ollama'
                  ? 'host-local-model'
                  : 'host-api-key',
              provider: config.credentials.proxy.provider,
              present: Boolean(readApiProfile(store, config.credentials.proxy.provider)),
            }
          : undefined;
    console.log(
      JSON.stringify(
        {
          config,
          configurationFile: store.configPath(config.id),
          image: plan.image,
          piVersion: plan.piVersion,
          managedUpdate,
          workingDirectory: workdir,
          containerHome: CONTAINER_HOME,
          agentCommand: isClaude ? claudeCommand() : piCommand(),
          piCommand: piCommand(),
          claudeVersion: CLAUDE_VERSION,
          mounts: [
            { source: config.root, target: config.root, access: 'read-write' },
            ...config.mounts.map((m) => ({
              source: m.source,
              target: m.source,
              access: m.access || 'read-only',
            })),
          ],
          credentialVariables,
          credentialSource,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (
    config.agent === 'claude' &&
    options.action === 'run' &&
    options.mode === 'pi' &&
    claudeNeedsLogin(options.args) &&
    !readClaudeToken(store)
  ) {
    assert(
      process.stdin.isTTY && process.stdout.isTTY,
      'No Claude login saved. Run pis --login claude on the host.',
    );
    const answer = await readTerminalLine({
      output: process.stdout,
      prompt: 'No Claude login saved on this host. Log in now? [Y/n]: ',
      hidden: false,
      cancelError: 'Login cancelled.',
    });
    assert(answer.toLowerCase() !== 'n', 'No Claude login saved. Run pis --login claude.');
    await loginClaude(store);
  }
  return launch(store, config, {
    ...options,
    cwd,
    rebuild: ['rebuild', 'rebuild-defaults'].includes(options.action),
    addDefaultExtensions: options.action === 'rebuild-defaults',
    buildOnly: ['build', 'rebuild', 'rebuild-defaults'].includes(options.action),
  });
}
