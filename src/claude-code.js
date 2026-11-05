import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, run, within, writeJson } from './util.js';

// Official npm package, which installs Anthropic's unmodified native binary.
export const CLAUDE_VERSION = '2.1.318';
const MAX_BYTES = 128 * 1024;

function privateDirectory(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(dir);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'Claude state/auth directory must be owned by you and not a symlink.');
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function claudeState(store, id) {
  const project = store.projectDir(id);
  assert(fs.realpathSync(project) === project, 'Claude project storage must not contain symlinks.');
  const home = privateDirectory(path.join(project, 'claude-state'));
  const config = privateDirectory(path.join(home, '.claude'));
  return { home, config, credential: path.join(config, '.credentials.json') };
}

function authDirectory(store) {
  return privateDirectory(path.join(store.root, 'auth'));
}

function boundedJson(file, privateFile = true) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && (!privateFile || (stat.mode & 0o077) === 0) && stat.size <= MAX_BYTES, 'Invalid file.');
    const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
    assert(record && typeof record === 'object' && !Array.isArray(record), 'Invalid JSON.');
    return record;
  } catch { throw new Error('Cannot read Claude JSON: expected a bounded regular file, not a link.'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function credentialRecord(file) {
  try {
    const oauth = boundedJson(file)?.claudeAiOauth;
    assert(oauth && typeof oauth === 'object' && !Array.isArray(oauth), 'Missing OAuth login.');
    assert(typeof oauth.accessToken === 'string' && /^[!-~]{1,32768}$/.test(oauth.accessToken), 'Missing access token.');
    assert(oauth.refreshToken === undefined || (typeof oauth.refreshToken === 'string' && /^[!-~]{1,32768}$/.test(oauth.refreshToken)), 'Invalid refresh token.');
    assert(Number.isFinite(oauth.expiresAt) && oauth.expiresAt > 0, 'Missing expiry.');
    // Copy only subscription OAuth, never API keys, settings, hooks or MCP config.
    return { claudeAiOauth: oauth };
  } catch {
    throw new Error('Cannot read Claude subscription credentials: expected private regular OAuth JSON. Run pis --login-claude on the host.');
  }
}

function checkDestination(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid(), 'Claude credential destination must be a regular singly-linked file, not a symlink.');
}

export function claudeLoginEnvironment(configDir, source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|PIS_PROXY_)/.test(key) || ['OPENAI_API_KEY', 'BERGET_API_KEY', 'MISTRAL_API_KEY', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key];
  }
  return { ...env, CLAUDE_CONFIG_DIR: configDir, DISABLE_UPDATES: '1' };
}

export async function loginClaude(store, config, { execute = run, binary = process.env.PIS_CLAUDE_BIN || path.join(os.homedir(), '.local/bin/claude') } = {}) {
  return store.projectLock(config.id, async () => {
    assert(path.isAbsolute(binary), 'PIS_CLAUDE_BIN must be an absolute path to the official host Claude Code executable.');
    let executable;
    try { executable = fs.realpathSync(binary); fs.accessSync(executable, fs.constants.X_OK); }
    catch { throw new Error('Install official Claude Code on the host first (~/.local/bin/claude), or set PIS_CLAUDE_BIN to its absolute executable path.'); }
    const shared = [store.projectsDir, ...store.all().flatMap(project => [project.root, ...project.mounts.map(mount => mount.source)])];
    assert(!shared.some(dir => within(dir, executable)), 'Host Claude executable must not come from a sandbox-writable project, mount or state directory.');
    const auth = authDirectory(store);
    const temporary = fs.mkdtempSync(path.join(auth, 'claude-login-'));
    fs.chmodSync(temporary, 0o700);
    try {
      // Fresh host-only config/cwd: never execute sandbox settings or refresh its tokens on the host.
      const code = await execute(executable, ['auth', 'login'], { cwd: temporary, env: claudeLoginEnvironment(temporary) });
      assert(code === 0, 'Claude Code sign-in failed; existing sandbox login was not replaced.');
      const record = credentialRecord(path.join(temporary, '.credentials.json'));
      const state = claudeState(store, config.id);
      const destination = state.credential;
      checkDestination(destination);
      // Native Claude also saves account identity in its global config. Copy
      // only that field, never host preferences, project trust, hooks or MCP.
      const sourceConfig = path.join(temporary, '.claude.json');
      const account = fs.existsSync(sourceConfig) ? boundedJson(sourceConfig, false).oauthAccount : undefined;
      const targetConfig = path.join(state.config, '.claude.json');
      let preferences;
      if (account !== undefined) {
        assert(account && typeof account === 'object' && !Array.isArray(account), 'Invalid Claude account metadata.');
        checkDestination(targetConfig);
        preferences = { ...(fs.existsSync(targetConfig) ? boundedJson(targetConfig, false) : {}), oauthAccount: account };
      }
      // Snapshot is not mounted and is never used to refresh/reseed automatically.
      const snapshot = path.join(auth, `claude-${config.id}.json`);
      checkDestination(snapshot);
      writeJson(snapshot, record);
      if (preferences) writeJson(targetConfig, preferences);
      writeJson(destination, record);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
}

export function requireClaudeLogin(store, id) {
  const state = claudeState(store, id);
  // Validate bounded local data, but never run host commands from sandbox state.
  credentialRecord(state.credential);
  return state;
}

export async function logoutClaude(store, id) {
  return store.projectLock(id, async () => {
    const state = claudeState(store, id);
    fs.rmSync(state.credential, { force: true });
    fs.rmSync(path.join(authDirectory(store), `claude-${id}.json`), { force: true });
  });
}

export function claudeNeedsLogin(args = []) {
  return !['auth', 'doctor', 'mcp', 'install', 'update'].includes(args[0]) && !args.some(arg => ['--help', '-h', '--version', '-v'].includes(arg));
}

export function claudeCommand(args = []) {
  // Unlike Pi, start a new session by default. Forward explicit -c/-r unchanged.
  return ['claude', ...args];
}
