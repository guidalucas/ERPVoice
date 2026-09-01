import { parseLocalText } from '../server/metaWebhookProcessor.js';
import { groundActionsAgainstCatalog } from '../server/voiceCatalogContext.js';
import { answerStockQuery, matchProductsForQuery } from '../server/postgresDatabase.js';

const riverCatalog = {
  products: [
    {
      id: 'r1',
      name: 'Camiseta River 2024 En La Titular 2024',
      productType: 'Camiseta',
      productModel: '2024',
      size: 'S',
      stockAvailable: 1,
      stockReserved: 0,
    },
    {
      id: 'r2',
      name: 'Camiseta River 2025 Version Jugador',
      productType: 'Camiseta',
      productModel: 'River 2025 Version Jugador',
      size: 'S',
      stockAvailable: 1,
      stockReserved: 0,
    },
    {
      id: 'r3',
      name: 'Camiseta River Titular 2026',
      productType: 'Camiseta',
      productModel: 'River Titular 2026',
      size: 'S',
      stockAvailable: 1,
      stockReserved: 0,
    },
    {
      id: 'b1',
      name: 'Camiseta Boca Titular 2026',
      productType: 'Camiseta',
      productModel: 'Boca Titular 2026',
      size: 'M',
      stockAvailable: 4,
      stockReserved: 0,
    },
  ],
  clients: [],
  pedidos: [],
};

const namesOf = (products) => products.map((product) => product.name).sort();

const norm = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
};

const pass = (message) => {
  console.log(`OK: ${message}`);
};

const familyQuery = {
  type: 'query_stock',
  productName: 'Camiseta River',
  productType: 'Camiseta',
  productModel: 'River',
};

const familyMatches = matchProductsForQuery(riverCatalog.products, familyQuery);
if (familyMatches.length === 3 && familyMatches.every((product) => /river/i.test(product.name))) {
  pass(`matchProductsForQuery("Camiseta River") encontró ${familyMatches.length} camisetas de River`);
} else {
  fail(`matchProductsForQuery familia River: ${namesOf(familyMatches).join(' | ') || 'ninguna'}`);
}

const specificMatches = matchProductsForQuery(riverCatalog.products, {
  type: 'query_stock',
  productName: 'Camiseta River 2024 Titular',
  productType: 'Camiseta',
  productModel: 'River 2024 Titular',
});
if (specificMatches.length === 1 && specificMatches[0].id === 'r1') {
  pass('query puntual "River 2024 Titular" no arrastra 2025/2026');
} else {
  fail(`query puntual devolvió: ${namesOf(specificMatches).join(' | ')}`);
}

const bocaMatches = matchProductsForQuery(riverCatalog.products, familyQuery);
if (bocaMatches.some((product) => /boca/i.test(product.name))) {
  fail('la familia River también matcheó Boca');
} else {
  pass('la familia River no incluye Boca');
}

const llmPinnedToOneSku = groundActionsAgainstCatalog(
  [
    {
      type: 'query_stock',
      productName: 'Camiseta River 2024 Titular',
      productType: 'Camiseta',
      productModel: 'River 2024 Titular',
    },
  ],
  riverCatalog,
  'no tengo mas camisetas de river?',
);
const grounded = llmPinnedToOneSku.actions[0];
const groundedMatches = matchProductsForQuery(riverCatalog.products, grounded);
if (groundedMatches.length === 3) {
  pass(
    `grounding no clavó un SKU: productName="${grounded.productName}" productModel="${grounded.productModel}" → ${groundedMatches.length} matches`,
  );
} else {
  fail(
    `grounding quedó en un SKU (${grounded.productName} / ${grounded.productModel}): ${namesOf(groundedMatches).join(' | ')}`,
  );
}

const parsed = parseLocalText('no tengo mas camisetas de river?', [], riverCatalog);
const parsedAction = parsed?.actions?.[0];
const parsedMatches = parsedAction ? matchProductsForQuery(riverCatalog.products, parsedAction) : [];
const reply = parsedAction ? answerStockQuery(riverCatalog.products, parsedAction) : '';

if (parsed?.intent === 'query_stock' && parsedMatches.length === 3) {
  pass(`parser local entendió la frase y listó ${parsedMatches.length} productos`);
} else {
  fail(
    `parser local: intent=${parsed?.intent} action=${JSON.stringify(parsedAction)} matches=${namesOf(parsedMatches).join(' | ')}`,
  );
}

if (/River 2024 En La Titular 2024/i.test(reply) && /2025/i.test(reply) && /2026/i.test(reply) && /boca/i.test(reply) === false) {
  pass('la respuesta de WhatsApp menciona las tres camisetas de River');
} else {
  fail(`respuesta incompleta:\n${reply}`);
}

