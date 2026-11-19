import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { assert, atomicWrite, directory, privateDir, run, within } from './util.js';
import { prepareProxy } from './proxy-runtime.js';
import {
  CODEX_RESUME_NOTICE,
  validateCodexWait,
  requireSavedPiSession,
  waitForCodexOnHost,
} from './codex-wait.js';
import { startCodexAutoServer, validateCodexAuto } from './codex-auto.js';
import {
  CLAUDE_PLACEHOLDER_TOKEN,
  CLAUDE_SANDBOX_BASE_URL,
  CLAUDE_SOCKET,
  claudeCommand,
  claudeHasSession,
  claudeNeedsLogin,
  claudeState,
  hasLegacyClaudeCredential,
  prepareClaudeProxy,
  claudeHostMcpConfig,
  readClaudeToken,
} from './claude-code.js';
import { schedulePrune } from './prune.js';
import { prepareGitPush, approveGitPush } from './git-push.js';
import {
  formatMessages,
  markDelivered,
  pendingMessages,
  startNetworkServer,
} from './network.js';
import { startAptRequestServer, applyAptProposal, approveAptProposal } from './apt-requests.js';
import { imagePlan } from './image-plan.js';
import { withDefaultExtensions } from './extensions.js';
export { BASE_IMAGE, PI_VERSION, containerfile, imagePlan } from './image-plan.js';

export const CONTAINER_HOME = '/pis/home';
const COMMANDS = new Set([
  'install',
  'remove',
  'uninstall',
  'update',
  'list',
  'config',
  'auth',
  'mcp',
]);
const SESSION_OPTIONS = new Set([
  '-c',
  '--continue',
  '-r',
  '--resume',
  '--session',
  '--session-id',
  '--fork',
  '--no-session',
]);

export function piCommand(args = [], fresh = false) {
  const beforeSeparator = args.slice(
    0,
    args.indexOf('--') === -1 ? args.length : args.indexOf('--'),
  );
  const selectsSession = beforeSeparator.some((arg) => SESSION_OPTIONS.has(arg.split('=')[0]));
  const selectsTuiMode = beforeSeparator.some(
    (arg) => arg === '--tui-mode' || arg.startsWith('--tui-mode='),
  );
  // Management subcommands do not accept conversation/TUI defaults.
  const defaults = COMMANDS.has(args[0])
    ? []
    : [
        ...(!selectsTuiMode ? ['--tui-mode', 'regular'] : []),
        ...(!fresh && !selectsSession ? ['--continue'] : []),
      ];
  return ['pi', ...defaults, ...args];
}

// A message network is offered only to launches that actually run an agent task.
function runsAgentTask(options, isClaude) {
  if (options.mode !== 'pi' || options.webRpc || options.stdio) return false;
  const management = isClaude ? ['auth', 'doctor', 'mcp', 'install', 'update'] : [...COMMANDS];
  return (
    !management.includes(options.args[0]) &&
    !options.args.some((arg) =>
      ['--help', '-h', '--version', '-v', '--list-models', '--export'].includes(arg),
    )
  );
}

export function interactiveOutput(command) {
  if (command[0] === 'claude')
    return (
      !command
        .slice(1)
        .some(
          (arg) =>
            ['-p', '--print', '--help', '-h', '--version', '-v'].includes(arg) ||
            arg.startsWith('--print='),
        ) && !['auth', 'doctor', 'mcp', 'install', 'update'].includes(command[1])
    );
  if (command[0] !== 'pi') return true;
  const args = command.slice(1);
  const end = args.indexOf('--');
  const options = end === -1 ? args : args.slice(0, end);
  return !options.some(
    (arg, index) =>
      ['-p', '--print', '--export', '--help', '-h', '--version', '-v', '--list-models'].includes(
        arg,
      ) ||
      /^--mode=(json|rpc)$/.test(arg) ||
      (arg === '--mode' && ['json', 'rpc'].includes(options[index + 1])),
  );
}

export function inspectPodman() {
  assert(process.platform === 'linux', 'pis supports Linux only.');
  assert(process.getuid?.() !== 0, 'Run pis as your normal user, not root or sudo.');
  const result = spawnSync('podman', ['info', '--format', 'json'], { encoding: 'utf8' });
  if (result.error) throw new Error(`Podman is unavailable: ${result.error.message}`);
  assert(result.status === 0, `Cannot query Podman: ${result.stderr.trim()}`);
  let info;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    throw new Error('Podman returned invalid info JSON.');
  }
  assert(info.host?.security?.rootless === true, 'pis requires rootless Podman.');
  assert(
    info.host.serviceIsRemote !== true,
    'Remote Podman is unsupported; same-path mounts require local Podman.',
  );
  return info;
}

