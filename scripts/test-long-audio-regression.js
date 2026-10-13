import assert from 'node:assert/strict';
import { modelsForRequest } from '../server/llmChatClient.js';
import { parseLocalText, parseVoiceText } from '../server/metaWebhookProcessor.js';
import { groundActionsAgainstCatalog, selectCatalogForPrompt } from '../server/voiceCatalogContext.js';
import { productBaseName, productMatchKey, normalizeProductMetadata } from '../server/productIdentity.js';
import { buildCategoryPromptContext, getBusinessCategoryPreset } from '../server/businessCategories.js';

const transcript = 'Ingresaron nuevas camisetas, todas en talle M. Tenemos de Argentina titular 2026 en versión jugador. Camiseta de Racing en versión jugador también titular 2026. Camiseta de Vélez versión jugador también la titular 2026. Estas tres valen 65 mil pesos. Tenemos la de Boca titular, 2025, con dorsal de Paredes en 70 mil, también versión jugador. Tenemos la de Argentina suplente en versión jugador a 65 mil pesos. Tenemos la de Paris Saint-Germain a 65.000 pesos, la suplente de 2025. Tenemos la de Argentina suplente también en talle M, 65.000, otra más. También en versión jugador. Tenemos la del Real Madrid, titular 2025 a 65.000 pesos, también en versión jugador. Y la del Inter, titular 2025 a 65.000 pesos, también en versión jugador.';

const existingNames = [
  'Camiseta Argentina 2026 Suplente En Version Jugador S',
  'Camiseta Argentina Titular 2025 2026 S',
  'Camiseta Argentina Titular Version Jugador S',
  'Camiseta Chelsea Tercera Equipacion 2026 En Version Jugador S',
  'Camiseta Inter Titular 2025 En Version Jugador S',
  'Camiseta Racing Titular 2026 S',
  'Camiseta River Titular 2026 S',
  'Camiseta Boca Suplente 2025 En Version Jugador S',
  'Camiseta River Titular 2026 M',
  'Camiseta Chelsea Titular 2026 En Version Jugador M',
];
const catalog = {
  products: existingNames.map((name, index) => ({
    id: `product-${index}`,
    name,
    size: name.endsWith(' M') ? 'M' : 'S',
    stockAvailable: 1,
  })),
  clients: [],
  pedidos: [],
};

const legacy = normalizeProductMetadata({
  name: existingNames[0],
  productType: 'Camiseta Argentina 2026 Suplente En Version Jugador',
  productModel: null,
  size: 'S',
});
assert.equal(legacy.productType, 'Camiseta');
assert.equal(legacy.productModel, 'Argentina 2026 Suplente En Version Jugador');
assert.equal(productBaseName(legacy), 'Camiseta Argentina 2026 Suplente En Version Jugador');
assert.equal(
  productMatchKey({ productName: 'Camiseta de Argentina suplente 2026 versión jugador talle S' }),
  productMatchKey(legacy),
);
assert.equal(
  productMatchKey({ productName: 'Taladro Bosch 18V medida 13mm' , size: '13mm' }),
  productMatchKey({ productType: 'Taladro', productModel: 'Bosch 18V', size: '13mm', name: 'Taladro Bosch 18V' }),
);
assert.equal(
  productMatchKey({ productName: 'Taladro de Bosch 18V medida 13mm', size: '13mm' }),
  productMatchKey({ productType: 'Taladro', productModel: 'Bosch 18V', size: '13mm', name: 'Taladro Bosch 18V' }),
);
assert.equal(productBaseName({ name: 'Zapatilla Nike Air 42', size: '42' }), 'Zapatilla Nike Air');
assert.ok(buildCategoryPromptContext(getBusinessCategoryPreset('ferreteria')).includes('Medida'));
assert.ok(!buildCategoryPromptContext(getBusinessCategoryPreset('ferreteria')).includes('Camiseta'));
const hardwareFallback = parseLocalText(
  'Ingresaron nuevos taladros. Tenemos Bosch 18V medida 13mm. Vale 65000 pesos. También Makita 12V medida 10mm.',
  [], { products: [], clients: [], pedidos: [] }, getBusinessCategoryPreset('ferreteria'),
);
assert.equal(hardwareFallback, null);

