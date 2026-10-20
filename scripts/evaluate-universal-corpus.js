import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hasAnyLlmApiKey } from '../server/llmChatClient.js';
import { interpretUniversalIntent } from '../server/universalIntentInterpreter.js';
import { universalEvaluationDefaults, universalIntentCorpus } from './fixtures/universal-intent-corpus.js';

const semanticAction = (action) => {
  const target = action.target?.kind === 'new'
    ? { kind: 'new', sku: action.target.sku }
    : action.target?.kind === 'existing'
      ? Object.fromEntries(['kind', 'skuId', 'clientId', 'partyId', 'pedidoId'].filter((key) => Object.hasOwn(action.target, key)).map((key) => [key, action.target[key]]))
      : null;
  const projected = { type: action.type };
  if (target) projected.target = target;
  for (const key of ['quantity', 'price', 'salePrice', 'amount', 'reason', 'changes', 'order', 'initialStock']) {
    if (Object.hasOwn(action, key)) projected[key] = action[key];
  }
  if (action.destination) projected.destination = Object.fromEntries(['clientId', 'partyId'].filter((key) => Object.hasOwn(action.destination, key)).map((key) => [key, action.destination[key]]));
  if (action.reconciliation) {
    const { expectedProductRevision, expectedFingerprint, ...reconciliation } = action.reconciliation;
    projected.reconciliation = reconciliation;
  }
  return projected;
};

const expectedAction = (expected) => {
  const projected = { type: expected.type };
  if (Object.hasOwn(expected, 'skuId')) projected.target = { kind: 'existing', skuId: expected.skuId };
  if (Object.hasOwn(expected, 'clientId')) projected.target = { kind: 'existing', clientId: expected.clientId };
  if (Object.hasOwn(expected, 'partyId')) projected.target = { kind: 'existing', partyId: expected.partyId };
  if (Object.hasOwn(expected, 'pedidoId')) projected.target = { kind: 'existing', pedidoId: expected.pedidoId };
  if (Object.hasOwn(expected, 'newSku')) projected.target = { kind: 'new', sku: expected.newSku };
  for (const key of ['quantity', 'price', 'salePrice', 'amount', 'reason', 'changes', 'order', 'initialStock']) {
    if (Object.hasOwn(expected, key)) projected[key] = expected[key];
  }
  return projected;
};

export function compareUniversalGold(fixture, result) {
  const expected = fixture.expected;
  if (expected.kind === 'no_ready_plan') {
    return ['invalid', 'clarification'].includes(result.kind)
      ? []
      : [`Se esperaba cierre sin plan (aclaración o rechazo); se recibió ${result.kind}.`];
  }
  if (result.kind !== expected.kind) return [`kind: esperado ${expected.kind}, recibido ${result.kind}`];
  if (expected.kind === 'clarification') return [];
  if (expected.kind === 'answer') {
    if (result.plan) return ['Una consulta no puede incluir un plan de mutación.'];
    if (!Array.isArray(result.queries)) return ['Falta la lista de consultas autorizadas.'];
    if (!Array.isArray(result.answer?.items)) return ['Faltan los datos de respuesta del snapshot.'];
    const normalizeQuery = ({ itemId, ...query }) => query;
    const normalizeItem = ({ itemId, ...item }) => item;
    const actualQueries = result.queries.map(normalizeQuery);
    const wantedQueries = expected.queries;
    const actualItems = result.answer.items.map(normalizeItem);
    const wantedItems = expected.answerItems;
    try {
      assert.deepStrictEqual(actualQueries, wantedQueries);
      assert.deepStrictEqual(actualItems, wantedItems);
      return [];
    } catch {
      return [`consultas/datos: esperado ${JSON.stringify({ queries: wantedQueries, items: wantedItems })}, recibido ${JSON.stringify({ queries: actualQueries, items: actualItems })}`];
    }
  }
  if (!Array.isArray(result.plan?.actions)) return ['Falta la lista de acciones del plan listo.'];
  const actual = result.plan.actions.map(semanticAction);
  const wanted = expected.actions.map(expectedAction);
  for (let index = 0; index < expected.actions.length; index += 1) {
    const alternatives = expected.actions[index].reasonAnyOf;
    if (!alternatives) continue;
    const reason = String(actual[index]?.reason ?? '').toLocaleLowerCase();
    if (!alternatives.some((phrase) => reason.includes(phrase.toLocaleLowerCase()))) {
      return [`actions[${index}].reason: no coincide con los conceptos esperados (${alternatives.join(' / ')}).`];
    }
    delete actual[index].reason;
  }
  try {
    assert.deepStrictEqual(actual, wanted);
    return [];
  } catch {
    return [`acciones: esperado ${JSON.stringify(wanted)}, recibido ${JSON.stringify(actual)}`];
  }
}

