import assert from 'node:assert/strict';
import { interpretStockClarification } from '../server/stockClarificationInterpreter.js';

const originalFetch = globalThis.fetch;
const envChanges = { GEMINI_API_KEY: 'clarification-test-key', GEMINI_MODEL_NAME: 'gemini-3.1-flash-lite',
  GROQ_API_KEY: '', VITE_VOICE_MODEL_API_KEY: '', LLM_PROVIDER: 'gemini', LLM_DISABLE_FALLBACK: '1' };
const originalEnv = Object.fromEntries(Object.keys(envChanges).map((key) => [key, process.env[key]]));
const action = { type: 'add_stock', productName: 'Camiseta', qty: 2, resolution: { candidateIds: ['candidate-1', 'candidate-2'] } };
let responseData;
let responseStatus = 200;
let rawContent;
let calls = 0;
let passed = 0;
let networkFailure = false;

const run = async (name, data, expected, sourceText = 'La primera, camiseta azul, son 3') => {
  responseData = data;
  rawContent = undefined;
  responseStatus = 200;
  const result = await interpretStockClarification({ sourceText, action });
  assert.equal(result.kind, expected, name);
  assert.deepEqual(Object.keys(result.trace).sort(), ['stage', 'provider', 'model', 'latencyMs', 'usage', 'ok'].sort());
  assert.equal(result.trace.stage, 'clarify');
  assert.equal(result.trace.provider, 'gemini');
  assert.equal(result.trace.model, 'gemini-3.1-flash-lite');
  assert.equal(result.trace.ok, !['invalid', 'unavailable'].includes(expected));
  assert.equal(typeof result.trace.latencyMs, 'number');
  if (expected === 'invalid') assert.equal(result.reason, 'invalid_clarification');
  passed++;
  console.log(`PASS ${name}`);
  return result;
};

try {
  Object.assign(process.env, envChanges);
  globalThis.fetch = async (_url, request) => {
    calls++;
    if (networkFailure) throw new Error('simulated transport failure');
    const body = JSON.parse(request.body);
    assert.match(body.messages[0].content, /Etapa: clarify\./);
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.model, 'gemini-3.1-flash-lite');
    if (responseStatus !== 200) return new Response('{"error":"rejected request"}', { status: responseStatus });
    return new Response(JSON.stringify({ choices: [{ message: { content: rawContent ?? JSON.stringify(responseData) } }],
      usage: { total_tokens: 20 } }), { status: 200 });
  };

  responseStatus = 400;
  const unavailable = await interpretStockClarification({ sourceText: 'La primera', action });
  assert.equal(unavailable.kind, 'unavailable');
  assert.equal(unavailable.reason, 'clarification_unavailable');
  assert.equal(unavailable.trace.ok, false);
  assert.equal(unavailable.trace.provider, 'gemini');
  assert.equal(calls, 1);
  passed++;
  console.log('PASS provider HTTP 400 has no semantic result');

  responseStatus = 200;
  rawContent = '{"kind":';
  const malformed = await interpretStockClarification({ sourceText: 'La primera', action });
  assert.equal(malformed.kind, 'invalid');
  assert.equal(malformed.reason, 'invalid_clarification');
  assert.equal(malformed.trace.ok, false);
  passed++;
  console.log('PASS malformed model JSON');

  networkFailure = true;
  const transportFailure = await interpretStockClarification({ sourceText: 'La primera', action });
  assert.equal(transportFailure.kind, 'unavailable');
  assert.equal(transportFailure.reason, 'clarification_unavailable');
  assert.equal(transportFailure.trace.ok, false);
  networkFailure = false;
  passed++;
  console.log('PASS transport error has no semantic result');

  await run('malformed kind', { kind: 'uncertain', evidence: 'La primera' }, 'invalid');
  await run('candidate outside offered IDs', { kind: 'existing', productId: 'other', evidence: 'La primera' }, 'invalid');
  await run('ungrounded evidence', { kind: 'new', evidence: 'creá un producto' }, 'invalid');
  await run('valid existing', { kind: 'existing', productId: 'candidate-1', evidence: 'La primera' }, 'existing');
  await run('valid new', { kind: 'new', evidence: 'creá otro producto' }, 'new', 'Sí, creá otro producto');
  const correctedAction = { type: 'add_stock', productName: 'Camiseta azul', qty: 3, fieldEvidence: { qty: 'son 3' } };
  await run('valid correction', { kind: 'correction', evidence: 'camiseta azul, son 3', correctedAction }, 'correction');
  await run('hidden resolution rejected', { kind: 'correction', evidence: 'son 3', correctedAction: {
    ...correctedAction, resolution: { kind: 'existing', productId: 'other' } } }, 'invalid');
  await run('hidden product ID rejected', { kind: 'correction', evidence: 'son 3', correctedAction: {
    ...correctedAction, productId: 'other' } }, 'invalid');
  await run('uncited corrected quantity rejected', { kind: 'correction', evidence: 'son 3', correctedAction: {
    ...correctedAction, fieldEvidence: { qty: 'son 5' } } }, 'invalid');
  await run('fractional corrected quantity rejected', { kind: 'correction', evidence: 'son 3', correctedAction: {
    ...correctedAction, qty: 3.5 } }, 'invalid');
  await run('null corrected quantity rejected', { kind: 'correction', evidence: 'son 3', correctedAction: {
    ...correctedAction, qty: null } }, 'invalid');
  await run('unrelated cannot mutate', { kind: 'unrelated', correctedAction }, 'invalid');
  await run('valid unrelated', { kind: 'unrelated' }, 'unrelated', '¿A qué hora abre el local?');
  await run('array schema rejected', [{ kind: 'unrelated' }], 'invalid');
  process.env.GEMINI_API_KEY = '';
  const beforeMissingKey = calls;
  const missingKey = await interpretStockClarification({ sourceText: 'La primera', action });
  assert.equal(missingKey.kind, 'unavailable');
  assert.equal(calls, beforeMissingKey);
  passed++;
  console.log(`${passed} clarification interpreter checks passed`);
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