const matchCatalog = { products: [
  { ...legacy, id: 'legacy' },
  { id: 'other-year', name: 'Camiseta Argentina 2025 Suplente En Version Jugador M', size: 'M' },
] };
const exactReordered = groundActionsAgainstCatalog([
  { type: 'add_stock', productName: 'Camiseta de Argentina suplente 2026 versión jugador talle S', size: 'S', qty: 1 },
], matchCatalog, 'Camiseta de Argentina suplente 2026 versión jugador talle S');
assert.equal(exactReordered.actions[0].productName, existingNames[0]);
assert.equal(exactReordered.requiresConfirmation, false);
const unspecifiedYear = groundActionsAgainstCatalog([
  { type: 'add_stock', productName: 'Camiseta de Argentina suplente versión jugador talle M', size: 'M', qty: 1 },
], matchCatalog, 'Camiseta de Argentina suplente versión jugador talle M');
assert.equal(unspecifiedYear.requiresConfirmation, true);
const newSeason = groundActionsAgainstCatalog([
  { type: 'add_stock', productName: 'Camiseta de Argentina suplente 2026 versión jugador talle M', size: 'M', qty: 1 },
], matchCatalog, 'Camiseta de Argentina suplente 2026 versión jugador talle M');
assert.equal(newSeason.requiresConfirmation, false);

const action = (productName, price = 65000) => ({
  type: 'add_stock', productName: `${productName} M`, size: 'M', qty: 1, price,
});
const modelActions = [
  action('Camiseta Argentina Titular 2026 En Version Jugador'),
  action('Camiseta Racing Titular 2026 En Version Jugador'),
  action('Camiseta Velez Titular 2026 En Version Jugador'),
  action('Camiseta Boca Titular 2025 Con Dorsal De Paredes En Version Jugador', 70000),
  action('Camiseta Argentina Suplente En Version Jugador'),
  action('Camiseta Paris Saint Germain Suplente 2025 En Version Jugador'),
  action('Camiseta Argentina Suplente En Version Jugador'),
  action('Camiseta Real Madrid Titular 2025 En Version Jugador'),
  action('Camiseta Inter Titular 2025 En Version Jugador'),
];
const eightModelActions = modelActions.filter((_, index) => index !== 6);
const groundedDuplicates = groundActionsAgainstCatalog(modelActions, catalog, transcript);
assert.equal(groundedDuplicates.actions.find((item) => item.productName === 'Camiseta Argentina Suplente En Version Jugador M')?.qty, 2);

assert.deepEqual(
  modelsForRequest({ id: 'gemini', models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] }, transcript.length),
  ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'],
);
assert.deepEqual(
  modelsForRequest({ id: 'gemini', models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] }, 100),
  ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
);
const largeCatalog = {
  ...catalog,
  products: [
    ...catalog.products,
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `unrelated-${index}`, name: `Camiseta EquipoInventado${index} S`, size: 'S', stockAvailable: 1,
    })),
  ],
};
const selected = selectCatalogForPrompt(largeCatalog, transcript);
assert.ok(selected.products.length <= 30);
assert.ok(selected.products.some((product) => product.name.includes('Argentina')));
assert.ok(selected.products.every((product) => !product.name.includes('EquipoInventado')));