const fakeModelJson = (fixture) => {
  if (fixture.expected.kind === 'clarification' || fixture.expected.kind === 'no_ready_plan') {
    return { contractVersion: 1, kind: 'clarification', question: '¿Podés precisar la referencia?' };
  }
  if (fixture.expected.kind === 'answer') {
    const queries = fixture.expected.queries.map((query, index) => ({ itemId: `sim-query-${index + 1}`, ...structuredClone(query) }));
    return { contractVersion: 1, kind: 'query', queries,
      evidence: queries.map(({ itemId }) => ({ itemId, quote: fixture.sourceText })) };
  }
  const actions = fixture.expected.actions.map((entry, index) => {
    const action = { itemId: `sim-item-${index + 1}`, type: entry.type };
    if (entry.skuId) action.target = { kind: 'existing', skuId: entry.skuId };
    if (entry.clientId) action.target = { kind: 'existing', clientId: entry.clientId };
    if (entry.pedidoId) action.target = { kind: 'existing', pedidoId: entry.pedidoId };
    if (entry.newSku) action.target = { kind: 'new', sku: structuredClone(entry.newSku) };
    for (const key of ['quantity', 'price', 'amount', 'reason', 'changes']) if (Object.hasOwn(entry, key)) action[key] = structuredClone(entry[key]);
    if (entry.reasonAnyOf) action.reason = entry.reasonAnyOf[0];
    return action;
  });
  return { contractVersion: 1, kind: 'proposal', actions,
    evidence: actions.map(({ itemId }) => ({ itemId, quote: fixture.sourceText })) };
};

const evaluateFixture = async (fixture, { complete = undefined } = {}) => {
  let usage = null;
  let providerLatencyMs = null;
  const started = Date.now();
  const result = await interpretUniversalIntent({
    sourceText: fixture.sourceText,
    catalog: fixture.catalog,
    context: fixture.context,
    operationId: `${universalEvaluationDefaults.operationIdPrefix}-${fixture.id}`,
    channel: universalEvaluationDefaults.channel,
    complete: complete ?? (async (options) => {
      const response = await (await import('../server/llmChatClient.js')).completeChatJson(options);
      usage = response?.usage ?? null;
      providerLatencyMs = Number.isFinite(response?.latencyMs) ? response.latencyMs : null;
      return response;
    }),
  });
  return {
    id: fixture.id,
    passed: compareUniversalGold(fixture, result).length === 0,
    errors: compareUniversalGold(fixture, result),
    kind: result.kind,
    reason: result.reason ?? null,
    semanticMismatch: compareUniversalGold(fixture, result),
    elapsedMs: Date.now() - started,
    trace: {
      provider: result.trace?.provider ?? null,
      model: result.trace?.model ?? null,
      latencyMs: Number.isFinite(result.trace?.latencyMs) ? result.trace.latencyMs : null,
      providerLatencyMs,
      usage,
    },
    _result: result,
  };
};

