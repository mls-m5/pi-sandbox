import path from 'node:path';
import { Store } from './store.js';
import { ID_PATTERN } from './config.js';
import { assert } from './util.js';
import { launch } from './container.js';

// Local host selection only. No project selection/configuration comes from the
// browser or agent RPC. Do not refresh/rewrite explicit project configuration.
export function resolveWebProjects(selectors, store = new Store()) {
  assert(
    Array.isArray(selectors) && selectors.length >= 1 && selectors.length <= 8,
    'Choose 1–8 already registered Pi projects.',
  );
  const selected = selectors.map((selector) => {
    assert(
      typeof selector === 'string' && selector.length > 0 && selector.length <= 128,
      'Invalid project selector.',
    );
    const found = store.select(process.cwd(), selector);
    const config = store.load(found.id);
    assert(
      config.agent === 'pi',
      'Web project mode supports configured Pi projects only, not Claude.',
    );
    return {
      id: config.id,
      root: config.root,
      label: (config.name || config.id).slice(0, 80),
      storeRoot: store.root,
    };
  });
  assert(
    new Set(selected.map((project) => project.id)).size === selected.length,
    'The same project was selected more than once.',
  );
  return selected;
}

export function resolveConnectProject(selector, store = new Store()) {
  if (selector === undefined) return resolveWebProjects([store.select(process.cwd()).id], store)[0];
  const projects = store.all();
  assert(
    typeof selector === 'string' && selector.length > 0 && selector.length <= 128,
    'Invalid project selector.',
  );
  const exact = projects.find((project) => project.id === selector || project.name === selector);
  const matches = exact
    ? [exact]
    : projects.filter((project) => path.basename(project.root) === selector);
  assert(
    matches.length > 0,
    'No registered project matches. Use pis --list or explicit --project ID.',
  );
  if (matches.length !== 1)
    throw Object.assign(
      new Error(
        'Multiple registered projects have this folder name. Use --project with a unique ID or registered name.',
      ),
      { code: 'CONNECT_PROJECT_AMBIGUOUS' },
    );
  return resolveWebProjects([matches[0].id], store)[0];
}

export async function runProjectRpc(store, id, { startupProgress, webGitApproval } = {}) {
  assert(typeof id === 'string' && ID_PATTERN.test(id), 'Expected one registered project ID.');
  const config = store.load(id);
  assert(config.agent === 'pi', 'Web RPC does not override a project configured for Claude.');
  // launch() re-reads under the existing exclusive project lock and enforces
  // webRpc again, preventing a preflight-to-launch agent/configuration race.
  return launch(store, config, {
    cwd: config.root,
    mode: 'pi',
    args: ['--mode', 'rpc'],
    webRpc: true,
    startupProgress,
    webGitApproval,
  });
}
