// Image-owned bootstrap: packages are installed at build time, never on startup.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const PI_COMMANDS = new Set([
  'install',
  'remove',
  'uninstall',
  'update',
  'list',
  'config',
  'auth',
  'mcp',
]);

export function imageCommand(command, extensions, env = process.env) {
  if (!['pi', '/usr/local/bin/pi', '/usr/local/bin/pis-pi-real'].includes(command[0]))
    return command;
  command = ['/usr/local/bin/pis-pi-real', ...command.slice(1)];
  if (PI_COMMANDS.has(command[1])) return command;
  const args = command.slice(1);
  const end = args.indexOf('--');
  const options = end === -1 ? args : args.slice(0, end);
  if (options.includes('--no-extensions') || options.includes('-ne')) return command;
  const subagents = extensions.find((entry) => entry.name === 'pi-subagents');
  // A resumed transcript can remember this tool as removed. The per-launch host
  // opt-in therefore adds a fixed modifier, never an allowlist/config rewrite.
  // Explicit caller tool selections still win; --exclude-tools stays enforced by Pi.
  const explicitTools = options.some(
    (arg) => ['--tools', '-t', '--no-tools', '-nt'].includes(arg) || arg.startsWith('--tools='),
  );
  const activateHostGit = env.PIS_APT_SOCKET && env.PIS_HOST_GIT_ONLY === '1' && !explicitTools;
  return [
    command[0],
    ...extensions.flatMap((entry) => ['--extension', entry.path]),
    ...(subagents && !options.includes('--no-skills') && !options.includes('-ns')
      ? ['--skill', `${subagents.path}/skills`]
      : []),
    ...(env.PIS_APT_SOCKET ? ['--extension', '/opt/pis/request-apt.mjs'] : []),
    ...(env.PIS_NET_SOCKET ? ['--extension', '/opt/pis/network-tools.mjs'] : []),
    ...(env.PIS_CODEX_AUTO_SOCKET ? ['--extension', '/opt/pis/codex-auto.mjs'] : []),
    ...(activateHostGit ? ['--tools', '+request_host_git'] : []),
    ...args,
  ];
}

export function initializeWebSettings(extensions, env = process.env) {
  if (!extensions.some((entry) => entry.name === 'pi-web-access')) return;
  const dir = env.PI_CODING_AGENT_DIR || path.join(env.HOME, '.pi/agent');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'web-search.json');
  let config = {};
  try {
    if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Sandbox web-search.json must be valid JSON; it was not changed.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Sandbox web-search.json must be an object.');
  const defaults = { workflow: 'none', autoOpenBrowser: false };
  if (env.PIS_PROXY_PROVIDER) {
    defaults.openaiUseProviderBaseUrl = true;
    defaults.openaiSearchProviders = [env.PIS_PROXY_PROVIDER];
  }
  let changed = !fs.existsSync(file);
  for (const [key, value] of Object.entries(defaults)) {
    if (config[key] === undefined) {
      config[key] = value;
      changed = true;
    }
  }
  if (changed) {
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
}

// Reject redirected parents without changing existing directory permissions.
function subagentDirectory(directory, create = false) {
  const { root } = path.parse(directory);
  let current = root;
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe directory.');
  }
  return true;
}

