import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import { assert, atomicWrite, withLock } from './util.js';

export const API_PRESETS = Object.freeze({
  openai: { url: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
  berget: { url: 'https://api.berget.ai/v1', keyEnv: 'BERGET_API_KEY' },
  custom: {},
});

export function validateApiBaseUrl(input) {
  assert(typeof input === 'string' && input.length <= 2048, 'API base URL is invalid.');
  const rawPath = input.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1] || '';
  assert(!/%2f|%5c|%2e/i.test(rawPath) && rawPath.split('/').every(segment => segment !== '.' && segment !== '..'), 'API base URL path is unsafe.');
  let url;
  try { url = new URL(input); } catch { throw new Error('API base URL must be a valid HTTPS URL.'); }
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'API base URL must use HTTPS and contain no credentials, query, or fragment.');
  assert(!net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && !/^(localhost|.*\.localhost|.*\.local)$/i.test(url.hostname), 'API base URL must use a public DNS hostname, not an IP or local hostname.');
  assert(url.port === '' || url.port === '443', 'API base URL must use the standard HTTPS port.');
  assert(/^\/(?:[A-Za-z0-9._~-]+\/)*v1\/?$/.test(url.pathname), 'API base URL path must end in /v1 and contain only safe path segments.');
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function publicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const value = (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]);
    const blocked = [[0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4]];
    return !blocked.some(([network, bits]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(network / 2 ** (32 - bits)));
  }
  if (version !== 6) return false;
  const normalized = address.toLowerCase().split('%')[0];
  // Permit only global unicast 2000::/3; this excludes loopback, link-local,
  // ULA, mapped IPv4, multicast, unspecified, and other special-use ranges.
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  if ((first & 0xe000) !== 0x2000 || first === 0x2002) return false;
  const parts = normalized.split(':');
  if (first === 0x2001 && Number.parseInt(parts[1] || '0', 16) <= 0x01ff) return false;
  if (first === 0x2001 && Number.parseInt(parts[1] || '0', 16) === 0x0db8) return false;
  if (first === 0x3fff && (Number.parseInt(parts[1] || '0', 16) & 0xf000) === 0) return false;
  return true;
}

export async function publicHostLookup(hostname) {
  const entries = await dns.lookup(hostname, { all: true, verbatim: true });
  assert(entries.length > 0 && entries.every(entry => publicAddress(entry.address)), 'Custom API hostname resolves to a private or unsafe address.');
  const pinned = entries;
  return (host, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (host !== hostname) return callback(new Error('Unexpected upstream hostname.'));
    if (options?.all) return callback(null, pinned);
    const entry = pinned[0];
    callback(null, entry.address, entry.family);
  };
}

function validateModels(models) {
  assert(Array.isArray(models) && models.length > 0 && models.length <= 100, 'Custom profile needs 1–100 model definitions.');
  const ids = new Set();
  return models.map(model => {
    assert(model && typeof model === 'object' && !Array.isArray(model), 'Invalid custom model definition.');
    const { id, contextWindow, maxTokens } = model;
    assert(model.input === undefined || (Array.isArray(model.input) && model.input.length > 0 && model.input.every(item => ['text', 'image'].includes(item)) && model.input.includes('text')), 'Invalid custom model input capabilities.');
    const images = model.images ?? model.input?.includes('image') ?? false;
    const reasoning = model.reasoning ?? false;
    assert(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(id) && !ids.has(id), 'Custom model IDs must be unique nonempty IDs.');
    ids.add(id);
    assert(Number.isSafeInteger(contextWindow) && contextWindow >= 1 && contextWindow <= 10_000_000, `Invalid context window for ${id}.`);
    assert(Number.isSafeInteger(maxTokens) && maxTokens >= 1 && maxTokens <= contextWindow, `Invalid output limit for ${id}.`);
    assert(typeof images === 'boolean' && typeof reasoning === 'boolean', `Invalid capabilities for ${id}.`);
    return { id, name: id, reasoning, input: images ? ['text', 'image'] : ['text'], contextWindow, maxTokens };
  });
}

function profilePath(store, name) {
  assert(Object.hasOwn(API_PRESETS, name), 'Unknown API-key profile. Choose openai, berget, or custom.');
  const dir = path.join(store.root, 'auth');
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const stat = fs.lstatSync(dir);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'Host auth directory must be private and owned by the current user.');
  return path.join(dir, `${name}-api-key.json`);
}

