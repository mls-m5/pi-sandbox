import { assert } from './util.js';

export const BERGET_MODELS_URL = 'https://api.berget.ai/v1/models';
export const BERGET_CATALOG_LIMITS = Object.freeze({
  bytes: 512 * 1024,
  entries: 256,
  models: 100,
  timeoutMs: 5000,
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const tokens = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 10_000_000;
// Offline snapshot of the four chat models in Berget's public catalogue. These
// are local budgeting defaults, NOT verified provider output ceilings.
// GLM context: Berget's GA announcement publishes 320000 tokens. Its 65536
// output budget leaves more room for thinking + answer than the old 8192 cap;
// this is a tuning choice, not a verified Berget output limit or effort setting.
const BUNDLED = [
  ['google/gemma-4-31B-it', 'Gemma 4 31B', true, 262144],
  ['zai-org/GLM-5.3-Flash', 'GLM 5.3 Flash', true, 320000, 65536],
  ['moonshotai/Kimi-K3.1-Pro', 'Kimi K3.1 Pro', true, 32768],
  ['mistralai/Mistral-Small-3.2-24B-Instruct-2506', 'Mistral Small 3.2 24B', false, 32768],
];
function modelDefinition(id, name, images, contextWindow = 32768, maxTokens = 8192) {
  return {
    id,
    name: `${name} (Berget)`,
    reasoning: false,
    input: images ? ['text', 'image'] : ['text'],
    contextWindow,
    maxTokens: Math.min(maxTokens, contextWindow),
  };
}
export function bundledBergetModels() {
  return BUNDLED.map(([id, name, images, context, output]) =>
    modelDefinition(id, name, images, context, output),
  );
}
export function validateBergetModelSettings(settings) {
  if (settings.discoverModels !== undefined || settings.modelOverrides !== undefined)
    assert(
      settings.provider === 'berget',
      'Model discovery/overrides are currently supported only for Berget.',
    );
  assert(
    settings.discoverModels === undefined || typeof settings.discoverModels === 'boolean',
    'proxy.discoverModels must be a boolean.',
  );
  const overrides = settings.modelOverrides;
  if (overrides === undefined) return;
  assert(
    overrides &&
      typeof overrides === 'object' &&
      !Array.isArray(overrides) &&
      Object.keys(overrides).length <= 100,
    'proxy.modelOverrides must contain at most 100 model IDs.',
  );
  for (const [id, value] of Object.entries(overrides)) {
    assert(
      ID.test(id) && value && typeof value === 'object' && !Array.isArray(value),
      'Invalid Berget model override.',
    );
    assert(
      Object.keys(value).every((key) =>
        ['contextWindow', 'maxTokens', 'reasoning', 'input'].includes(key),
      ),
      'Berget overrides permit only contextWindow, maxTokens, reasoning and input.',
    );
    assert(
      tokens(value.contextWindow) &&
        tokens(value.maxTokens) &&
        value.maxTokens <= value.contextWindow,
      'Berget overrides require valid contextWindow and maxTokens (output must not exceed context).',
    );
    assert(
      value.reasoning === undefined || typeof value.reasoning === 'boolean',
      'Invalid Berget reasoning override.',
    );
    assert(
      value.input === undefined ||
        (Array.isArray(value.input) &&
          value.input.length >= 1 &&
          value.input.length <= 2 &&
          value.input.includes('text') &&
          new Set(value.input).size === value.input.length &&
          value.input.every((item) => ['text', 'image'].includes(item))),
      'Invalid Berget input override.',
    );
  }
}
function applyOverrides(models, overrides = {}) {
  return models.map((model) => {
    if (!Object.hasOwn(overrides, model.id)) return model;
    const value = overrides[model.id];
    return {
      ...model,
      contextWindow: value.contextWindow,
      maxTokens: value.maxTokens,
      ...(value.reasoning !== undefined ? { reasoning: value.reasoning } : {}),
      ...(value.input ? { input: [...value.input] } : {}),
    };
  });
}
export function projectBergetCatalog(source) {
  assert(
    source?.object === 'list' &&
      Array.isArray(source.data) &&
      source.data.length <= BERGET_CATALOG_LIMITS.entries,
    'Invalid Berget catalog.',
  );
  const models = [],
    ids = new Set();
  let defaultsUsed = false;
  for (const item of source.data) {
    // Never offer embeddings, rerank, speech or System One/decision models in
    // Pi's chat picker. Missing tool/streaming capabilities are not guessed.
    if (
      !item ||
      !['text', 'chat'].includes(item.model_type) ||
      item.capabilities?.function_calling !== true ||
      item.capabilities?.streaming !== true ||
      item.capabilities?.embeddings === true
    )
      continue;
    if (
      (item.lifecycle_status !== undefined &&
        !['active', 'preview', 'deprecated'].includes(item.lifecycle_status)) ||
      item.lifecycle_state === 'retired'
    )
      continue;
    assert(
      typeof item.id === 'string' && ID.test(item.id) && !ids.has(item.id),
      'Invalid or duplicate Berget model ID.',
    );
    ids.add(item.id);
    const name =
      typeof item.name === 'string' &&
      item.name.length > 0 &&
      item.name.length <= 128 &&
      !CONTROLS.test(item.name)
        ? item.name
        : item.id;
    const baseline = bundledBergetModels().find((model) => model.id === item.id);
    // Optional numeric limits are projected, never provider URLs, credentials,
    // headers, commands, compat objects or EUR prices disguised as USD costs.
    const context = tokens(item.context_length)
      ? item.context_length
      : baseline?.contextWindow || 32768;
    const output =
      tokens(item.max_output_tokens) && item.max_output_tokens <= context
        ? item.max_output_tokens
        : Math.min(baseline?.maxTokens || 8192, context);
    defaultsUsed ||=
      !tokens(item.context_length) ||
      !tokens(item.max_output_tokens) ||
      item.max_output_tokens > context;
    models.push(modelDefinition(item.id, name, item.capabilities.vision === true, context, output));
    assert(models.length <= BERGET_CATALOG_LIMITS.models, 'Too many Berget chat models.');
  }
  assert(models.length > 0, 'No compatible Berget chat models.');
  return { models, defaultsUsed };
}
async function fetchCatalog(fetchImpl, timeoutMs) {
  const response = await fetchImpl(BERGET_MODELS_URL, {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  let reader;
  try {
    assert(response.ok && !response.redirected, 'Berget catalog unavailable.');
    assert(
      Number(response.headers.get('content-length') || 0) <= BERGET_CATALOG_LIMITS.bytes,
      'Berget catalog too large.',
    );
    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assert(bytes <= BERGET_CATALOG_LIMITS.bytes, 'Berget catalog too large.');
      chunks.push(value);
    }
    return projectBergetCatalog(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))),
    );
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    } else await response.body?.cancel();
  }
}
export async function loadBergetModels(
  settings = { provider: 'berget' },
  { fetchImpl = globalThis.fetch, timeoutMs = BERGET_CATALOG_LIMITS.timeoutMs } = {},
) {
  validateBergetModelSettings(settings);
  let result = { models: bundledBergetModels(), defaultsUsed: true },
    source = 'bundled';
  if (settings.discoverModels !== false) {
    try {
      result = await fetchCatalog(fetchImpl, timeoutMs);
      source = 'remote';
    } catch {
      source = 'fallback';
    } // Fixed status only: no raw HTTP body/error/URL logs.
  }
  return { ...result, models: applyOverrides(result.models, settings.modelOverrides), source };
}