const runSelfTest = async () => {
  const rows = [];
  for (const fixture of universalIntentCorpus) {
    const row = await evaluateFixture(fixture, { complete: async () => ({ ok: true, json: fakeModelJson(fixture), provider: 'simulated', model: 'gold-contract-stub', usage: null, latencyMs: 0 }) });
    assert.equal(row.passed, true, `fixture fake response should match gold: ${fixture.id}: ${row.errors.join('; ')}`);
    rows.push({ ...row, _result: undefined });
  }

  const familyFixture = universalIntentCorpus.find(({ id }) => id === 'new-family-sku-required-false-and-zero');
  const valid = await evaluateFixture(familyFixture, { complete: async () => ({ ok: true, json: fakeModelJson(familyFixture), provider: 'simulated', model: 'gold-contract-stub', usage: null, latencyMs: 0 }) });
  const proposal = fakeModelJson(familyFixture);
  proposal.actions[0].target.sku.attributes.habilitado.value = true;
  const wrongFalse = await evaluateFixture(familyFixture, { complete: async () => ({ ok: true, json: proposal, provider: 'simulated', model: 'gold-contract-stub' }) });
  assert.equal(valid.passed, true);
  assert.equal(wrongFalse.passed, false, 'boolean false mismatch must fail');
  assert.ok(wrongFalse.semanticMismatch.length > 0);

  const existingSkuFixture = universalIntentCorpus.find(({ id }) => id === 'explicit-directional-converters-two-skus');
  const wrongSku = fakeModelJson(existingSkuFixture);
  wrongSku.actions[0].target.skuId = 'hdmi-usb';
  const wrongSkuResult = await evaluateFixture(existingSkuFixture, { complete: async () => ({ ok: true, json: wrongSku, provider: 'simulated', model: 'gold-contract-stub' }) });
  assert.equal(wrongSkuResult.passed, false, 'wrong existing SKU must fail');

  const swappedSkus = fakeModelJson(existingSkuFixture);
  swappedSkus.actions[0].target.skuId = 'hdmi-usb';
  swappedSkus.actions[1].target.skuId = 'usb-hdmi';
  const swappedResult = await evaluateFixture(existingSkuFixture, { complete: async () => ({ ok: true, json: swappedSkus, provider: 'simulated', model: 'gold-contract-stub' }) });
  assert.equal(swappedResult.passed, false, 'swapped SKU identities must fail');
  const wrongPositiveQuantity = fakeModelJson(existingSkuFixture);
  wrongPositiveQuantity.actions[0].quantity.value = 4;
  const wrongPositiveQuantityResult = await evaluateFixture(existingSkuFixture, { complete: async () => ({ ok: true, json: wrongPositiveQuantity, provider: 'simulated', model: 'gold-contract-stub' }) });
  assert.equal(wrongPositiveQuantityResult.passed, false, 'a different positive quantity must fail');

  const chargeFixture = universalIntentCorpus.find(({ id }) => id === 'stock-income-and-customer-account-charge');
  const paraphrase = fakeModelJson(chargeFixture);
  paraphrase.actions[1].reason = 'cargo por entrega';
  const paraphraseResult = await evaluateFixture(chargeFixture, { complete: async () => ({ ok: true, json: paraphrase, provider: 'simulated', model: 'gold-contract-stub' }) });
  assert.equal(paraphraseResult.passed, true, 'an equivalent reason phrase should pass');

  for (const mutate of [
    (proposal) => { proposal.actions[0].target.sku.attributes.rango.value = 1; },
    (proposal) => { proposal.actions[0].quantity.value = 0; },
    (proposal) => { proposal.actions[0].target.sku.family.id = 'other'; },
  ]) {
    const altered = fakeModelJson(familyFixture);
    mutate(altered);
    const row = await evaluateFixture(familyFixture, { complete: async () => ({ ok: true, json: altered, provider: 'simulated', model: 'gold-contract-stub' }) });
    assert.equal(row.passed, false, 'wrong family, quantity, or zero mismatch must fail');
  }
  const unavailableFixture = universalIntentCorpus.find(({ id }) => id === 'fabricated-reference-must-not-become-ready');
  const unavailable = await evaluateFixture(unavailableFixture, { complete: async () => ({ ok: false, reason: 'all_providers_failed' }) });
  assert.equal(unavailable.passed, false, 'provider failure must not count as successful fail-closed behavior');
  const duplicate = fakeModelJson(existingSkuFixture);
  duplicate.actions[1].target.skuId = duplicate.actions[0].target.skuId;
  const duplicateResult = await evaluateFixture(existingSkuFixture, { complete: async () => ({ ok: true, json: duplicate, provider: 'simulated', model: 'gold-contract-stub' }) });
  assert.equal(duplicateResult.passed, false, 'duplicated target/action output must fail');
  const reversed = fakeModelJson(existingSkuFixture);
  [reversed.actions[0], reversed.actions[1]] = [reversed.actions[1], reversed.actions[0]];
  const reversedResult = await evaluateFixture(existingSkuFixture, { complete: async () => ({ ok: true, json: reversed, provider: 'simulated', model: 'gold-contract-stub' }) });
  assert.equal(reversedResult.passed, false, 'reordered action output must fail');

  for (const fixture of universalIntentCorpus.filter(({ expected }) => expected.kind === 'answer')) {
    const validAnswer = await evaluateFixture(fixture, { complete: async () => ({ ok: true, json: fakeModelJson(fixture), provider: 'simulated', model: 'gold-contract-stub' }) });
    assert.equal(validAnswer.passed, true, `query oracle should match snapshot: ${fixture.id}`);
    const altered = fakeModelJson(fixture);
    altered.queries[0].itemId = 'arbitrary-model-id';
    altered.evidence[0].itemId = 'arbitrary-model-id';
    const ignoredItemId = await evaluateFixture(fixture, { complete: async () => ({ ok: true, json: altered, provider: 'simulated', model: 'gold-contract-stub' }) });
    assert.equal(ignoredItemId.passed, true, 'model item IDs are correlation tokens, not semantic facts');

    const wrongFacts = { ...validAnswer._result, answer: structuredClone(validAnswer._result.answer) };
    if (wrongFacts.answer.items[0].rows.length) {
      const row = wrongFacts.answer.items[0].rows[0];
      if (Object.hasOwn(row, 'stockAvailable')) row.stockAvailable += 1;
      else if (Object.hasOwn(row, 'debt')) row.debt += 1;
      else row.qty += 1;
    } else wrongFacts.answer.items[0].summary.count += 1;
    assert.ok(compareUniversalGold(fixture, wrongFacts).length > 0, 'wrong snapshot facts must fail');
  }

  const inventoryQueryFixture = universalIntentCorpus.find(({ id }) => id === 'query-inventory-mixed-units-zero-false-attribute');
  for (const mutate of [
    (json) => { json.queries[0].selector.ids = ['inventory-unit']; },
    (json) => { json.kind = 'proposal'; json.actions = [{ itemId: 'inject', type: 'sku.deactivate' }]; delete json.queries; },
  ]) {
    const injected = fakeModelJson(inventoryQueryFixture);
    mutate(injected);
    const row = await evaluateFixture(inventoryQueryFixture, { complete: async () => ({ ok: true, json: injected, provider: 'simulated', model: 'gold-contract-stub' }) });
    assert.equal(row.passed, false, 'selection widening or action injection must fail');
  }

  const emptyFixture=structuredClone(inventoryQueryFixture);
  emptyFixture.expected.queries[0].selector={kind:'ids',ids:[]};
  emptyFixture.expected.answerItems[0].rows=[];
  emptyFixture.expected.answerItems[0].summary={count:0,totals:[]};
  const empty=await evaluateFixture(emptyFixture,{complete:async()=>({ok:true,json:fakeModelJson(emptyFixture)})});
  assert.equal(empty.passed,true,'an explicit empty set must stay empty');
  const widened=fakeModelJson(emptyFixture);widened.queries[0].selector={kind:'all'};
  assert.equal((await evaluateFixture(emptyFixture,{complete:async()=>({ok:true,json:widened})})).passed,false,'empty selector widening must fail');

  const pendingFixture=universalIntentCorpus.find(({id})=>id==='query-pending-orders-default-vs-explicit-todos');
  const defaultPending=fakeModelJson(pendingFixture);delete defaultPending.queries[0].estado;
  assert.equal((await evaluateFixture(pendingFixture,{complete:async()=>({ok:true,json:defaultPending})})).passed,true,'omitted order state defaults to pending');

  const unitsFixture = universalIntentCorpus.find(({ id }) => id === 'query-inventory-mixed-units-zero-false-attribute');
  const wrongUnit = { ...((await evaluateFixture(unitsFixture, { complete: async () => ({ ok: true, json: fakeModelJson(unitsFixture), provider: 'simulated' }) }))._result), answer: null };
  wrongUnit.answer = structuredClone((await evaluateFixture(unitsFixture, { complete: async () => ({ ok: true, json: fakeModelJson(unitsFixture), provider: 'simulated' }) }))._result.answer);
  wrongUnit.answer.items[0].rows[0].unit = 'unit';
  assert.ok(compareUniversalGold(unitsFixture, wrongUnit).length > 0, 'wrong units must fail');

  return { simulated: true, status: 'SELF_TEST_PASS', fixtureCount: rows.length, assertions: 'gold match, query snapshot facts, ignored model item IDs, selector widening, action injection, SKU swaps, wrong positive quantity, zero/false, reason paraphrase, provider failure, duplicate, and reorder' };
};

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const runCli = async () => {
  dotenv.config({ path: '.env.local', quiet: true });
  dotenv.config({ quiet: true });
  if (process.argv.includes('--self-test') && process.argv.includes('--live')) {
    console.error('Elegí --self-test o --live por separado. No se ejecutó ninguna evaluación.');
    process.exitCode = 2;
    return;
  }
  if (process.argv.includes('--self-test')) {
    try {
      const report = await runSelfTest();
      console.log(`SELF-TEST PASS (SIMULATED): ${report.fixtureCount} fixtures; ${report.assertions}. No live provider calls.`);
      process.exitCode = 0;
    } catch (error) {
      console.error(`SELF-TEST FAIL (SIMULATED): ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (!process.argv.includes('--live') || !hasAnyLlmApiKey()) {
    console.error('Requiere --live y una API key LLM disponible. No se evaluó el corpus ni se escribió un resultado.');
    process.exitCode = 2;
    return;
  }
  const out = option('--out') ?? 'scripts/test-results-universal-live.json';
  const results = [];
  for (const fixture of universalIntentCorpus) {
    const row = await evaluateFixture(fixture);
    const { _result, ...safeRow } = row;
    results.push(safeRow);
    console.log(`${safeRow.passed ? 'PASS' : 'FAIL'} ${safeRow.id}: ${safeRow.errors.join(' ') || safeRow.kind}`);
  }
  const clarificationCases = results.filter((row) => universalIntentCorpus.find((fixture) => fixture.id === row.id).expected.kind === 'clarification');
  const semanticCases = results.filter((row) => universalIntentCorpus.find((fixture) => fixture.id === row.id).expected.kind === 'ready');
  const report = {
    mode: 'LIVE',
    simulated: false,
    at: new Date().toISOString(),
    fixtureCount: results.length,
    passed: results.filter((row) => row.passed).length,
    failed: results.filter((row) => !row.passed).length,
    semanticAccuracy: semanticCases.length ? semanticCases.filter((row) => row.passed).length / semanticCases.length : null,
    clarificationAccuracy: clarificationCases.length ? clarificationCases.filter((row) => row.passed).length / clarificationCases.length : null,
    technicalOrSemanticErrors: results.filter((row) => row.kind === 'invalid' || row.kind === 'unavailable').length,
    results,
  };
  const target = path.resolve(out);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Resultado LIVE escrito en ${target}: ${report.passed}/${report.fixtureCount} casos; accuracy semántica ${report.semanticAccuracy ?? 'n/a'}; aclaración ${report.clarificationAccuracy ?? 'n/a'}.`);
  if (report.failed) process.exitCode = 1;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(`Evaluación fallida: ${error instanceof Error ? error.message : 'error desconocido'}`);
    process.exitCode = 1;
  });
}