export function readApiProfile(store, name) {
  const file = profilePath(store, name);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('Cannot read host API-key profile.'); }
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && stat.size < 65536 && (stat.mode & 0o077) === 0, 'Host API-key profile must be a private regular file owned by the current user.');
    const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
    assert(record.version === 1 && record.provider === name && typeof record.key === 'string' && record.key.length >= 8 && record.key.length <= 4096, 'Invalid host API-key profile.');
    if (name === 'custom') {
      assert(record.url === validateApiBaseUrl(record.url) && record.api === 'openai-completions', 'Invalid custom API profile.');
      record.models = validateModels(record.models);
    } else assert(record.url === API_PRESETS[name].url, 'Invalid host API-key profile.');
    return record;
  } catch { throw new Error('Cannot read host API-key profile (invalid or unsafe file).'); }
  finally { fs.closeSync(fd); }
}

export async function saveApiProfile(store, name, url, key, models) {
  const file = profilePath(store, name);
  if (name === 'custom') {
    url = validateApiBaseUrl(url);
    models = validateModels(models);
  } else assert(url === API_PRESETS[name].url, `The ${name} preset only permits ${API_PRESETS[name].url}.`);
  assert(typeof key === 'string' && key.length >= 8 && key.length <= 4096 && /^[\x21-\x7e]+$/.test(key), 'Invalid API key.');
  const profile = { version: 1, provider: name, url, ...(name === 'custom' ? { api: 'openai-completions', models } : {}), key };
  await withLock(`${file}.lock`, async () => {
    readApiProfile(store, name); // Reject unsafe existing files before replacement.
    atomicWrite(file, `${JSON.stringify(profile)}\n`);
  });
}

export async function logoutApiProfile(store, name) {
  const file = profilePath(store, name);
  await withLock(`${file}.lock`, async () => { readApiProfile(store, name); fs.rmSync(file, { force: true }); });
}

export function apiProfileStatus(store, env = process.env) {
  return Object.entries(API_PRESETS).map(([provider, preset]) => {
    const profilePresent = Boolean(readApiProfile(store, provider));
    const environmentVariable = preset.keyEnv;
    const environmentPresent = environmentVariable ? Boolean(env[environmentVariable]) : false;
    return { provider, profilePresent, ...(environmentVariable ? { environmentVariable, environmentPresent } : {}), credentialPresent: profilePresent || environmentPresent };
  });
}

function terminalQuestion(input, output, prompt, { hidden = false, defaultValue = '' } = {}) {
  return new Promise((resolve, reject) => {
    let value = '';
    let settled = false;
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onEnd);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
    };
    const onSignal = () => { cleanup(); reject(new Error('Login cancelled.')); };
    const onEnd = () => { cleanup(); reject(new Error('Login cancelled.')); };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') { cleanup(); resolve(value || defaultValue); return; }
        if (char === '\u0003' || char === '\u0004') { cleanup(); reject(new Error('Login cancelled.')); return; }
        if (char === '\u007f' || char === '\b') { if (value) { value = value.slice(0, -1); if (!hidden) output.write('\b \b'); } continue; }
        if (char >= ' ' && char !== '\u007f') { value += char; if (!hidden) output.write(char); }
      }
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onEnd);
  });
}

export async function promptApiProfile(store, name, { input = process.stdin, output = process.stdout } = {}) {
  profilePath(store, name);
  assert(input.isTTY && output.isTTY && input.setRawMode, 'API-key login requires an interactive terminal.');
  const ask = (prompt, options) => terminalQuestion(input, output, prompt, options);
  const presetUrl = API_PRESETS[name].url;
  const url = name === 'custom' ? await ask('API base URL (HTTPS, public host, /v1 path): ') : await ask(`API URL [${presetUrl}]: `, { defaultValue: presetUrl });
  let models;
  if (name === 'custom') {
    output.write('Custom endpoints must support OpenAI Chat Completions, streaming, and tool calls. No connection test or model discovery request is made.\n');
    output.write('Enter verified model IDs; provide published context/output limits and model capabilities.\n');
    const toolSupport = (await ask('Endpoint and these models support function/tool calls? [y/N]: ')).toLowerCase() === 'y';
    assert(toolSupport, 'Custom API profiles require verified tool/function-call support.');
    const ids = (await ask('Model IDs (comma-separated): ')).split(',').map(id => id.trim()).filter(Boolean);
    models = [];
    for (const id of ids) {
      const contextWindow = Number(await ask(`${id} context window (tokens): `));
      const maxTokens = Number(await ask(`${id} max output tokens: `));
      const images = (await ask(`${id} accepts image input? [y/N]: `)).toLowerCase() === 'y';
      const reasoning = (await ask(`${id} is a reasoning model? [y/N]: `)).toLowerCase() === 'y';
      models.push({ id, contextWindow, maxTokens, images, reasoning });
    }
  }
  const key = await ask('API key (hidden): ', { hidden: true });
  await saveApiProfile(store, name, url, key, models);
}
