import { assert } from './util.js';

export const IMAGE_AGENT_DIR = '/opt/pis/agent';
export const DEFAULT_EXTENSIONS = ['npm:pi-web-access@0.40.0', 'npm:pi-subagents@0.88.1'];

export function extensionSource(source) {
  assert(typeof source === 'string', 'Extension sources must be strings.');
  const match =
    /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@([A-Za-z0-9][A-Za-z0-9.+_-]*))?$/.exec(
      source,
    );
  assert(
    match && match[1].length <= 214,
    'Invalid extension source. Use npm:<package>[@version-or-tag]; local paths, URLs, and git sources are not supported yet.',
  );
  return {
    source,
    name: match[1],
    version: match[2],
    path: `${IMAGE_AGENT_DIR}/npm/node_modules/${match[1]}`,
  };
}

export function extensionManifest(sources = DEFAULT_EXTENSIONS) {
  assert(Array.isArray(sources), 'extensions must be an array of install sources.');
  const entries = sources.map(extensionSource);
  assert(
    new Set(entries.map((entry) => entry.name)).size === entries.length,
    'Duplicate extension package (including different versions).',
  );
  return entries;
}

// Explicit opt-in only: retain custom sources/order and pins, add missing defaults.
export function withDefaultExtensions(sources) {
  const names = new Set(extensionManifest(sources).map((entry) => entry.name));
  return [
    ...sources,
    ...DEFAULT_EXTENSIONS.filter((source) => !names.has(extensionSource(source).name)),
  ];
}

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
