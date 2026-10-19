// Image-owned bootstrap: packages are installed at build time, never on startup.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const PI_COMMANDS = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']);

export function imageCommand(command, extensions) {
  if (!['pi', '/usr/local/bin/pi', '/usr/local/bin/pis-pi-real'].includes(command[0])) return command;
  command = ['/usr/local/bin/pis-pi-real', ...command.slice(1)];
  if (PI_COMMANDS.has(command[1])) return command;
  const args = command.slice(1);
  const end = args.indexOf('--');
  const options = end === -1 ? args : args.slice(0, end);
  if (options.includes('--no-extensions') || options.includes('-ne')) return command;
  return [command[0], ...extensions.flatMap(entry => ['--extension', entry.path]), ...args];
}

export function initializeWebSettings(extensions, env = process.env) {
  if (!extensions.some(entry => entry.name === 'pi-web-access')) return;
  const dir = env.PI_CODING_AGENT_DIR || path.join(env.HOME, '.pi/agent');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'web-search.json');
  let config = {};
  try { if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Sandbox web-search.json must be valid JSON; it was not changed.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Sandbox web-search.json must be an object.');
  const defaults = { workflow: 'none', autoOpenBrowser: false };
  if (env.PIS_PROXY_PROVIDER) {
    defaults.openaiUseProviderBaseUrl = true;
    defaults.openaiSearchProviders = [env.PIS_PROXY_PROVIDER];
  }
  let changed = !fs.existsSync(file);
  for (const [key, value] of Object.entries(defaults)) {
    if (config[key] === undefined) { config[key] = value; changed = true; }
  }
  if (changed) {
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
}

async function main() {
  const extensions = JSON.parse(fs.readFileSync('/opt/pis/extensions.json', 'utf8'));
  initializeWebSettings(extensions);
  const command = imageCommand(process.argv.slice(2), extensions);
  if (!command.length) throw new Error('No sandbox command.');
  if (command[0] === '/usr/local/bin/pis-pi-real' && command[1] === 'list') {
    console.log(`Image extensions (managed with pis --edit):\n${extensions.map(entry => entry.source).join('\n') || '(none)'}\n\nAdditional sandbox-state packages:`);
  }
  const env = { ...process.env };
  const bridge = '--import=/opt/pis/fetch-bridge.mjs';
  if (env.PIS_PROXY_PROVIDER === 'openai-codex' && !(env.NODE_OPTIONS || '').split(/\s+/).includes(bridge)) env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} ${bridge}`.trim();
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env });
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? 128 + (os.constants.signals[signal] || 1)));
    });
  } finally { handlers.forEach(([signal, handler]) => process.off(signal, handler)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`pis: ${error.message}`); process.exitCode = 1; });
}