process.env.GEMINI_API_KEY = 'regression-test-key';
process.env.LLM_DISABLE_FALLBACK = '1';
const originalFetch = globalThis.fetch;
let calledModel = null;
let modelActionsForFetch = eightModelActions;
let modelMissingFields = ['productMatch'];
try {
  globalThis.fetch = async (_url, request) => {
    calledModel = JSON.parse(request.body).model;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        intent: 'add_stock',
        confidence: 0.9,
        actions: modelActionsForFetch,
        missingFields: modelMissingFields,
        suggestedPhrases: [
          `¿Cargar ${existingNames[0]}?`,
          `¿Cargar ${existingNames[5]}?`,
        ],
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const parsed = await parseVoiceText(transcript, { businessCategory: 'indumentaria', catalog });
  assert.equal(calledModel, 'gemini-3.1-flash-lite');
  assert.deepEqual(parsed.missingFields ?? [], []);
  assert.equal(parsed.actions.length, 8);
  assert.equal(parsed.actions.reduce((total, item) => total + item.qty, 0), 9);
  assert.equal(parsed.actions.find((item) => item.productName === 'Camiseta Argentina Suplente En Version Jugador M')?.qty, 2);
  assert.ok(parsed.actions.every((item) => item.size === 'M'));
  assert.ok(parsed.actions.every((item) => item.productType === 'Camiseta' && item.productModel));
  modelActionsForFetch = eightModelActions.map((item) => ({
    ...item,
    productName: item.productName.replace(/ M$/, ''),
    size: undefined,
  }));
  const recovered = await parseVoiceText(transcript, { businessCategory: 'indumentaria', catalog });
  assert.ok(recovered.actions.every((item) => item.size === 'M'));
  assert.equal(recovered.actions.reduce((total, item) => total + item.qty, 0), 9);
  modelActionsForFetch = [{
    type: 'add_stock', productName: 'Taladro Bosch 18V',
    productType: 'Taladro', productModel: 'Bosch 18V', qty: 2,
  }];
  modelMissingFields = [];
  const hardware = await parseVoiceText('Ingresaron dos taladros Bosch 18V, todos en medida 13mm.', {
    businessCategory: 'ferreteria', catalog: { products: [], clients: [], pedidos: [] },
  });
  assert.equal(hardware.actions[0].size, '13MM');
  assert.equal(hardware.actions[0].productType, 'Taladro');
  assert.equal(hardware.actions[0].productModel, 'Bosch 18V');
  modelActionsForFetch = [{ type: 'add_stock', productName: 'Bosch Taladro 18V', qty: 1 }];
  const hardwareVariant = await parseVoiceText('Ingresó Bosch taladro 18V medida 10mm.', {
    businessCategory: 'ferreteria',
    catalog: { products: [{
      id: 'taladro-13', name: 'Taladro Bosch 18V',
      productType: 'Taladro', productModel: 'Bosch 18V', size: '13mm',
    }], clients: [], pedidos: [] },
  });
  assert.equal(hardwareVariant.actions[0].size, '10MM');
  assert.equal(hardwareVariant.actions[0].productType, 'Taladro');
  assert.equal(hardwareVariant.actions[0].productModel, 'Bosch 18V');
  modelActionsForFetch = [{
    type: 'add_stock', productName: 'Zapatilla Nike Air',
    productType: 'Zapatilla', productModel: 'Nike Air', qty: 1,
  }];
  const shoes = await parseVoiceText('Ingresó una zapatilla Nike Air número 42.', {
    businessCategory: 'calzado', catalog: { products: [], clients: [], pedidos: [] },
  });
  assert.equal(shoes.actions[0].size, '42');
  modelActionsForFetch = [{
    type: 'add_stock', productName: 'Teléfono Marca X',
    productType: 'Teléfono', productModel: 'Marca X', qty: 1,
  }];
  const electronics = await parseVoiceText('Ingresó un teléfono Marca X variante 128GB.', {
    businessCategory: 'electronica', catalog: { products: [], clients: [], pedidos: [] },
  });
  assert.equal(electronics.actions[0].size, '128GB');
  console.log('Identidad y variantes: audio largo, indumentaria, ferretería, calzado y electrónica correctos.');
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.GEMINI_API_KEY;
  delete process.env.LLM_DISABLE_FALLBACK;
}
