import path from 'node:path';
import os from 'node:os';
import { assert, directory, within, overlap } from './util.js';
import { DEFAULT_PROXY } from './proxy.js';
import { DEFAULT_EXTENSIONS, extensionManifest } from './extensions.js';
import { HINTS, SCHEMA_REFERENCE } from './config-schema.js';

export const ID_PATTERN = /^[a-z0-9]{5}$/;
export const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const RESERVED = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/sys', '/dev', '/run', '/root', '/pis', '/opt/pis'];
const RESERVED_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'ENV', 'BASH_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];

function object(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
  for (const key of Object.keys(value)) assert(keys.includes(key), `Unknown field: ${label}.${key}`);
}
function strings(value, label) {
  assert(Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0), `${label} must be an array of nonempty strings.`);
  assert(new Set(value).size === value.length, `${label} contains duplicates.`);
}

export function safeMount(source, { home = os.homedir(), storage }) {
  assert(!/[\n\r,:]/.test(source), `Mount paths cannot contain commas, colons, or newlines: ${source}`);
  assert(path.normalize(source) === source, `Mount path must be normalized: ${source}`);
  assert(!within(source, home), `Refusing to share the entire home directory or an ancestor: ${source}`);
  assert(!['/', '/home', '/tmp', '/var', '/opt', '/mnt', '/media'].includes(source), `Mount is too broad: ${source}`);
  for (const reserved of RESERVED) assert(!overlap(source, reserved), `Mount conflicts with reserved container path ${reserved}: ${source}`);
  if (storage) assert(!overlap(source, storage), `Mount must not expose or overlap pis storage: ${source}`);
}

export function validate(config, { storage, home = os.homedir(), identity, paths = true } = {}) {
  object(config, ['$schema', 'version', 'id', 'name', 'root', 'image', 'mounts', 'credentials', 'extensions', 'examples', 'hints'], 'project');
  if (config.$schema !== undefined) assert(config.$schema === SCHEMA_REFERENCE, `Use ${SCHEMA_REFERENCE} for $schema.`);
  extensionManifest(config.extensions);
  if (config.hints !== undefined) {
    object(config.hints, Object.keys(HINTS), 'hints');
    assert(Object.values(config.hints).every(value => typeof value === 'string'), 'hints must contain strings.');
  }
  assert(config.version === 1, 'Unsupported configuration version (expected 1).');
  assert(typeof config.id === 'string' && ID_PATTERN.test(config.id), 'Project id must be five lowercase letters/digits.');
  if (config.name !== undefined) assert(typeof config.name === 'string' && NAME_PATTERN.test(config.name), 'Invalid project name (use letters, digits, dot, underscore, or dash; max 64 characters).');
  assert(typeof config.root === 'string' && path.isAbsolute(config.root), 'root must be an absolute path.');
  if (identity) {
    assert(config.id === identity.id && config.root === identity.root, 'Do not edit id or root; use pis --relocate to change the root.');
  }
  object(config.image, ['packages', 'extraInstructions'], 'image');
  strings(config.image.packages, 'image.packages');
  for (const pkg of config.image.packages) assert(/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?(?:=[a-zA-Z0-9.+:~_-]+)?$/.test(pkg), `Invalid apt package: ${pkg}`);
  strings(config.image.extraInstructions, 'image.extraInstructions');
  for (const instruction of config.image.extraInstructions) {
    assert(!/[\n\r]/.test(instruction) && /^RUN\s+\S/.test(instruction) && !/\\\s*$/.test(instruction), 'extraInstructions supports single-line RUN instructions only (no trailing continuation).');
    assert(!/^RUN\s+--mount\b/.test(instruction), 'Build mounts are not supported in extraInstructions.');
  }
  object(config.credentials, ['env', 'proxy'], 'credentials');
  strings(config.credentials.env, 'credentials.env');
  for (const name of config.credentials.env) {
    assert(/^[A-Z_][A-Z0-9_]*$/.test(name), `Invalid credential variable name: ${name}`);
    assert(!RESERVED_ENV.includes(name) && !name.startsWith('PI_') && !name.startsWith('PIS_'), `Reserved environment variable: ${name}`);
  }
  if (config.credentials.proxy !== undefined) {
    const proxy = config.credentials.proxy;
    object(proxy, ['provider', 'keyEnv', 'models', 'maxRequests', 'maxConcurrent'], 'credentials.proxy');
    assert(['openai', 'openai-codex'].includes(proxy.provider), 'Proxy provider must be openai or openai-codex.');
    assert(proxy.provider !== 'openai-codex' || proxy.keyEnv === undefined, 'Codex uses host OAuth credentials; remove keyEnv and use pis --login-codex or --import-codex.');
    assert(proxy.keyEnv === undefined || (typeof proxy.keyEnv === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(proxy.keyEnv) && !RESERVED_ENV.includes(proxy.keyEnv)), 'Invalid proxy keyEnv variable name.');
    assert(config.credentials.env.length === 0, 'Proxy mode requires credentials.env to be empty; never forward real credentials alongside the proxy.');
    if (proxy.models !== undefined) strings(proxy.models, 'credentials.proxy.models');
    if (proxy.maxRequests !== undefined) assert(Number.isInteger(proxy.maxRequests) && proxy.maxRequests >= 1 && proxy.maxRequests <= 100_000, 'proxy.maxRequests must be an integer between 1 and 100000.');
    if (proxy.maxConcurrent !== undefined) assert(Number.isInteger(proxy.maxConcurrent) && proxy.maxConcurrent >= 1 && proxy.maxConcurrent <= 64, 'proxy.maxConcurrent must be an integer between 1 and 64.');
  }
  assert(Array.isArray(config.mounts), 'mounts must be an array.');
  const sources = [config.root];
  for (const mount of config.mounts) {
    object(mount, ['source', 'access'], 'mount');
    assert(typeof mount.source === 'string' && path.isAbsolute(mount.source), 'mount.source must be an absolute path.');
    assert(mount.access === undefined || ['read-only', 'read-write'].includes(mount.access), `Invalid mount access: ${mount.access}`);
    sources.push(mount.source);
  }
  for (const source of sources) {
    safeMount(source, { storage, home });
    if (paths) assert(directory(source) === source, `Mount must use its canonical path (resolve symlinks): ${source}`);
  }
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) assert(!overlap(sources[i], sources[j]), `Mounts overlap: ${sources[i]} and ${sources[j]}`);
  }
  if (config.examples !== undefined) {
    object(config.examples, ['mounts', 'extraInstructions', 'credentials', 'extensions'], 'examples');
    if (config.examples.extensions !== undefined) extensionManifest(config.examples.extensions);
    if (config.examples.credentials !== undefined) {
      object(config.examples.credentials, ['openai', 'codex', 'direct'], 'examples.credentials');
      // Credential examples are inert JSON objects, not active credential modes.
      for (const entry of Object.values(config.examples.credentials)) object(entry, ['env', 'proxy'], 'credential example');
    }
    if (config.examples.mounts !== undefined) {
      assert(Array.isArray(config.examples.mounts), 'examples.mounts must be an array.');
      for (const mount of config.examples.mounts) {
        object(mount, ['source', 'access'], 'example mount');
        assert(typeof mount.source === 'string', 'Example mount source must be a string.');
        assert(mount.access === undefined || ['read-only', 'read-write'].includes(mount.access), 'Invalid example mount access.');
      }
    }
    if (config.examples.extraInstructions !== undefined) strings(config.examples.extraInstructions, 'examples.extraInstructions');
  }
  return config;
}

