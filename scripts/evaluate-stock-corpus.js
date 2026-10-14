import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import { hasAnyLlmApiKey } from '../server/llmChatClient.js';
import { prepareStockDraft, normalizeIdentity } from '../server/voiceStockEngine.js';
import { incidentText, clarifiedText, incidentCatalog, genericCases } from './fixtures/voice-stock-corpus.js';

dotenv.config({ path: '.env.local', quiet: true }); dotenv.config({ quiet: true });
if (!process.argv.includes('--live') || !hasAnyLlmApiKey()) {
  console.error('Requiere --live y GEMINI_API_KEY o GROQ_API_KEY. Este comando solo evalúa texto; no accede al inventario ni envía WhatsApp.');
  process.exitCode = 2;
} else {
  const cases = [
    { id: 'incident-original', text: incidentText, category: 'indumentaria', catalog: incidentCatalog, allowHold: true },
    { id: 'incident-clarified', text: clarifiedText, category: 'indumentaria', catalog: incidentCatalog },
    ...genericCases,
  ];
  const results = [];
  for (const fixture of cases) {
    const started = Date.now();
    const draft = await prepareStockDraft({ sourceText: fixture.text, businessCategory: fixture.category, catalog: fixture.catalog });
    const errors = [];
    const actions = draft.actions ?? [];
    if (fixture.id.startsWith('incident')) {
      if (actions.length < 11) errors.push(`La extracción tiene menos de once menciones identificables: ${actions.length}.`);
      if (!actions.some((action) => /argentina/.test(normalizeIdentity(action.productName)) && /tercera/.test(normalizeIdentity(action.productName)))) errors.push('Falta Argentina tercera.');
      if (!actions.some((action) => /boca/.test(normalizeIdentity(action.productName)))) errors.push('Falta Boca.');
      if (actions.some((action) => /chelsea/.test(normalizeIdentity(action.productName)))) errors.push('Chelsea no está en el dictado.');
      if (!fixture.allowHold) {
        if (actions.length !== 11) errors.push(`Se esperaban 11 productos después de aclarar la mención dudosa: ${actions.length}.`);
        const long = actions.filter((action) => /barcelona/.test(normalizeIdentity(action.productName)) && /larg/.test(normalizeIdentity(action.productName)));
        if (long.length !== 1 || long[0].price !== 70000) errors.push('Excepción de manga larga incorrecta.');
        if (actions.filter((action) => action.price === 65000).length !== 10) errors.push('Precio global incorrecto.');
      }
    } else {
      if (actions.length !== fixture.actions.length || actions.some((action, index) => action.qty !== fixture.actions[index]?.qty || action.price !== fixture.actions[index]?.price)) errors.push('Cantidad de productos, unidades o precios incorrectos.');
    }
    if (!draft.ok && !(fixture.allowHold && draft.issues?.length)) errors.push(`Lote no verificable: ${draft.reason}.`);
    const row = { id: fixture.id, passed: errors.length === 0, errors, elapsedMs: Date.now() - started, draft };
    results.push(row); console.log(`${row.passed ? 'PASS' : 'FAIL'} ${fixture.id}: ${errors.join(' ') || `${actions.length} productos`}`);
  }
  await fs.writeFile('scripts/test-results-stock-live.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  if (results.some((row) => !row.passed)) process.exitCode = 1;
}