export function podmanEnvironment(config) {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.BERGET_API_KEY;
  delete env.MISTRAL_API_KEY;
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_)/.test(key)) delete env[key];
  return env;
}

export async function ensureImage(store, config, { rebuild = false } = {}) {
  const plan = imagePlan(config);
  const dir = store.projectDir(config.id);
  const context = path.join(dir, 'build');
  privateDir(context);
  assert(
    fs.readdirSync(context).every((file) => Object.hasOwn(plan.files, file)),
    `Unexpected files in generated build context: ${context}. Move them elsewhere before building.`,
  );
  atomicWrite(path.join(dir, 'Containerfile'), plan.content);
  for (const [file, content] of Object.entries(plan.files))
    atomicWrite(path.join(context, file), content);
  const exists = spawnSync('podman', ['image', 'exists', plan.image], {
    env: podmanEnvironment(config),
  });
  if (exists.error) throw exists.error;
  assert([0, 1].includes(exists.status), 'Cannot check whether the sandbox image exists.');
  if (rebuild || exists.status !== 0) {
    console.error(`pis: building ${plan.image}`);
    const code = await run(
      'podman',
      [
        'build',
        '--layers',
        '--http-proxy=false',
        ...(rebuild ? ['--no-cache'] : []),
        '--tag',
        plan.image,
        '--file',
        path.join(context, 'Containerfile'),
        context,
      ],
      { env: podmanEnvironment(config), stdio: ['ignore', 2, 2] },
    );
    assert(code === 0, `Image build failed (exit ${code}).`);
    plan.built = true;
    schedulePrune(store);
  }
  return plan;
}