export function completeConfig(input) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(input)) return input;
  const config = structuredClone(input);
  const fill = (target, values) => {
    if (!record(target)) return;
    for (const [key, value] of Object.entries(values)) if (target[key] === undefined) target[key] = structuredClone(value);
  };
  fill(config, {
    $schema: SCHEMA_REFERENCE, version: 1, image: {}, mounts: [],
    credentials: { env: [], proxy: { ...DEFAULT_PROXY, models: [] } },
    extensions: DEFAULT_EXTENSIONS, examples: {}, hints: {},
  });
  fill(config.image, { packages: [], extraInstructions: [] });
  fill(config.credentials, { env: [] });
  if (record(config.credentials?.proxy)) {
    const proxy = config.credentials.proxy;
    fill(proxy, { models: [], maxRequests: 1000, maxConcurrent: 4 });
    if (proxy.provider === 'openai') fill(proxy, { keyEnv: 'OPENAI_API_KEY' });
  }
  fill(config.hints, HINTS);
  fill(config.examples, {
    mounts: [
      { source: path.join(os.homedir(), 'Projects/shared-library'), access: 'read-only' },
      { source: path.join(os.homedir(), 'Data/test-fixtures'), access: 'read-write' },
    ],
    extraInstructions: ['RUN npm install -g typescript'],
    extensions: ['npm:@beyona/pi-zai-usage@1.1.0'],
    credentials: {},
  });
  fill(config.examples?.credentials, {
    openai: { env: [], proxy: { ...DEFAULT_PROXY, models: [] } },
    codex: { env: [], proxy: { provider: 'openai-codex', models: [], maxRequests: 1000, maxConcurrent: 4 } },
    direct: { env: ['OPENAI_API_KEY'] },
  });
  return config;
}

export function defaults(id, root, name) {
  return completeConfig({
    version: 1, id, ...(name ? { name } : {}), root,
    image: { packages: [], extraInstructions: [] },
    mounts: [], credentials: { env: [], proxy: { ...DEFAULT_PROXY, models: [] } },
    examples: {
      mounts: [
        { source: path.join(os.homedir(), 'Projects/shared-library'), access: 'read-only' },
        { source: path.join(os.homedir(), 'Data/test-fixtures'), access: 'read-write' },
      ],
      extraInstructions: ['RUN npm install -g typescript'],
    },
  });
}
