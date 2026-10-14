import assert from 'node:assert/strict';
import { prepareStockDraft, validateStockDraft, retrieveStockCandidates, literalizeStockDraftQuotes, buildSourceSpans, groundStockDraft } from '../server/voiceStockEngine.js';
import { stockDraftFailureReply } from '../server/voiceStockWorkflow.js';
import { incidentText, clarifiedText, incidentActions, incidentCatalog, ambiguousMention, genericCases } from './fixtures/voice-stock-corpus.js';

process.env.GEMINI_API_KEY = 'test-key'; process.env.LLM_PROVIDER = 'gemini'; process.env.LLM_DISABLE_FALLBACK = '1';
let scenario;
let requests = [];
let count = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, request) => {
  const body = JSON.parse(request.body);
  requests.push(body);
  if (scenario.geminiUnavailable && String(url).includes('generativelanguage.googleapis.com')) throw new Error('Gemini timeout simulado');
  const stage = body.messages[0].content;
  if (scenario.groqOversizedOnce && !scenario.groqSizeRejected && String(url).includes('api.groq.com') && stage.includes('Etapa: extract.')) {
    scenario.groqSizeRejected = true;
    return new Response('{"error":{"message":"Limit 8000, Requested 8500"}}', { status: 413 });
  }
  if (scenario.groqRateLimitedOnce && scenario.groqSizeRejected && !scenario.groqRateLimited && String(url).includes('api.groq.com') && stage.includes('Etapa: extract.')) {
    scenario.groqRateLimited = true;
    return new Response('{"error":"rate limit"}', { status: 429, headers: { 'retry-after': '0.001' } });
  }
  const input = JSON.parse(body.messages[1].content.split('\nDATOS:\n')[1]);
  if (stage.includes('Etapa: resolve.') && (scenario.failAllResolve || (scenario.failFirstResolve && (scenario.resolveFailures ?? 0) < 2))) {
    scenario.resolveFailures = (scenario.resolveFailures ?? 0) + 1;
    if (scenario.failAllResolve || scenario.failFirstResolve === 'oversized') return new Response('{"error":"Request too large"}', { status: 413 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[' } }] }), { status: 200 });
  }
  const auditResult = stage.includes('Etapa: audit.') ? scenario.audits?.[scenario.auditCount++] : null;
  const data = stage.includes('repair_coverage') ? { actions: structuredClone(scenario.coverageActions ?? scenario.actions) }
    : stage.includes('extract') ? { kind: 'stock_intake', sourceText: scenario.usedSourceText, actions: structuredClone(stage.includes('repair_extract') ? scenario.repairedActions ?? scenario.actions : scenario.actions) }
      : stage.includes('audit') ? { coverageComplete: scenario.complete !== false, issues: scenario.complete === false ? [{ kind: 'clarification', detail: ambiguousMention, evidence: ambiguousMention, question: '¿La primera mención de Independiente corresponde a la suplente 2026 o a otro producto?' }] : [], verifiedItemIds: input.actions.map((action) => action.itemId), ...auditResult }
        : { items: input.actions.map((action) => ({ itemId: action.itemId, kind: scenario.resolutionKind ?? 'new', productId: scenario.productId, candidateIds: scenario.candidateIds ?? [], reason: 'Clasificación de prueba.' })) };
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }), { status: 200 });
};
const run = async (name, callback) => { requests = []; await callback(); count++; console.log(`PASS ${name}`); };
const prepare = (text = clarifiedText, actions = incidentActions, catalog = incidentCatalog, extra = {}) => {
  scenario = { actions, auditCount: 0, ...extra };
  return prepareStockDraft({ sourceText: text, businessCategory: 'general', catalog });
};
try {
  await run('dictado original conserva once menciones y señala la frase adicional ambigua', async () => {
    const draft = await prepare(incidentText, incidentActions, incidentCatalog, { complete: false });
    assert.equal(draft.ok, false); assert.equal(draft.actions.length, 11);
    assert.equal(draft.clarifications.length, 1); assert.equal(draft.clarifications[0].evidence, ambiguousMention); assert.equal(requests.length, 2);
  });
  await run('la auditoría formula la aclaración desde un segmento numerado', async () => {
    const evidenceSpanId = buildSourceSpans(incidentText).find((span) => span.text.includes(ambiguousMention)).id;
    const draft = await prepare(incidentText, incidentActions, incidentCatalog, { audits: [{
      coverageComplete: false,
      issues: [{ kind: 'clarification', detail: 'Mención ambigua', evidenceSpanId, question: '¿Es otro producto?' }],
    }] });
    assert.equal(draft.ok, false);
    assert.equal(draft.clarifications[0].evidence, ambiguousMention);
    assert.match(requests[1].messages[1].content, /evidenceSpanId/);
  });
  await run('una referencia anterior sin resolver no pasa aunque el auditor diga cobertura completa', async () => {
    const actions = structuredClone(incidentActions);
    actions[1].productName = 'camiseta de Independiente, la anterior del Manchester City';
    actions[1].evidence = ambiguousMention;
    const draft = await prepare(incidentText, actions, incidentCatalog);
    assert.equal(draft.ok, false);
    assert.equal(draft.reason, 'coverage_incomplete');
    assert.match(draft.clarifications[0].question, /¿“la anterior” corrige/);
    assert.equal(requests.some((body) => body.messages[0].content.includes('Etapa: resolve.')), false);
  });
  await run('lista aclarada: Argentina y Boca presentes, Chelsea ausente, precio global y excepción', async () => {
    const draft = await prepare();
    assert.equal(draft.ok, true); assert.equal(draft.coverageVerified, true); assert.equal(draft.actions.length, 11);
    assert.equal(requests[0].model, 'gemini-3.5-flash-lite');
    const argentina = draft.actions.find((action) => /Argentina/.test(action.productName));
    assert.equal(argentina.resolution.kind, 'new'); assert.equal(argentina.price, 65000);
    assert.ok(draft.actions.some((action) => /Boca/.test(action.productName)));
    assert.equal(draft.actions.some((action) => /Chelsea/.test(action.productName)), false);
    assert.equal(draft.actions.filter((action) => action.price === 65000).length, 10);
    assert.equal(draft.actions.find((action) => /mangas largas/.test(action.productName)).price, 70000);
    assert.ok(draft.actions.every((action) => clarifiedText.slice(action.evidenceStart, action.evidenceEnd) === action.evidence));
    assert.ok(requests.slice(0, 2).every((body) => !JSON.stringify(body).includes('arg-home')));
  });
  await run('el servidor deriva citas desde IDs sin pedirle texto literal al modelo', async () => {
    const spans = buildSourceSpans(clarifiedText);
    const priceSpanId = spans.find((span) => span.text.includes('todas las anteriores valen 65.000')).id;
    const globalVersionId = spans.find((span) => span.text.startsWith('Todas estas')).id;
    const actions = incidentActions.map(({ evidence, fieldEvidence, ...action }, index) => ({
      ...action, mentionId: spans.find((span) => span.text.includes(evidence)).id,
      priceSpanId, ...(index === 0 ? { attributeSpanIds: [globalVersionId] } : {}),
    }));
    const draft = await prepare(clarifiedText, actions, incidentCatalog);
    assert.equal(draft.ok, true);
    assert.equal(draft.actions.length, 11);
    assert.ok(draft.actions.every((action) => clarifiedText.includes(action.evidence) && clarifiedText.includes(action.fieldEvidence.price)));
    assert.equal(draft.actions[0].fieldEvidence.attributes[0], spans.find((span) => span.id === globalVersionId).text);
    assert.equal(draft.actions[0].fieldEvidence.price, 'todas las anteriores valen 65.000');
    assert.equal(draft.actions.at(-1).fieldEvidence.price, 'esta manga larga vale 70.000.');
    assert.match(requests[0].messages[1].content, /sourceSpans/);
    assert.match(requests[0].messages[1].content, /mentionId/);
  });
  await run('una referencia de segmento errónea se repara sin copiar citas', async () => {
    const spans = buildSourceSpans(clarifiedText);
    const priceSpanId = spans.at(-1).id;
    const repairedActions = incidentActions.map(({ evidence, fieldEvidence, ...action }) => ({
      ...action, mentionId: spans.find((span) => span.text.includes(evidence)).id, priceSpanId,
    }));
    const invalid = structuredClone(repairedActions);
    invalid[0].mentionId = 999;
    const draft = await prepare(clarifiedText, invalid, incidentCatalog, { repairedActions });
    assert.equal(draft.ok, true);
    assert.equal(draft.actions.length, 11);
    assert.deepEqual(draft.traces.map((trace) => trace.stage), ['extract', 'repair_extract', 'audit', ...Array(4).fill('resolve')]);
  });
  await run('un ID no puede respaldar un producto ausente ni un precio distinto', async () => {
    const spans = buildSourceSpans(incidentText);
    const first = spans[0].id;
    const last = spans.at(-1).id;
    const invented = groundStockDraft(incidentText, [{ type: 'add_stock', productName: 'Camiseta Chelsea 2025', mentionId: first, qty: 1 }], spans);
    assert.equal(validateStockDraft(incidentText, invented).field, 'evidence');
    const wrongPrice = groundStockDraft(incidentText, [{ ...incidentActions[0], mentionId: first, price: 99000, priceSpanId: last }], spans);
    assert.equal(validateStockDraft(incidentText, wrongPrice).reason, 'unsupported_price');
    const yearAsPrice = groundStockDraft(incidentText, [{ ...incidentActions[0], mentionId: first, price: 2025, priceSpanId: first }], spans);
    assert.equal(validateStockDraft(incidentText, yearAsPrice).reason, 'unsupported_price');
    assert.equal(validateStockDraft(incidentText, groundStockDraft(incidentText, [{ ...incidentActions[0], mentionId: 999 }], spans)).field, 'evidence');
  });
  await run('un segmento también respalda cantidad y precio de otro rubro', async () => {
    const { text: source, actions } = genericCases[0];
    const [span] = buildSourceSpans(source);
    const grounded = groundStockDraft(source, [{ ...actions[0], evidence: undefined, fieldEvidence: {}, mentionId: span.id, qtySpanId: span.id, priceSpanId: span.id }], [span]);
    assert.equal(validateStockDraft(source, grounded).ok, true);
    assert.equal(grounded[0].fieldEvidence.price, 'a 65000 pesos.');
  });
  await run('acción inventada sin cita literal no llega a resolver catálogo', async () => {
    const draft = await prepare(incidentText, [{ ...incidentActions[0], productName: 'Camiseta Chelsea', evidence: 'Chelsea' }]);
    assert.equal(draft.ok, false); assert.equal(draft.reason, 'invalid_action_or_evidence'); assert.equal(draft.field, 'evidence'); assert.equal(draft.itemIndex, 0); assert.equal(requests.length, 2);
    assert.equal(requests.some((request) => /Etapa: (audit|resolve)/.test(request.messages[0].content)), false);
  });
  await run('cita con mayúsculas se recupera del texto literal antes de auditar', async () => {
    const invalid = structuredClone(incidentActions);
    invalid[0].evidence = invalid[0].evidence.toUpperCase();
    invalid[0].fieldEvidence.price = 'TODAS LAS ANTERIORES VALEN 65,000';
    const draft = await prepare(clarifiedText, invalid, incidentCatalog);
    assert.equal(draft.ok, true); assert.equal(draft.actions.length, 11);
    assert.deepEqual(draft.traces.map((trace) => trace.stage), ['extract', 'audit', ...Array(4).fill('resolve')]);
    assert.equal(draft.actions[0].evidence, incidentActions[0].evidence);
    assert.equal(draft.actions[0].fieldEvidence.price, incidentActions[0].fieldEvidence.price);
    assert.ok(requests.slice(0, 2).every((body) => !JSON.stringify(body).includes('arg-home')));
  });
  await run('citas ambiguas o con palabras inventadas no se recuperan', async () => {
    const source = 'Camiseta de Racing. Camiseta de Racing.';
    assert.equal(literalizeStockDraftQuotes(source, [{ evidence: 'CAMISETA DE RACING' }])[0].evidence, 'CAMISETA DE RACING');
    assert.equal(literalizeStockDraftQuotes(source, [{ evidence: 'Camiseta de Chelsea' }])[0].evidence, 'Camiseta de Chelsea');
    assert.equal(validateStockDraft(source, [{ ...incidentActions[0], evidence: 'CAMISETA DE RACING' }]).ok, false);
  });
  await run('palabras de enlace omitidas se recuperan solo en una mención única', async () => {
    const quote = 'camiseta suplente Manchester City 2025 talle L';
    const recovered = literalizeStockDraftQuotes(incidentText, [{ evidence: quote }])[0].evidence;
    assert.equal(recovered, incidentActions[0].evidence);
    assert.equal(literalizeStockDraftQuotes(incidentText, [{ evidence: 'version jugador titular tambien' }])[0].evidence, 'versión jugador titular también');
    assert.equal(literalizeStockDraftQuotes(incidentText, [{ evidence: 'camiseta Chelsea 2025 talle L' }])[0].evidence, 'camiseta Chelsea 2025 talle L');
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
    assert.match(stockDraftFailureReply({ clarifications: [{ question: '¿Son dos productos distintos?' }] }), /¿Son dos productos distintos\?/);
    const internal = stockDraftFailureReply({ issues: ['Falta evidencia entre caracteres 151 y 210.'] });
    assert.doesNotMatch(internal, /evidencia|caracteres|151|210/);
  });
  await run('fallos internos de auditoría se reparan y reauditan sin consultar al usuario', async () => {
    const draft = await prepare(clarifiedText, incidentActions, incidentCatalog, { audits: [
      { coverageComplete: false, issues: ['Falta cita del atributo global. El talle solo aparece en el primer producto.'] },
      { coverageComplete: true, issues: [] },
    ] });
    assert.equal(draft.ok, true); assert.equal(draft.actions.length, 11);
    assert.deepEqual(draft.traces.map((trace) => trace.stage), ['extract', 'audit', 'repair_coverage', 'audit', ...Array(4).fill('resolve')]);
    assert.equal(draft.actions[0].size, 'L'); assert.ok(draft.actions.slice(1).every((action) => !action.size));
    assert.ok(requests.slice(0, 4).every((body) => !JSON.stringify(body).includes('arg-home')));
  });
  await run('la reparación de cobertura no puede saltear la segunda auditoría', async () => {
    const draft = await prepare(clarifiedText, incidentActions, incidentCatalog, { audits: [
      { coverageComplete: false, issues: [{ kind: 'repairable', detail: 'Falta atributo global.' }] },
      { coverageComplete: false, issues: [{ kind: 'repairable', detail: 'Todavía falta el atributo.' }] },
    ] });
    assert.equal(draft.ok, false); assert.equal(requests.length, 4);
    assert.equal(requests.some((request) => request.messages[0].content.includes('Etapa: resolve.')), false);
    assert.match(stockDraftFailureReply(draft), /reintentar/);
  });
  await run('referencia al producto anterior deja de ser un ítem extra tras reparación y auditoría', async () => {
    const actions = [...incidentActions, { ...incidentActions[0], evidence: 'La anterior del Manchester City en versión jugador', size: undefined }];
    const draft = await prepare(clarifiedText, actions, incidentCatalog, { coverageActions: incidentActions, audits: [
      { coverageComplete: false, issues: [{ kind: 'repairable', detail: 'La referencia al anterior fue duplicada.' }] },
      { coverageComplete: true, issues: [] },
    ] });
    assert.equal(draft.ok, true); assert.equal(draft.actions.length, 11);
    assert.equal(draft.actions.filter((action) => /Manchester City/.test(action.productName)).length, 1);
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
  await run('catálogo grande se resuelve en pedidos acotados', async () => {
    const products = Array.from({ length: 150 }, (_, index) => ({
      id: `other-${index}`, name: `Camiseta versión jugador variante ${index}`,
      productType: 'Camiseta', productModel: `versión jugador variante ${index}`,
    }));
    const draft = await prepare(clarifiedText, incidentActions, { products });
    assert.equal(draft.ok, true);
    assert.equal(draft.actions.length, 11);
    const resolveRequests = requests.filter((body) => body.messages[0].content.includes('Etapa: resolve.'));
    assert.equal(resolveRequests.length, 4);
    for (const body of resolveRequests) {
      const input = JSON.parse(body.messages[1].content.split('\nDATOS:\n')[1]);
      assert.ok(input.actions.length <= 3);
      assert.ok(input.candidates.every((entry) => entry.products.length <= 12));
      assert.equal(body.max_tokens, 1536);
      assert.equal(input.sourceText, undefined);
    }
  });
  await run('Gemini caído: Groq recibe una extracción acotada y de bajo razonamiento', async () => {
    const priorGroqKey = process.env.GROQ_API_KEY;
    const priorDisableFallback = process.env.LLM_DISABLE_FALLBACK;
    process.env.GROQ_API_KEY = 'test-key';
    process.env.LLM_DISABLE_FALLBACK = '0';
    try {
      const draft = await prepare(clarifiedText, incidentActions, incidentCatalog, { geminiUnavailable: true, groqOversizedOnce: true, groqRateLimitedOnce: true });
      assert.equal(draft.ok, true);
      assert.equal(draft.actions.length, incidentActions.length);
      const extractRequests = requests.filter((body) => body.model === 'openai/gpt-oss-20b' && body.messages[0].content.includes('Etapa: extract.'));
      const extractRequest = extractRequests[0];
      const auditRequest = requests.find((body) => body.model === 'openai/gpt-oss-20b' && body.messages[0].content.includes('Etapa: audit.'));
      assert.equal(extractRequest.max_tokens, 4096);
      assert.equal(extractRequest.reasoning_effort, 'low');
      assert.equal(extractRequests.length, 3);
      assert.ok(extractRequests[1].max_tokens < extractRequest.max_tokens);
      assert.equal(extractRequests[2].max_tokens, extractRequests[1].max_tokens);
      assert.equal(auditRequest.max_tokens, 1024);
      assert.ok(requests.filter((body) => body.model === 'openai/gpt-oss-20b' && body.messages[0].content.includes('Etapa: resolve.'))
        .every((body) => body.max_tokens === 1536));
    } finally {
      if (priorGroqKey == null) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = priorGroqKey;
      if (priorDisableFallback == null) delete process.env.LLM_DISABLE_FALLBACK; else process.env.LLM_DISABLE_FALLBACK = priorDisableFallback;
    }
  });
  for (const failure of ['oversized', 'truncated']) {
    await run(`resolver divide el pedido tras respuesta ${failure}`, async () => {
      const draft = await prepare(clarifiedText, incidentActions, incidentCatalog, { failFirstResolve: failure });
      assert.equal(draft.ok, true);
      assert.equal(draft.actions.length, incidentActions.length);
      assert.equal(draft.traces.filter((trace) => trace.stage === 'resolve').length, 6);
      assert.equal(draft.traces.find((trace) => trace.stage === 'resolve').ok, false);
      assert.ok(requests.filter((body) => body.messages[0].content.includes('Etapa: resolve.')).slice(2)
        .some((body) => JSON.parse(body.messages[1].content.split('\nDATOS:\n')[1]).actions.length < 3));
    });
  }
  await run('si incluso un solo ítem excede el límite, el lote queda retenido', async () => {
    const draft = await prepare(clarifiedText, incidentActions, incidentCatalog, { failAllResolve: true });
    assert.equal(draft.ok, false);
    assert.equal(draft.reason, 'resolver_unavailable');
    assert.ok(draft.actions.every((action) => !action.resolution));
    assert.match(stockDraftFailureReply(draft), /reintentar/);
  });
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