export function launchArgs(
  store,
  config,
  command,
  {
    cwd,
    image,
    proxy,
    aptRequests,
    codexAuto,
    messageNetwork,
    startupStarted,
    network,
    selinux = false,
    tty = Boolean(process.stdin.isTTY && process.stdout.isTTY && interactiveOutput(command)),
    stdinIsTTY = Boolean(process.stdin.isTTY),
    uid = process.getuid(),
    gid = process.getgid(),
    name = `pis-${config.id}-${randomBytes(5).toString('hex')}`,
  } = {},
) {
  assert(
    config.credentials.env.length === 0,
    'Direct credential forwarding is no longer supported; configure credentials.proxy.',
  );
  assert(network === undefined || network === 'none', 'Unsupported internal network override.');
  const workdir = within(config.root, cwd) ? cwd : config.root;
  const isClaude = config.agent === 'claude';
  const claudeProxy = proxy?.provider === 'claude';
  assert(
    !isClaude || ((!proxy || claudeProxy) && !aptRequests?.gitOnly && !codexAuto),
    'Claude Code does not use Pi proxy/quota sockets or the web Git-only socket.',
  );
  // The Claude subscription proxy is only ever offered to official Claude Code.
  assert(
    isClaude || !claudeProxy,
    'The Claude subscription proxy is only available to Claude Code.',
  );
  const state = path.join(store.projectDir(config.id), isClaude ? 'claude-state' : 'state');
  const sharedLabel = selinux ? ',z' : '';
  const privateLabel = selinux ? ',Z' : '';
  // Print/JSON Pi modes read piped stdin to EOF. When the host input is a
  // terminal, do not turn it into an open pipe that makes a one-shot task wait.
  const rpc = command.some(
    (arg, index) => arg === '--mode=rpc' || (arg === '--mode' && command[index + 1] === 'rpc'),
  );
  const openStdin = !stdinIsTTY || interactiveOutput(command) || rpc;
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    name,
    ...(network ? ['--network=none'] : []),
    ...(openStdin ? ['--interactive'] : []),
    ...(tty ? ['--tty'] : []),
    '--userns=keep-id',
    '--user',
    `${uid}:${gid}`,
    '--cap-drop=all',
    '--security-opt=no-new-privileges',
    '--http-proxy=false',
    '--workdir',
    workdir,
    '--env',
    `HOME=${CONTAINER_HOME}`,
    '--env',
    `PI_CODING_AGENT_DIR=${CONTAINER_HOME}/.pi/agent`,
    '--env',
    `PI_CODING_AGENT_SESSION_DIR=${CONTAINER_HOME}/.pi/agent/sessions`,
    '--env',
    'PI_SKIP_VERSION_CHECK=1',
    '--volume',
    `${config.root}:${config.root}:rw${sharedLabel}`,
    '--volume',
    `${state}:${CONTAINER_HOME}:rw${privateLabel}`,
  ];
  for (const mount of config.mounts)
    args.push(
      '--volume',
      `${mount.source}:${mount.source}:${mount.access === 'read-write' ? 'rw' : 'ro'}${sharedLabel}`,
    );
  if (isClaude)
    args.push('--env', `CLAUDE_CONFIG_DIR=${CONTAINER_HOME}/.claude`, '--env', 'DISABLE_UPDATES=1');
  if (claudeProxy)
    // Fixed non-secret values; the real subscription token stays in the host proxy.
    args.push(
      '--env',
      `ANTHROPIC_UNIX_SOCKET=${CLAUDE_SOCKET}`,
      '--env',
      `ANTHROPIC_BASE_URL=${CLAUDE_SANDBOX_BASE_URL}`,
      '--env',
      `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_PLACEHOLDER_TOKEN}`,
      '--env',
      'CLAUDE_CODE_OAUTH_401_WAIT_MS=0',
      '--volume',
      `${proxy.directory}:/pis/proxy:ro${sharedLabel}`,
    );
  if (startupStarted) args.push('--env', `PIS_STARTUP_STARTED=${startupStarted}`);
  if (aptRequests)
    args.push(
      '--env',
      'PIS_APT_SOCKET=/pis/apt/request.sock',
      '--volume',
      `${aptRequests.directory}:/pis/apt:ro${sharedLabel}`,
    );
  if (aptRequests?.gitOnly) args.push('--env', 'PIS_HOST_GIT_ONLY=1');
  if (messageNetwork)
    args.push(
      '--env',
      'PIS_NET_SOCKET=/pis/net/net.sock',
      '--volume',
      `${messageNetwork.directory}:/pis/net:ro${sharedLabel}`,
    );
  if (codexAuto)
    args.push(
      '--env',
      'PIS_CODEX_AUTO_SOCKET=/pis/codex-auto/wait.sock',
      '--volume',
      `${codexAuto.directory}:/pis/codex-auto:ro${sharedLabel}`,
    );
  if (!isClaude && config.credentials.proxy) {
    assert(proxy, 'Proxy-enabled launches require an active host proxy.');
    const isCodex = config.credentials.proxy.provider === 'openai-codex';
    args.push(
      '--env',
      `PIS_PROXY_TOKEN=${proxy.token}`,
      '--env',
      `PIS_PROXY_BASE_URL=${proxy.baseUrl}`,
      '--env',
      `PIS_PROXY_PROVIDER=${proxy.provider}`,
      '--env',
      `OPENAI_API_KEY=${isCodex ? '' : proxy.token}`,
      '--env',
      `OPENAI_BASE_URL=${isCodex ? '' : proxy.baseUrl}`,
      '--env',
      `BERGET_API_KEY=${proxy.provider === 'berget' ? proxy.token : ''}`,
      '--env',
      `BERGET_BASE_URL=${proxy.provider === 'berget' ? proxy.baseUrl : ''}`,
      '--env',
      `MISTRAL_API_KEY=${proxy.provider === 'mistral' ? proxy.token : ''}`,
      '--volume',
      `${proxy.directory}:/pis/proxy:ro${sharedLabel}`,
      '--volume',
      `${proxy.directory}/models.json:${CONTAINER_HOME}/.pi/agent/models.json:ro${sharedLabel}`,
      '--volume',
      `${proxy.directory}/auth.json:${CONTAINER_HOME}/.pi/agent/auth.json:ro${sharedLabel}`,
    );
  }
  for (const variable of ['TERM', 'COLORTERM'])
    if (process.env[variable]) args.push('--env', variable);
  args.push(
    '--entrypoint',
    '/usr/local/bin/node',
    image,
    ...(proxy && !claudeProxy ? ['/pis/proxy/entry.mjs', '/usr/local/bin/node'] : []),
    '/opt/pis/image-entry.mjs',
    ...command,
  );
  return { args, name, workdir };
}

