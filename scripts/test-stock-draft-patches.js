import assert from 'node:assert/strict';
import { applyStockDraftPatch, interpretStockDraftPatch } from '../server/stockDraftPatches.js';

const actions = [
  { itemId: 'stable-a', type: 'add_stock', productName: 'Producto', size: '250 ml', qty: 2, price: 10,
    evidence: 'dos unidades', fieldEvidence: { qty: 'dos', attributes: ['original'] },
    resolution: { kind: 'existing', productId: 'candidate-a' }, candidates: [{ id: 'candidate-a' }] },
  { itemId: 'stable-b', type: 'add_stock', productName: 'Otro', qty: 1, nested: { preserve: true } },
  { itemId: 'stable-c', type: 'add_stock', productName: 'Tercero', qty: 1 },
];
const questions = [{ id: 'question-a', itemIds: ['stable-a', 'stable-c'], question: '¿Qué corregimos?', evidence: 'Producto' }];
const sourceText = 'el primero es caja de 12 sobres, son 3, sin precio; sacá el tercero';
const set = (fields = { qty: 3 }, evidence = { qty: 'son 3' }, itemId = 'stable-a') => ({ type: 'set_fields', itemId, fields, evidence });
const patch = (...changes) => ({ kind: 'patch', questionId: 'question-a', changes });
const apply = (value, extra = {}) => applyStockDraftPatch({ actions, questions, sourceText, patch: value, ...extra });
const before = JSON.stringify({ actions, questions });
let checks = 0;
const test = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };

