import assert from 'node:assert/strict';
import { buildConversationTurnsFromEvents, parseLocalText, parseVoiceText, processMetaWebhook } from '../server/metaWebhookProcessor.js';
import { groundActionsAgainstCatalog } from '../server/voiceCatalogContext.js';

const catalog = {
  products: [
    { name: 'Camiseta Boca Suplente 2025 En Version Jugador S', productType: 'Camiseta', productModel: 'Boca Suplente 2025 En Version Jugador', size: 'S' },
    { name: 'Camiseta Paris Saint Germain 2025 Suplente En Version Jugador S', productType: 'Camiseta', productModel: 'Paris Saint Germain 2025 Suplente En Version Jugador', size: 'S' },
    { name: 'Camiseta River 2024 Titular', productType: 'Camiseta', productModel: 'River 2024 Titular' },
  ],
};

for (const text of [
  '¿Puedes borrar todos los productos que tengo disponibles?',
  'Todos borra',
  'Borrá todo el inventario',
]) {
  for (const parsed of [parseLocalText(text, [], catalog), await parseVoiceText(text, { catalog })]) {
    assert.deepEqual(parsed?.actions, [{ type: 'delete_product', productName: '*' }], text);
    assert.equal(Boolean(parsed?.missingFields?.includes('productMatch')), false, text);
  }
}

const scoped = await parseVoiceText('Borrá todos los productos de River', { catalog });
assert.notDeepEqual(scoped?.actions, [{ type: 'delete_product', productName: '*' }]);

const query = await parseVoiceText('Mostrame todos los productos', { catalog });
assert.deepEqual(query?.actions, [{ type: 'query_stock', productName: '*' }]);

const exact = groundActionsAgainstCatalog([
  {
    type: 'delete_product',
    productName: catalog.products[1].name,
    productType: 'Camiseta',
    productModel: 'Otro Modelo',
    size: 'S',
  },
], catalog, 'Borrá esa camiseta');
assert.equal(exact.missingFields.includes('productMatch'), false);
assert.equal(exact.actions[0].productName, catalog.products[1].name);
assert.equal(exact.actions[0].productModel, catalog.products[1].productModel);

const partial = groundActionsAgainstCatalog(
  [{ type: 'delete_product', productName: 'Camiseta' }],
  catalog,
  'Borrá una camiseta',
);
assert.equal(partial.missingFields.includes('productMatch'), true);

const scopedCatalog = {
  products: [
    { name: 'Camiseta Boca 2025 L', productType: 'Camiseta', productModel: 'Boca 2025', size: 'L' },
    { name: 'Camiseta River 2025 L', productType: 'Camiseta', productModel: 'River 2025', size: 'L' },
    { name: 'Camiseta River 2025 M', productType: 'Camiseta', productModel: 'River 2025', size: 'M' },
    { name: 'Buzo Boca 2025 L', productType: 'Buzo', productModel: 'Boca 2025', size: 'L' },
    { name: 'Borra Pegamento L', productType: 'Borra', productModel: 'Pegamento', size: 'L' },
  ],
};
const expectedScopedNames = ['Camiseta Boca 2025 L', 'Camiseta River 2025 L'];
const directScoped = await parseVoiceText('Borrá todas las camisetas en talle L', { catalog: scopedCatalog });
assert.deepEqual(directScoped.actions.map((action) => action.productName), expectedScopedNames);
assert.equal(Boolean(directScoped.missingFields?.includes('productMatch')), false);
const allShirts = await parseVoiceText('Borrá todas las camisetas', { catalog: scopedCatalog });
assert.deepEqual(allShirts.actions.map((action) => action.productName), [
  ...expectedScopedNames, 'Camiseta River 2025 M',
]);

const firstScoped = parseLocalText('borra todas las talle L', [], scopedCatalog);
assert.equal(firstScoped.missingFields.includes('productMatch'), true);
const followUpTurns = buildConversationTurnsFromEvents([{
  id: 'scoped-delete-first', at: '2026-10-16T13:58:00Z',
  sourceText: 'borra todas las talle L',
  replyText: '⚠️ Necesito identificar el producto. Hay más de una opción.',
  actions: firstScoped.actions,
  parseContext: { intent: firstScoped.intent, missingFields: firstScoped.missingFields },
}]);
const clarified = await parseVoiceText('TODAS LAS CAMISETAS EN TALLE L', {
  catalog: scopedCatalog,
  conversationTurns: followUpTurns,
});
assert.deepEqual(clarified.actions.map((action) => action.productName), expectedScopedNames);
assert.equal(Boolean(clarified.missingFields?.includes('productMatch')), false);
assert.equal(parseLocalText('TODAS LAS CAMISETAS EN TALLE L', [], scopedCatalog), null);
const noScopedMatch = await parseVoiceText('Borrá todas las camisetas talle XL', { catalog: scopedCatalog });
assert.deepEqual(noScopedMatch.actions, []);
assert.equal(noScopedMatch.missingFields.includes('scopeNotFound'), true);

const hardwareCatalog = {
  products: [
    { name: 'Taladro Bosch 13mm', productType: 'Taladro', size: '13mm' },
    { name: 'Taladro Makita 13mm', productType: 'Taladro', size: '13mm' },
    { name: 'Taladro Bosch 10mm', productType: 'Taladro', size: '10mm' },
    { name: 'Tornillo Bosch 13mm', productType: 'Tornillo', size: '13mm' },
  ],
};
const hardwareScoped = await parseVoiceText('Borrá todos los taladros medida 13mm', { catalog: hardwareCatalog });
assert.deepEqual(hardwareScoped.actions.map((action) => action.productName), ['Taladro Bosch 13mm', 'Taladro Makita 13mm']);
const hardwareFiltered = await parseVoiceText('Borrá todos los taladros Bosch medida 13mm', { catalog: hardwareCatalog });
assert.deepEqual(hardwareFiltered.actions.map((action) => action.productName), ['Taladro Bosch 13mm']);
const unavailableCatalog = await parseVoiceText('Borrá todos los taladros medida 13mm', { catalog: { products: [] } });
assert.deepEqual(unavailableCatalog.actions, []);
assert.equal(unavailableCatalog.missingFields.includes('scopeNotFound'), true);

const clarifiedWebhook = await processMetaWebhook({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { messages: [{
    id: 'scoped-delete-follow-up', from: '5491111111111', type: 'text',
    text: { body: 'TODAS LAS CAMISETAS EN TALLE L' },
  }] } }] }],
}, {
  resolveCatalog: async () => scopedCatalog,
  resolveConversationHistory: async () => followUpTurns,
});
assert.deepEqual(clarifiedWebhook[0].parsed.actions.map((action) => action.productName), expectedScopedNames);
assert.match(clarifiedWebhook[0].replyText, /Camiseta Boca 2025 L/);
assert.match(clarifiedWebhook[0].replyText, /Camiseta River 2025 L/);

const webhook = await processMetaWebhook({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { messages: [{ id: 'test-delete-all', from: '5491111111111', type: 'text', text: { body: 'Todos borra' } }] } }] }],
}, { resolveCatalog: async () => catalog });
assert.deepEqual(webhook[0]?.parsed?.actions, [{ type: 'delete_product', productName: '*' }]);
assert.match(webhook[0]?.replyText || '', /Productos eliminados.*todo el inventario/);

console.log('delete all products parsing and catalog grounding passed');