const sameModelCatalog = [
  {
    id: 'rt-m',
    name: 'Camiseta River Titular M',
    productType: 'Camiseta',
    productModel: 'River Titular',
    size: 'M',
    stockAvailable: 9,
    stockReserved: 0,
  },
  {
    id: 'rt-l',
    name: 'Camiseta River Titular L',
    productType: 'Camiseta',
    productModel: 'River Titular',
    size: 'L',
    stockAvailable: 2,
    stockReserved: 0,
  },
  {
    id: 'rs-s',
    name: 'Camiseta River Suplente S',
    productType: 'Camiseta',
    productModel: 'River Suplente',
    size: 'S',
    stockAvailable: 5,
    stockReserved: 0,
  },
];
const titularOnly = matchProductsForQuery(sameModelCatalog, {
  productName: 'Camiseta River Titular',
  productType: 'Camiseta',
  productModel: 'River Titular',
});
if (titularOnly.length === 2 && titularOnly.every((product) => product.productModel === 'River Titular')) {
  pass('un modelo con varios talles sigue agrupando los dos SKUs y no mezcla la suplente');
} else {
  fail(`talles del mismo modelo: ${namesOf(titularOnly).join(' | ')}`);
}

const productionCatalog = {
  products: [
    {
      id: 'r1',
      name: 'Camiseta River 2024 En La Titular 2024',
      productType: 'Camiseta River 2024 En La Titular',
      productModel: '2024',
      size: 'S',
      stockAvailable: 1,
      stockReserved: 0,
    },
    {
      id: 'r2',
      name: 'Camiseta River 2025 Version Jugador',
      productType: 'Camiseta',
      productModel: 'River 2025 Version Jugador',
      size: 'S',
      stockAvailable: 1,
      stockReserved: 0,
    },
    {
      id: 'r3',
      name: 'Camiseta River Titular 2026',
      productType: 'Camiseta',
      productModel: 'River Titular 2026',
      size: 'S',
      stockAvailable: 1,
      stockReserved: 0,
    },
  ],
};

const productionLlmAction = {
  type: 'query_stock',
  productName: 'Camiseta River 2024 En La Titular 2024',
  productType: 'Camiseta River 2024 En La Titular',
  productModel: '2024',
};

const groundedWithSkuSource = groundActionsAgainstCatalog(
  [productionLlmAction],
  productionCatalog,
  'Camiseta River 2024 En La Titular 2024',
);
const skuSourceMatches = matchProductsForQuery(productionCatalog.products, groundedWithSkuSource.actions[0]);
if (skuSourceMatches.length === 1) {
  pass('control: si el grounding ve el SKU del modelo, sigue clavando uno (el bug de producción)');
} else {
  fail(`control SKU sourceText no reprodujo el bug: ${namesOf(skuSourceMatches).join(' | ')}`);
}

const groundedWithUserText = groundActionsAgainstCatalog(
  [productionLlmAction],
  productionCatalog,
  'que camisetas de river tengo',
);
const userTextMatches = matchProductsForQuery(productionCatalog.products, groundedWithUserText.actions[0]);
if (
  userTextMatches.length === 3 &&
  !/2024 En La Titular 2024$/i.test(String(groundedWithUserText.actions[0].productName)) &&
  norm(groundedWithUserText.actions[0].productModel) === 'river'
) {
  pass(
    `con el texto original de WhatsApp lista las 3: ${groundedWithUserText.actions[0].productName} / ${groundedWithUserText.actions[0].productModel}`,
  );
} else {
  fail(
    `texto original no generalizó: ${JSON.stringify(groundedWithUserText.actions[0])} matches=${namesOf(userTextMatches).join(' | ')}`,
  );
}

const cuantas = parseLocalText('cuantas camisetas de river tengo', [], productionCatalog);
const cuantasMatches = cuantas?.actions?.[0] ? matchProductsForQuery(productionCatalog.products, cuantas.actions[0]) : [];
if (cuantasMatches.length === 3) {
  pass('parser local: "cuantas camisetas de river tengo" lista las 3');
} else {
  fail(`cuantas: ${JSON.stringify(cuantas?.actions?.[0])} matches=${namesOf(cuantasMatches).join(' | ')}`);
}

const queTengo = parseLocalText('que camisetas de river tengo', [], productionCatalog);
const queMatches = queTengo?.actions?.[0] ? matchProductsForQuery(productionCatalog.products, queTengo.actions[0]) : [];
if (queMatches.length === 3) {
  pass('parser local: "que camisetas de river tengo" lista las 3');
} else {
  fail(`que tengo: ${JSON.stringify(queTengo?.actions?.[0])} matches=${namesOf(queMatches).join(' | ')}`);
}

console.log('\n--- Respuesta ---\n');
console.log(reply);

if (process.exitCode) {
  console.error('\nHubo fallos.');
  process.exit(1);
}

console.log('\nTodos los casos de River pasaron.');