test('quantity edit retains stable IDs, catalog resolution, untouched bytes and evidence', () => {
  const result = apply(patch(set()));
  assert.equal(result.ok, true);
  assert.deepEqual(result.actions.map((action) => action.itemId), actions.map((action) => action.itemId));
  assert.equal(result.actions[0].qty, 3);
  assert.equal(result.actions[0].resolution, actions[0].resolution);
  assert.equal(result.actions[0].candidates, actions[0].candidates);
  assert.equal(result.actions[0].evidence, actions[0].evidence);
  assert.equal(result.actions[1], actions[1]);
  assert.equal(JSON.stringify(result.actions[1]), JSON.stringify(actions[1]));
  assert.deepEqual(result.actions[0].fieldEvidence, { qty: 'son 3', attributes: ['original'] });
});
test('arbitrary presentation clears resolution and merges literal field evidence', () => {
  const result = apply(patch(set({ size: 'caja de 12 sobres', price: null }, { size: 'caja de 12 sobres', price: 'sin precio' })));
  assert.equal(result.ok, true);
  assert.equal(result.actions[0].size, 'caja de 12 sobres');
  assert.equal(result.actions[0].price, null);
  assert.equal(Object.hasOwn(result.actions[0], 'resolution'), false);
  assert.equal(Object.hasOwn(result.actions[0], 'candidates'), false);
  assert.deepEqual(result.actions[0].fieldEvidence.attributes, ['original', 'caja de 12 sobres']);
  assert.equal(result.actions[0].fieldEvidence.qty, 'dos');
});
test('null identity clear and price-only edits', () => {
  assert.equal(apply(patch(set({ size: null }, { size: 'sin precio' }))).actions[0].size, null);
  const result = apply(patch(set({ price: 0 }, { price: 'sin precio' })));
  assert.equal(result.actions[0].resolution, actions[0].resolution);
});
test('identity patch removes old reference and identity decisions before a fresh audit', () => {
  const prior = { ...actions[0], resolvedReferences: ['old reference'], repeatClarification: { kind: 'distinct' },
    identityAttributes: { model: 'old' }, needsDifferentiator: true, clarificationEvidence: { text: 'old answer' } };
  const result = apply(patch(set({ size: 'caja de 12 sobres' }, { size: 'caja de 12 sobres' })), { actions: [prior, ...actions.slice(1)] });
  assert.equal(result.ok, true);
  for (const key of ['resolvedReferences', 'repeatClarification', 'identityAttributes', 'needsDifferentiator', 'clarificationEvidence', 'resolution', 'candidates']) {
    assert.equal(Object.hasOwn(result.actions[0], key), false, key);
  }
  assert.deepEqual(prior.resolvedReferences, ['old reference']);
});
test('removal preserves order and remaining stable IDs', () => {
  const result = apply(patch({ type: 'remove_item', itemId: 'stable-c', evidence: 'sacá el tercero' }, set()));
  assert.deepEqual(result.actions.map((action) => action.itemId), ['stable-a', 'stable-b']);
  assert.deepEqual(result.removedItemIds, ['stable-c']);
  assert.deepEqual(result.changedItemIds, ['stable-a']);
});
const invalidCases = [
  ['unknown question', { ...patch(set()), questionId: 'unknown' }],
  ['outside offered scope', patch(set({ qty: 3 }, { qty: 'son 3' }, 'stable-b'))],
  ['candidate ID', patch(set({ qty: 3 }, { qty: 'son 3' }, 'candidate-a'))],
  ['duplicate item', patch(set(), set())],
  ['unknown patch key', { ...patch(set()), productId: 'hidden' }],
  ['unknown change key', patch({ ...set(), resolution: {} })],
  ['hidden fields', patch(set({ productId: 'hidden' }, { productId: 'son 3' }))],
  ['missing evidence per field', patch(set({ qty: 3, size: 'caja' }, { qty: 'son 3' }))],
  ['extra evidence', patch(set({ qty: 3 }, { qty: 'son 3', price: 'son 3' }))],
  ['old evidence', patch(set({ qty: 3 }, { qty: 'dos' }))],
  ['empty quote', patch(set({ qty: 3 }, { qty: ' ' }))],
  ['empty name', patch(set({ productName: '' }, { productName: 'son 3' }))],
  ['null name', patch(set({ productName: null }, { productName: 'son 3' }))],
  ['empty patch', patch()],
  ['oversized patch', patch(...Array.from({ length: 101 }, () => set()))],
  ['empty fields', patch(set({}, {}))],
  ['new action', patch({ type: 'add_stock', itemId: 'stable-a', evidence: 'son 3' })],
  ['uncited removal', patch({ type: 'remove_item', itemId: 'stable-a', evidence: 'sacá el primero' })],
  ...[null, 0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, '3'].map((qty) => [`bad qty ${qty}`, patch(set({ qty }, { qty: 'son 3' }))]),
  ...[-1, 1.2, Number.MAX_SAFE_INTEGER + 1, '3'].map((price) => [`bad price ${price}`, patch(set({ price }, { price: 'son 3' }))]),
];
for (const [name, value] of invalidCases) test(name, () => assert.equal(apply(value).ok, false));
test('all-item removal requires cancellation', () => {
  const result = apply(patch({ type: 'remove_item', itemId: 'stable-a', evidence: 'son 3' }), {
    actions: [actions[0]], questions: [{ ...questions[0], itemIds: ['stable-a'] }],
  });
  assert.equal(result.reason, 'cannot_remove_all_items');
});
test('confirmation preserves every action and validates question and evidence', () => {
  const confirmation = { kind: 'confirm', questionId: 'question-a', evidence: 'el primero' };
  const result = apply(confirmation);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedItemIds, []);
  assert.deepEqual(result.removedItemIds, []);
  assert.equal(result.actions[0], actions[0]);
  assert.equal(apply({ ...confirmation, questionId: 'missing' }).ok, false);
  assert.equal(apply({ ...confirmation, evidence: 'other answer' }).ok, false);
  assert.equal(apply({ ...confirmation, changes: [] }).ok, false);
});
test('invalid and duplicate context IDs fail closed', () => {
  assert.equal(apply(patch(set()), { actions: [{ ...actions[0], itemId: undefined }] }).ok, false);
  assert.equal(apply(patch(set()), { actions: [actions[0], actions[0]] }).ok, false);
  assert.equal(apply(patch(set()), { questions: [questions[0], questions[0]] }).ok, false);
});
test('input remains unchanged after every success and rejection', () => assert.equal(JSON.stringify({ actions, questions }), before));

