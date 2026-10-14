import assert from 'node:assert/strict';
import { prepareStockDraft, validateStockDraft, retrieveStockCandidates } from '../server/voiceStockEngine.js';
import { stockDraftFailureReply } from '../server/voiceStockWorkflow.js';
import { incidentText, clarifiedText, incidentActions, incidentCatalog, ambiguousMention, genericCases } from './fixtures/voice-stock-corpus.js';

process.env.GEMINI_API_KEY = 'test-key'; process.env.LLM_PROVIDER = 'gemini'; process.env.LLM_DISABLE_FALLBACK = '1';
let scenario;
let requests = [];
let count = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, request) => {
  const body = JSON.parse(request.body);
  requests.push(body);
  const stage = body.messages[0].content;
  const data = stage.includes('extract') ? { kind: 'stock_intake', actions: structuredClone(stage.includes('repair_extract') ? scenario.repairedActions ?? scenario.actions : scenario.actions) }
    : stage.includes('audit') ? { coverageComplete: scenario.complete !== false, issues: scenario.complete === false ? [ambiguousMention] : [], verifiedItemIds: scenario.actions.map((_, index) => `item-${index + 1}`) }
    : { items: scenario.actions.map((_, index) => ({ itemId: `item-${index + 1}`, kind: scenario.resolutionKind ?? 'new', productId: scenario.productId, candidateIds: scenario.candidateIds ?? [], reason: 'Clasificación de prueba.' })) };
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }), { status: 200 });
};
const run = async (name, callback) => { requests = []; await callback(); count++; console.log(`PASS ${name}`); };
const prepare = (text = clarifiedText, actions = incidentActions, catalog = incidentCatalog, extra = {}) => {
  scenario = { actions, ...extra };
  return prepareStockDraft({ sourceText: text, businessCategory: 'general', catalog });
};
try {
  await run('dictado original conserva once menciones y señala la frase adicional ambigua', async () => {
    const draft = await prepare(incidentText, incidentActions, incidentCatalog, { complete: false });
    assert.equal(draft.ok, false); assert.equal(draft.actions.length, 11);
    assert.ok(draft.issues.includes(ambiguousMention)); assert.equal(requests.length, 2);
  });
  await run('lista aclarada: Argentina y Boca presentes, Chelsea ausente, precio global y excepción', async () => {
    const draft = await prepare();
    assert.equal(draft.ok, true); assert.equal(draft.coverageVerified, true); assert.equal(draft.actions.length, 11);
    const argentina = draft.actions.find((action) => /Argentina/.test(action.productName));
    assert.equal(argentina.resolution.kind, 'new'); assert.equal(argentina.price, 65000);
    assert.ok(draft.actions.some((action) => /Boca/.test(action.productName)));
    assert.equal(draft.actions.some((action) => /Chelsea/.test(action.productName)), false);
    assert.equal(draft.actions.filter((action) => action.price === 65000).length, 10);
    assert.equal(draft.actions.find((action) => /mangas largas/.test(action.productName)).price, 70000);
    assert.ok(draft.actions.every((action) => clarifiedText.slice(action.evidenceStart, action.evidenceEnd) === action.evidence));
    assert.ok(requests.slice(0, 2).every((body) => !JSON.stringify(body).includes('arg-home')));
  });
  await run('acción inventada sin cita literal no llega a resolver catálogo', async () => {
    const draft = await prepare(incidentText, [{ ...incidentActions[0], productName: 'Camiseta Chelsea', evidence: 'Chelsea' }]);
    assert.equal(draft.ok, false); assert.equal(draft.reason, 'invalid_action_or_evidence'); assert.equal(draft.field, 'evidence'); assert.equal(draft.itemIndex, 0); assert.equal(requests.length, 2);
    assert.equal(requests.some((request) => /Etapa: (audit|resolve)/.test(request.messages[0].content)), false);
  });
  await run('cita normalizada se repara una vez y la lista completa pasa auditoría antes de resolver', async () => {
    const invalid = structuredClone(incidentActions);
    invalid[0].evidence = invalid[0].evidence.toUpperCase();
    const draft = await prepare(clarifiedText, invalid, incidentCatalog, { repairedActions: incidentActions });
    assert.equal(draft.ok, true); assert.equal(draft.actions.length, 11);
    assert.deepEqual(draft.traces.map((trace) => trace.stage), ['extract', 'repair_extract', 'audit', 'resolve']);
    assert.ok(requests.slice(0, 3).every((body) => !JSON.stringify(body).includes('arg-home')));
  });
  await run('precio sin cita se repara sin eliminar el precio global ni su excepción', async () => {
    const invalid = incidentActions.map((action) => ({ ...action, fieldEvidence: {} }));
    const draft = await prepare(clarifiedText, invalid, incidentCatalog, { repairedActions: incidentActions });
    assert.equal(draft.ok, true); assert.equal(draft.actions.filter((action) => action.price === 65000).length, 10);
    assert.equal(draft.actions.find((action) => /mangas largas/.test(action.productName)).price, 70000);
  });
  await run('rechazo técnico permite reintentar; una ambigüedad muestra la pregunta concreta', async () => {
    const technical = stockDraftFailureReply({ reason: 'unsupported_price' });
    assert.match(technical, /reintentar/); assert.doesNotMatch(technical, /lista completa corregida/);
    assert.match(stockDraftFailureReply({ issues: ['¿Son dos productos distintos?'] }), /¿Son dos productos distintos\?/);
  });
  await run('cantidades fraccionarias y precio sin respaldo se rechazan', async () => {
    assert.equal(validateStockDraft(incidentText, [{ ...incidentActions[0], qty: 1.5 }]).ok, false);
    assert.equal(validateStockDraft(incidentText, [{ ...incidentActions[0], fieldEvidence: {} }]).reason, 'unsupported_price');
  });
  for (const fixture of genericCases) {
    await run(`rubro genérico: ${fixture.id}`, async () => {
      const draft = await prepare(fixture.text, fixture.actions, fixture.catalog);
      assert.equal(draft.ok, true); assert.equal(draft.actions[0].resolution.kind, 'new');
    });
  }
  await run('candidatos relevantes al final de un catálogo grande', async () => {
    const fixture = genericCases[0];
    const relevant = { id: 'real-last', name: 'Taladro Bosch 18V', productType: 'Taladro', productModel: 'Bosch 18V', size: '10 mm' };
    const products = [...Array.from({ length: 200 }, (_, index) => ({ id: `unrelated-${index}`, name: `Producto ajeno ${index}` })), relevant];
    assert.equal(retrieveStockCandidates(fixture.actions[0], products)[0].id, relevant.id);
    const draft = await prepare(fixture.text, fixture.actions, { products }, { resolutionKind: 'existing', productId: relevant.id });
    assert.equal(draft.actions[0].resolution.productId, relevant.id);
  });
  await run('SKU indistinguible no se crea como nuevo', async () => {
    const fixture = genericCases[0];
    const draft = await prepare(fixture.text, fixture.actions, { products: [{ id: 'exact', name: 'Taladro Bosch 18V', productType: 'Taladro', productModel: 'Bosch 18V', size: '10 mm' }] });
    assert.equal(draft.actions[0].resolution.kind, 'ambiguous'); assert.deepEqual(draft.actions[0].resolution.candidateIds, ['exact']);
  });
  await run('ID fuera de candidatos y variante explícita incompatible nunca son existing', async () => {
    const fixture = genericCases[0];
    const draft = await prepare(fixture.text, fixture.actions, fixture.catalog, { resolutionKind: 'existing', productId: 'another-tenant-id', candidateIds: ['bosch-13'] });
    assert.equal(draft.actions[0].resolution.kind, 'ambiguous'); assert.deepEqual(draft.actions[0].resolution.candidateIds, []);
  });
  await run('sin proveedor no hay una lista parcial autorizada', async () => {
    delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY; delete process.env.VITE_VOICE_MODEL_API_KEY;
    const draft = await prepare(); assert.equal(draft.ok, false); assert.equal(draft.reason, 'extractor_unavailable'); assert.equal(requests.length, 0);
  });
  console.log(`Stock engine regression: ${count} checks passed.`);
} finally { globalThis.fetch = originalFetch; }