export function restartOptions(options, installedPackages = [], actionNotice) {
  // Do not replay an initial prompt, --fresh or management/session-creation flags.
  // Only the host-approved names are included, never the sandbox's explanation.
  const notice =
    actionNotice ||
    (installedPackages.length
      ? `[pis] The user approved the apt packages ${installedPackages.join(', ')}. The sandbox image has now been built successfully with these packages and the agent has restarted. Continue the previous task using the newly available tools; you do not need to request these packages again.`
      : undefined);
  return {
    ...options,
    mode: 'pi',
    fresh: false,
    rebuild: false,
    buildOnly: false,
    waitCodex: false,
    installedPackages: [...installedPackages],
    args: ['--continue', ...(notice ? [notice] : [])],
  };
}

export async function launch(store, config, options) {
  while (true) {
    const result = await launchOnce(store, config, options);
    if (result?.type !== RESTART) return result;
    // launchOnce has released the project lock and closed all old sockets.
    options = restartOptions(options, result.packages, result.notice);
  }
}

const RESTART = Symbol('restart-after-approved-packages');

async function launchOnce(store, config, options) {
  let built = false,
    maintenanceReady = false;
  options.startupProgress?.('project_lock');
  return store
    .projectLock(
      config.id,
      async () => {
        // Re-read and validate after acquiring exclusivity (configuration may have changed).
        config = store.load(config.id);
        // A per-launch --claude/--agent override must never be saved or break stale-config checks.
        const storedConfig = config;
        if (options.agent) config = { ...config, agent: options.agent };
        const isClaude = config.agent === 'claude';
        if (options.addDefaultExtensions)
          assert(
            !isClaude &&
              !options.agent &&
              options.buildOnly &&
              options.rebuild &&
              options.mode === 'pi',
            'Default-extension rebuild requires the configured Pi agent and build-only mode.',
          );
        if (options.webRpc) {
          assert(
            !isClaude &&
              options.mode === 'pi' &&
              !options.agent &&
              !options.waitCodex &&
              !options.autoWaitCodex &&
              !options.fresh &&
              !options.stdio &&
              !options.buildOnly &&
              isDeepStrictEqual(options.args, ['--mode', 'rpc']),
            'Web RPC requires the configured Pi agent and fixed RPC/session defaults; no Claude, custom commands, quota-auto or approval flow.',
          );
        }
        if (options.autoWaitCodex)
          validateCodexAuto(config, options, piCommand(options.args, options.fresh));
        if (options.waitCodex) {
          validateCodexWait(config, options);
          requireSavedPiSession(store, config.id);
          const status = await waitForCodexOnHost(store, options.codexWait);
          if (status !== 0) return status;
          const current = store.load(config.id);
          assert(
            isDeepStrictEqual(
              config,
              options.agent ? { ...current, agent: options.agent } : current,
            ),
            'Project configuration changed while waiting; no agent was started. Run pis --wait-codex again.',
          );
          requireSavedPiSession(store, config.id);
          options = restartOptions(options, [], CODEX_RESUME_NOTICE);
        }
        const claudeToken = isClaude && !options.buildOnly ? readClaudeToken(store) : undefined;
        assert(
          !isClaude ||
            options.buildOnly ||
            options.mode !== 'pi' ||
            !claudeNeedsLogin(options.args) ||
            claudeToken,
          'No Claude login saved. Run pis --login claude on the host.',
        );
        directory(config.root);
        const startupStarted = Date.now();
        const showProgress = !options.stdio && process.stderr.isTTY;
        const progress = (message) => {
          if (showProgress)
            console.error(
              `pis: [${((Date.now() - startupStarted) / 1000).toFixed(1)}s] ${message}`,
            );
        };
        progress('Checking Podman and sandbox image…');
        options.startupProgress?.('checking_engine');
        const info = inspectPodman();
        if (options.addDefaultExtensions) {
          const extensions = withDefaultExtensions(config.extensions);
          if (!isDeepStrictEqual(extensions, config.extensions)) {
            const updated = { ...config, extensions };
            await store.save(updated, config);
            config = updated;
            console.error(
              'pis: missing default Pi extensions saved; rebuilding the declared image without cache.',
            );
          }
        }
        const { selectUpdateImage, scheduleUpdates } = await import('./updates.js');
        const managed = options.rebuild ? undefined : await selectUpdateImage(store, config);
        options.startupProgress?.('preparing_image');
        const plan = managed || (await ensureImage(store, config, options));
        built = Boolean(plan.built);
        progress('Image ready.');
        options.startupProgress?.('image_ready');
        maintenanceReady = true;
        scheduleUpdates(store, config);
        if (options.installedPackages?.length) {
          assert(
            options.installedPackages.every((pkg) => config.image.packages.includes(pkg)),
            'Approved package configuration changed before restart; no installation notice was sent.',
          );
          progress('Packages ready. Resuming Pi and notifying the agent to continue the task…');
        }
        if (options.buildOnly) return 0;
        // Messages that arrived while no agent ran are delivered once, as one clearly marked
        // prompt, only when the user supplied no prompt of their own. Otherwise they stay queued.
        const networkOn = Boolean(config.network) && runsAgentTask(options, isClaude);
        const pending =
          networkOn && options.args.length === 0 ? pendingMessages(store, config) : [];
        const agentArgs = pending.length
          ? [formatMessages(config, pending.map((entry) => entry.message), { startup: true })]
          : options.args;
        const command =
          options.mode === 'bash'
            ? ['bash', '-i']
            : options.mode === 'exec'
              ? options.args
              : isClaude
                ? claudeCommand(agentArgs, {
                    fresh: options.fresh,
                    hasSession: claudeHasSession(
                      store,
                      config.id,
                      within(config.root, options.cwd) ? options.cwd : config.root,
                    ),
                  })
                : piCommand(agentArgs, options.fresh);
        if (isClaude) {
          claudeState(store, config.id);
          if (hasLegacyClaudeCredential(store, config.id))
            console.error(
              'pis: warning: an old per-project Claude login with REAL tokens is still in this sandbox state. Remove it with pis --logout-claude.',
            );
        } else privateDir(path.join(store.projectDir(config.id), 'state'));
        // Claude can only propose host actions through the image-owned MCP server; the
        // user still approves on the host after the container has stopped.
        const claudeHostRequests =
          isClaude &&
          options.mode === 'pi' &&
          !options.webRpc &&
          interactiveOutput(command) &&
          !options.stdio &&
          process.stdin.isTTY &&
          process.stdout.isTTY &&
          process.stderr.isTTY;
        if (isClaude && (claudeHostRequests || networkOn))
          command.splice(
            1,
            0,
            '--mcp-config',
            claudeHostMcpConfig({ apt: Boolean(claudeHostRequests), net: networkOn }),
          );
        let proxy,
          invocation,
          aptRequests,
          codexAuto,
          messageNetwork,
          status,
          proposal,
          containerStopped = false;
        try {
          // Proxy and package proposal sockets are separate. Package proposals cannot
          // carry a host approval; the user is prompted only after Podman exits.
          if (isClaude && claudeToken) {
            progress('Preparing Claude subscription proxy…');
            proxy = await prepareClaudeProxy(store, { upstream: options.claudeUpstream });
          } else if (!isClaude && config.credentials.proxy) {
            progress(`Preparing ${config.credentials.proxy.provider} credential proxy…`);
            options.startupProgress?.('preparing_proxy');
            proxy = await prepareProxy(store, config, {
              upstream: options.proxyUpstream,
              codexAuthFetch: options.codexAuthFetch,
              bergetCatalogFetch: options.bergetCatalogFetch,
            });
            if (proxy.catalog)
              progress(
                `Berget catalogue: ${proxy.catalog.source}, ${proxy.catalog.count} chat models${proxy.catalog.defaultsUsed ? ' (local token budgets; verify provider limits or set modelOverrides)' : ''}.`,
              );
          }
          if (options.autoWaitCodex) codexAuto = await startCodexAutoServer(store);
          const piOptions = command.slice(
            1,
            command.indexOf('--') === -1 ? command.length : command.indexOf('--'),
          );
          if (claudeHostRequests) aptRequests = await startAptRequestServer(config, store);
          if (networkOn) messageNetwork = await startNetworkServer(config, store);
          if (options.webRpc && options.webGitApproval)
            aptRequests = await startAptRequestServer(config, store, { gitOnly: true });
          if (
            !isClaude &&
            options.mode === 'pi' &&
            !piOptions.includes('--no-session') &&
            interactiveOutput(command) &&
            !options.stdio &&
            process.stdin.isTTY &&
            process.stdout.isTTY &&
            process.stderr.isTTY
          )
            aptRequests = await startAptRequestServer(config, store);
          invocation = launchArgs(store, config, command, {
            cwd: options.cwd,
            image: plan.image,
            proxy,
            aptRequests,
            codexAuto,
            messageNetwork,
            startupStarted: showProgress ? startupStarted : undefined,
            network: options.network,
            selinux: info.host.security.selinuxEnabled,
          });
          if (pending.length) {
            // Claimed only now that the image and sockets are ready; messages stay queued on failure.
            const claimed = markDelivered(store, config, pending);
            console.error(
              `pis: network ${config.network}: delivering ${claimed.length} queued message${claimed.length === 1 ? '' : 's'} to the agent at start.`,
            );
          }
          progress('Starting container (first start after a build can take longer)…');
          options.startupProgress?.('starting_container');
          status = await run('podman', invocation.args, {
            env: podmanEnvironment(config),
            stdio: options.stdio || 'inherit',
          });
          proposal = aptRequests?.proposal;
        } finally {
          // Covers interrupted attached clients that leave their container running.
          if (invocation) {
            spawnSync('podman', ['rm', '--force', '--time', '1', invocation.name], {
              stdio: 'ignore',
              timeout: 15_000,
            });
            // Do not prompt while a failed cleanup might leave the sandbox alive.
            const exists = spawnSync('podman', ['container', 'exists', invocation.name], {
              stdio: 'ignore',
              timeout: 15_000,
            });
            containerStopped = exists.status === 1;
          }
          try {
            if (aptRequests) await aptRequests.close();
            if (messageNetwork) await messageNetwork.close();
            if (codexAuto) await codexAuto.close();
            if (proxy) {
              const refused = proxy.refused?.() || [];
              if (refused.length && process.env.PIS_CLAUDE_PROXY_DEBUG === '1')
                console.error(`pis: Claude proxy refused non-model routes: ${refused.join(', ')}`);
              await proxy.close();
            }
          } finally {
            if (options.webRpc && invocation && !containerStopped) {
              throw Object.assign(
                new Error(
                  'Cannot confirm web sandbox shutdown. Project lock retained; inspect containers on the host, then use pis --unlock when safe.',
                ),
                { code: 'PIS_CONTAINER_UNKNOWN' },
              );
            }
          }
        }
        if (proposal) {
          assert(
            containerStopped,
            'Cannot confirm sandbox shutdown; no host action was performed.',
          );
          if (proposal.type === 'git-push') {
            const push = await prepareGitPush(config, proposal, {
              nonInteractive: options.webRpc === true,
            });
            try {
              if (options.webRpc) {
                assert(options.webGitApproval, 'Web Git approval was not enabled on this host.');
                if (!(await options.webGitApproval.approve(push))) {
                  options.webGitApproval.report('declined');
                  return status;
                }
                try {
                  await push.push();
                  options.webGitApproval.report('succeeded');
                } catch {
                  options.webGitApproval.report('unknown');
                }
                // A new runtime requires a fresh connector/generation. No automatic paid continuation.
                return status;
              }
              if (await approveGitPush(push)) {
                await push.push();
                console.error('pis: host Git push succeeded. Restarting Pi…');
                return {
                  type: RESTART,
                  packages: [],
                  notice: `[pis] The user approved a host Git push. Git reported success pushing commit ${push.commit} to ${push.url}, branch ${push.ref}. The agent has restarted. Continue the previous task; do not repeat this push.`,
                };
              }
              console.error('pis: Git push declined; no host push was executed.');
            } finally {
              push.close();
            }
            return status;
          }
          if (await approveAptProposal(proposal)) {
            await applyAptProposal(store, storedConfig, proposal);
            console.error(
              `pis: packages added to ${store.configPath(config.id)}. Rebuilding and restarting Pi with the latest session…`,
            );
            return { type: RESTART, packages: [...proposal.packages] };
          } else console.error('pis: package request declined; configuration unchanged.');
        }
        return status;
      },
      options.webRpc
        ? { retainOnError: (error) => error.code === 'PIS_CONTAINER_UNKNOWN' }
        : undefined,
    )
    .finally(async () => {
      if (built) schedulePrune(store);
      if (maintenanceReady) {
        const { scheduleUpdates } = await import('./updates.js');
        scheduleUpdates(store, config);
      }
    });
}
