import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BERGET_MODELS_URL, BERGET_CATALOG_LIMITS, bundledBergetModels, projectBergetCatalog, loadBergetModels, validateBergetModelSettings } from '../src/berget-models.js';

const entry = (id = 'author/chat', extra = {}) => ({ id, name: 'Chat', model_type: 'text', lifecycle_status: 'active', capabilities: { function_calling: true, streaming: true, vision: false }, ...extra });
const list = (...data) => ({ object: 'list', data });
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('bundled fallback includes all four current chat models with independent definitions', () => {
  const models = bundledBergetModels();
  assert.deepEqual(models.map(model => model.id), ['google/gemma-4-31B-it', 'zai-org/GLM-5.3-Flash', 'moonshotai/Kimi-K3.1-Pro', 'mistralai/Mistral-Small-3.2-24B-Instruct-2506']);
  assert.deepEqual(models[3].input, ['text']);
  models[0].input.push('bad'); assert.ok(!bundledBergetModels()[0].input.includes('bad'));
  for (const model of models) assert.ok(model.maxTokens <= model.contextWindow);
});

test('discovery uses only fixed unauthenticated GET, explicit projection and chat/tool/stream filtering', async () => {
  const payload = list(entry('new/chat', { context_length: 64000, max_output_tokens: 4000, capabilities: { function_calling: true, streaming: true, vision: true }, apiKey: '!attack', baseUrl: 'https://evil.invalid', headers: { Authorization: 'secret' }, compat: { attack: true }, pricing: { currency: 'EUR', input: 3, output: 10 } }),
    ...['system-one', 'embedding', 'rerank', 'speech-to-text'].map(model_type => entry(`other/${model_type}`, { model_type })),
    entry('no/tools', { capabilities: { streaming: true } }), entry('no/stream', { capabilities: { function_calling: true } }), entry('gone/chat', { lifecycle_status: 'retired' }));
  const result = await loadBergetModels({ provider: 'berget' }, { fetchImpl: async (url, options) => {
    assert.equal(url, BERGET_MODELS_URL); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { accept: 'application/json' }); assert.ok(options.signal instanceof AbortSignal);
    return response(payload);
  } });
  assert.equal(result.source, 'remote'); assert.equal(result.defaultsUsed, false);
  assert.deepEqual(result.models, [{ id: 'new/chat', name: 'Chat (Berget)', input: ['text', 'image'], reasoning: false, contextWindow: 64000, maxTokens: 4000 }]);
});

test('missing/invalid numeric limits get documented local budgets, names and overrides stay safe', async () => {
  const settings = { provider: 'berget', modelOverrides: { 'author/chat': { contextWindow: 16000, maxTokens: 1000, input: ['text'], reasoning: false } } };
  const result = await loadBergetModels(settings, { fetchImpl: async () => response(list(entry('author/chat', { name: '\u001b[bad', context_length: -1, max_output_tokens: '9999' }))) });
  assert.equal(result.defaultsUsed, true); assert.equal(result.models[0].name, 'author/chat (Berget)');
  assert.equal(result.models[0].contextWindow, 16000); assert.equal(result.models[0].maxTokens, 1000);
  const tiny = projectBergetCatalog(list(entry('author/tiny', { context_length: 512, max_output_tokens: 9000 })));
  assert.equal(tiny.models[0].maxTokens, 512); assert.equal(tiny.defaultsUsed, true);
  assert.ok(!JSON.stringify(result).includes('cost'));
});

test('invalid catalogues fall back without exposing errors, remote body or adding unsafe models', async () => {
  const invalid = [null, {}, list(), list(entry('!execute')), list(entry('duplicate'), entry('duplicate')), list(...Array.from({ length: BERGET_CATALOG_LIMITS.entries + 1 }, () => ({}))), list(...Array.from({ length: BERGET_CATALOG_LIMITS.models + 1 }, (_, index) => entry(`chat/${index}`)))];
  for (const value of invalid) {
    const result = await loadBergetModels({ provider: 'berget' }, { fetchImpl: async () => response(value) });
    assert.equal(result.source, 'fallback'); assert.deepEqual(result.models, bundledBergetModels());
  }
  for (const fetchImpl of [async () => { throw new Error('SECRET upstream exception'); }, async () => new Response('SECRET body', { status: 401 }), async () => new Response('not JSON'), async () => new Response(new Uint8Array(BERGET_CATALOG_LIMITS.bytes + 1)), async () => new Response('{}', { headers: { 'content-length': String(BERGET_CATALOG_LIMITS.bytes + 1) } })]) {
    const result = await loadBergetModels({ provider: 'berget' }, { fetchImpl });
    assert.equal(result.source, 'fallback'); assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('bounded streaming reader cancels overflow and opt-out makes no network request', async () => {
  let cancelled = false;
  const result = await loadBergetModels({ provider: 'berget' }, { fetchImpl: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(32768)); }, cancel() { cancelled = true; } })) });
  assert.equal(result.source, 'fallback'); assert.equal(cancelled, true);
  const offline = await loadBergetModels({ provider: 'berget', discoverModels: false }, { fetchImpl: async () => assert.fail('Opt-out must not fetch') });
  assert.equal(offline.source, 'bundled'); assert.equal(offline.models.length, 4);
  const override = { 'google/gemma-4-31B-it': { contextWindow: 4096, maxTokens: 512 } };
  for (const discoverModels of [false, true]) {
    const result = await loadBergetModels({ provider: 'berget', discoverModels, modelOverrides: override }, { fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal(result.models[0].contextWindow, 4096); assert.equal(result.models[0].maxTokens, 512);
  }
});

test('redirects and slow/stalled catalogues fall back using local fake HTTP only', async t => {
  let destinationHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/destination' }); res.end(); }
    else if (req.url === '/destination') { destinationHits++; res.end(JSON.stringify(list(entry()))); }
    else { res.writeHead(200); res.write('{'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  for (const route of ['/redirect', '/stall']) {
    const result = await loadBergetModels({ provider: 'berget' }, { timeoutMs: 100, fetchImpl: (url, options) => { assert.equal(url, BERGET_MODELS_URL); return fetch(`http://127.0.0.1:${server.address().port}${route}`, options); } });
    assert.equal(result.source, 'fallback');
  }
  assert.equal(destinationHits, 0);
});

test('override validation rejects executable/unbounded metadata and non-Berget settings', () => {
  for (const settings of [
    { provider: 'openai', discoverModels: true }, { provider: 'berget', discoverModels: 'yes' },
    { provider: 'berget', modelOverrides: [] }, { provider: 'berget', modelOverrides: { '!exec': {} } },
    ...[{ contextWindow: 100, maxTokens: 200 }, { contextWindow: 100, maxTokens: 20, baseUrl: 'https://evil' }, { contextWindow: 100, maxTokens: 20, input: ['image'] }, { contextWindow: 100, maxTokens: 20, reasoning: '!exec' }].map(value => ({ provider: 'berget', modelOverrides: { 'author/chat': value } })),
  ]) assert.throws(() => validateBergetModelSettings(settings));
  assert.doesNotThrow(() => validateBergetModelSettings({ provider: 'berget', discoverModels: false, modelOverrides: { 'author/chat': { contextWindow: 100, maxTokens: 20 } } }));
});