// Supply a per-process default, never rewrite the extension's user config.
export function subagentWorktreeEnvironment(command, extensions, source = process.env) {
  const env = { ...source };
  const args = command.slice(1),
    end = args.indexOf('--');
  const options = end === -1 ? args : args.slice(0, end);
  if (
    env.CLAUDE_CONFIG_DIR ||
    command[0] !== '/usr/local/bin/pis-pi-real' ||
    PI_COMMANDS.has(command[1]) ||
    options.some(
      (arg) =>
        ['--help', '-h', '--version', '-v', '--list-models', '--export'].includes(arg) ||
        arg.startsWith('--list-models='),
    ) ||
    options.includes('--no-extensions') ||
    options.includes('-ne') ||
    !extensions.some((entry) => entry.name === 'pi-subagents')
  )
    return env;
  try {
    const agentDir = env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), '.pi/agent');
    if (!path.isAbsolute(agentDir)) throw new Error('Invalid state path.');
    const directory = path.join(agentDir, 'extensions/subagent');
    let config = {};
    if (subagentDirectory(directory)) {
      let fd;
      try {
        fd = fs.openSync(
          path.join(directory, 'config.json'),
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (fd !== undefined) {
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
            throw new Error('Unsafe config.');
          const buffer = Buffer.alloc(65537);
          let bytes = 0;
          while (bytes < buffer.length) {
            const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
            if (!count) break;
            bytes += count;
          }
          if (bytes > 65536) throw new Error('Config too large.');
          config = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)),
          );
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error('Invalid config.');
    if (
      config.worktreeProvider !== undefined &&
      !['native', 'auto', 'worktrunk'].includes(config.worktreeProvider)
    )
      throw new Error('Invalid provider.');
    if (
      config.worktreeBaseDir !== undefined &&
      (typeof config.worktreeBaseDir !== 'string' ||
        !config.worktreeBaseDir.trim() ||
        config.worktreeBaseDir.includes('\0'))
    )
      throw new Error('Invalid root.');
    if (config.worktreeProvider === 'worktrunk' && config.worktreeBaseDir !== undefined)
      throw new Error('Conflicting provider.');
    if (
      config.worktreeBaseDir !== undefined ||
      ['auto', 'worktrunk'].includes(config.worktreeProvider) ||
      env.PI_SUBAGENTS_WORKTREE_DIR?.trim()
    )
      return env;
    const root = path.join(agentDir, 'worktrees');
    subagentDirectory(root, true);
    const stat = fs.lstatSync(root);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
      throw new Error('Nonprivate root.');
    env.PI_SUBAGENTS_WORKTREE_DIR = root;
    return env;
  } catch {
    throw new Error(
      'Sandbox pi-subagents worktree configuration is unsafe or invalid; no config was changed.',
    );
  }
}

export function startupProgress(
  message,
  env = process.env,
  write = (text) => console.error(text),
  now = Date.now(),
) {
  const started = Number(env.PIS_STARTUP_STARTED);
  if (!Number.isFinite(started) || started <= 0) return;
  write(`pis: [${Math.max(0, (now - started) / 1000).toFixed(1)}s] ${message}`);
}

async function main() {
  startupProgress('Container started. Preparing sandbox settings…');
  const extensions = JSON.parse(fs.readFileSync('/opt/pis/extensions.json', 'utf8'));
  if (!process.env.CLAUDE_CONFIG_DIR) initializeWebSettings(extensions);
  const command = imageCommand(process.argv.slice(2), extensions);
  if (!command.length) throw new Error('No sandbox command.');
  if (command[0] === '/usr/local/bin/pis-pi-real' && command[1] === 'list') {
    console.log(
      `Image extensions (managed with pis --edit):\n${extensions.map((entry) => entry.source).join('\n') || '(none)'}\n\nAdditional sandbox-state packages:`,
    );
  }
  const env = subagentWorktreeEnvironment(command, extensions);
  const bridge = '--import=/opt/pis/fetch-bridge.mjs';
  if (
    env.PIS_PROXY_PROVIDER === 'openai-codex' &&
    !(env.NODE_OPTIONS || '').split(/\s+/).includes(bridge)
  )
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} ${bridge}`.trim();
  startupProgress(
    command[0] === '/usr/local/bin/pis-pi-real'
      ? `Loading Pi, session and extensions (${command.filter((arg) => arg === '--extension').length} explicit extensions). Startup may take seconds or longer on a cold start; there is no reliable ETA.`
      : 'Starting sandbox command…',
  );
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env });
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        resolve(code ?? 128 + (os.constants.signals[signal] || 1)),
      );
    });
  } finally {
    handlers.forEach(([signal, handler]) => process.off(signal, handler));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`pis: ${error.message}`);
    process.exitCode = 1;
  });
}
