import fs from 'node:fs';
import path from 'node:path';
import { assert, privateDir, writeJson } from './util.js';
import { DEFAULT_PROXY, startOpenAIProxy } from './proxy.js';
import { getCodexCredential, readCodexCredential } from './codex-auth.js';
import { publicHostLookup, readApiProfile } from './api-auth.js';

export const PROXY_BASE_URL = 'http://127.0.0.1:43127/v1';
export const CODEX_PROXY_BASE_URL = 'http://127.0.0.1:43127/backend-api';

function stateDirectory(parent, name) {
  const dir = path.join(parent, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  const stat = fs.lstatSync(dir);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), `Proxy state directory must not be a symlink: ${dir}`);
  return dir;
}

function stateRecord(file) {
  // These files are sandbox-controlled. Never follow symlinks into the host.
  if (!fs.existsSync(file) && !fs.lstatSync(path.dirname(file)).isSymbolicLink()) {
    try { fs.writeFileSync(file, '{}\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024, 'Pi proxy configuration must be a regular, non-hardlinked file smaller than 1 MiB.');
    const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
    assert(record && typeof record === 'object' && !Array.isArray(record), 'Pi proxy configuration must be a JSON object.');
    return record;
  } catch {
    throw new Error('Cannot prepare Pi proxy configuration. Check sandbox auth.json/models.json (regular JSON files required).');
  } finally { fs.closeSync(fd); }
}

export async function prepareProxy(store, config, { upstream, codexAuthFetch } = {}) {
  const settings = { ...DEFAULT_PROXY, ...config.credentials.proxy };
  const isCodex = settings.provider === 'openai-codex';
  const credential = isCodex ? readCodexCredential(store) : undefined;
  const apiProfile = settings.profile ? readApiProfile(store, settings.profile) : undefined;
  const apiKey = isCodex ? credential.access : settings.profile ? apiProfile?.key : process.env[settings.keyEnv || (settings.provider === 'berget' ? 'BERGET_API_KEY' : 'OPENAI_API_KEY')];
  assert(apiKey, settings.profile ? `Host profile ${settings.profile} is missing. Run pis --login ${settings.profile}.` : `Set ${settings.keyEnv || (settings.provider === 'berget' ? 'BERGET_API_KEY' : 'OPENAI_API_KEY')} on the host before starting this proxy-enabled project.`);
  const baseUrl = isCodex ? CODEX_PROXY_BASE_URL : PROXY_BASE_URL;
  const getCredentials = isCodex ? async signal => ({ apiKey: (await getCodexCredential(store, { signal, fetchImpl: codexAuthFetch })).access }) : undefined;
  // Fixed short parent avoids AF_UNIX path-length limits even for deeply nested project storage.
  const runtimeDir = fs.mkdtempSync('/tmp/pis-proxy-');
  privateDir(runtimeDir);
  let proxy;
  try {
    const lookup = settings.provider === 'custom' && !upstream ? await publicHostLookup(new URL(apiProfile.url).hostname) : undefined;
    proxy = await startOpenAIProxy({ ...settings, socketPath: path.join(runtimeDir, 'api.sock'), apiKey, getCredentials,
      ...(apiProfile ? { upstreamBaseUrl: apiProfile.url } : {}), ...(lookup ? { lookup } : {}), ...(upstream ? { upstream } : {}) });
    const state = path.join(store.projectDir(config.id), 'state');
    privateDir(state);
    const agent = stateDirectory(stateDirectory(state, '.pi'), 'agent');
    const models = stateRecord(path.join(agent, 'models.json'));
    const auth = stateRecord(path.join(agent, 'auth.json'));
    assert(models.providers === undefined || (models.providers && typeof models.providers === 'object' && !Array.isArray(models.providers)), 'models.json providers must be an object.');
    // Per-run read-only file overlays leave the original files unchanged. Replace
    // the selected provider/auth entry so old endpoints/headers cannot win.
    // A full Codex Responses URL also works with pi-web-access's provider-URL reuse.
    const modelBaseUrl = isCodex ? `${baseUrl}/codex/responses` : baseUrl;
    const providerModels = settings.provider === 'berget' ? { api: 'openai-completions', models: [
      { id: 'google/gemma-4-31B-it', name: 'Gemma 4 31B (Berget)', reasoning: false, input: ['text', 'image'], contextWindow: 262144, maxTokens: 8192 },
    ] } : settings.provider === 'custom' ? { api: apiProfile.api, models: apiProfile.models } : {};
    const modelSnapshot = { ...models, providers: { ...models.providers, [settings.provider]: { baseUrl: modelBaseUrl, apiKey: proxy.token, ...providerModels } } };
    // Usage extensions read access/accountId directly; keep the api_key type so
    // Pi never tries to refresh this synthetic credential inside the container.
    const authSnapshot = { ...auth, [settings.provider]: { type: 'api_key', key: proxy.token, ...(isCodex ? { access: proxy.token, accountId: 'pis-proxy-account' } : {}) } };
    const snapshot = JSON.stringify([modelSnapshot, authSnapshot]);
    assert(![apiKey, credential?.refresh].filter(Boolean).some(secret => snapshot.includes(secret)), 'Existing Pi configuration contains host proxy credentials outside the selected provider entry. Remove them before enabling the proxy.');
    writeJson(path.join(runtimeDir, 'models.json'), modelSnapshot);
    writeJson(path.join(runtimeDir, 'auth.json'), authSnapshot);
    fs.copyFileSync(new URL('./runtime/proxy-entry.mjs', import.meta.url), path.join(runtimeDir, 'entry.mjs'));
    fs.chmodSync(path.join(runtimeDir, 'entry.mjs'), 0o600);
    return {
      directory: runtimeDir,
      token: proxy.token,
      baseUrl,
      provider: settings.provider,
      async close() {
        try { await proxy.close(); }
        finally { fs.rmSync(runtimeDir, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    try { if (proxy) await proxy.close(); }
    finally { fs.rmSync(runtimeDir, { recursive: true, force: true }); }
    throw error;
  }
}