const originalFetch = globalThis.fetch;
const env = { GEMINI_API_KEY: 'offline-test-key', GEMINI_MODEL_NAME: 'gemini-3.5-flash-lite',
  GROQ_API_KEY: '', VITE_VOICE_MODEL_API_KEY: '', LLM_PROVIDER: 'gemini', LLM_DISABLE_FALLBACK: '1' };
const originalEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
let payload = patch(set());
let mode = 'ok';
let calls = 0;
let requestedModels = [];
const interpret = () => interpretStockDraftPatch({ sourceText, actions, questions });
try {
  Object.assign(process.env, env);
  globalThis.fetch = async (_url, request) => {
    calls++;
    const body = JSON.parse(request.body);
    requestedModels.push(body.model);
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 2048);
    assert.ok(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'].includes(body.model));
    assert.match(body.messages[0].content, /Etapa: draft_patch\./);
    if (mode === 'network') throw new Error('offline transport test');
    if (mode === 'http') return new Response('rejected', { status: 401 });
    if (mode === 'response_json') return new Response('{');
    return new Response(JSON.stringify({ choices: [{ message: { content: mode === 'malformed' ? '{"kind":' : JSON.stringify(payload) } }],
      usage: { total_tokens: 42, private_data: 'must not be traced' } }));
  };
  for (const [name, value, kind] of [
    ['valid patch', patch(set()), 'patch'],
    ['unrelated', { kind: 'unrelated' }, 'unrelated'],
    ['semantic uncertainty', { kind: 'needs_clarification' }, 'needs_clarification'],
    ['semantic confirmation', { kind: 'confirm', questionId: 'question-a', evidence: 'el primero' }, 'confirm'],
    ['confirmation unknown question', { kind: 'confirm', questionId: 'missing', evidence: 'el primero' }, 'invalid'],
    ['unrelated cannot mutate', { kind: 'unrelated', changes: [set()] }, 'invalid'],
    ['invalid patch is not applied', patch(set({ qty: 0 }, { qty: 'son 3' })), 'invalid'],
    ['model array', [{ kind: 'unrelated' }], 'invalid'],
  ]) {
    payload = value;
    const result = await interpret();
    test(`interpreter ${name}`, () => {
      assert.equal(result.kind, kind);
      assert.deepEqual(Object.keys(result.trace).sort(), ['stage', 'provider', 'model', 'latencyMs', 'usage', 'ok'].sort());
      assert.equal(result.trace.stage, 'draft_patch');
      assert.equal(result.trace.provider, 'gemini');
      assert.equal(result.trace.ok, kind !== 'invalid');
      assert.deepEqual(result.trace.usage, { total_tokens: 42 });
      if (kind === 'patch') { assert.equal(result.actions[0].qty, 3); assert.deepEqual(result.patch, value); }
    });
  }
  payload = patch(set());
  requestedModels = [];
  const longAnswer = await interpretStockDraftPatch({ sourceText: sourceText.padEnd(700, ' '), actions, questions });
  test('long answers retain primary model preference', () => {
    assert.equal(longAnswer.kind, 'patch');
    assert.deepEqual(requestedModels, ['gemini-3.5-flash-lite']);
  });
  for (const [nextMode, expected] of [['http', 'unavailable'], ['network', 'unavailable'], ['malformed', 'invalid'], ['response_json', 'invalid']]) {
    mode = nextMode;
    const result = await interpret();
    test(`${mode} failure separation`, () => { assert.equal(result.kind, expected); assert.equal(result.trace.ok, false); });
  }
  process.env.GEMINI_API_KEY = '';
  const beforeMissing = calls;
  const missing = await interpret();
  test('missing provider stays unavailable without fetch', () => { assert.equal(missing.kind, 'unavailable'); assert.equal(calls, beforeMissing); });
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
console.log(`${checks} stock draft patch checks passed`);
