import assert from 'node:assert/strict';
import { parseLocalText, parseVoiceText, processMetaWebhook } from '../server/metaWebhookProcessor.js';
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

const webhook = await processMetaWebhook({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { messages: [{ id: 'test-delete-all', from: '5491111111111', type: 'text', text: { body: 'Todos borra' } }] } }] }],
}, { resolveCatalog: async () => catalog });
assert.deepEqual(webhook[0]?.parsed?.actions, [{ type: 'delete_product', productName: '*' }]);
assert.match(webhook[0]?.replyText || '', /Productos eliminados.*todo el inventario/);

console.log('delete all products parsing and catalog grounding passed');
