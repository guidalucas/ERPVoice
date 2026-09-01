/**
 * Batería de robustez del parser multi-rubro de Stocky.
 *
 * Llama al parser real (parseVoiceText → Groq/Llama + grounding de catálogo).
 * No muta inventario ni toca la lógica del parser: solo mide.
 *
 *   node scripts/test-parser-robustness.js
 *   node scripts/test-parser-robustness.js --local
 *   node scripts/test-parser-robustness.js --categories=indumentaria,kiosco --sections=ventas,borrar
 *   node scripts/test-parser-robustness.js --limit=8 --delay-ms=0
 *
 * Prioridad: detectar falsos positivos (acción aplicada al SKU equivocado sin preguntar).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { parseLocalText, parseVoiceText } from '../server/metaWebhookProcessor.js';
import { hasProductMatchHold, scoreProductAgainstQuery } from '../server/voiceCatalogContext.js';

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MUTATING_TYPES = new Set([
  'add_stock',
  'sell',
  'delete_product',
  'update_product',
  'reserve_stock',
  'add_debt',
  'payment_received',
  'client_order',
  'update_pedido',
  'delete_pedido',
]);

const PRODUCT_TYPES = new Set([
  'add_stock',
  'sell',
  'delete_product',
  'update_product',
  'reserve_stock',
  'query_stock',
  'client_order',
]);

const VERDICTS = {
  correct_direct: 'correct_direct',
  correct_confirm: 'correct_confirm',
  correct_idle: 'correct_idle',
  over_ask: 'over_ask',
  incorrect_fields: 'incorrect_fields',
  false_positive: 'false_positive',
  missed: 'missed',
  error: 'error',
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const argValue = (name, fallback = '') => {
  const prefix = `--${name}=`;
  const hit = args.find((entry) => entry.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const USE_LOCAL = flag('local');
const LIMIT = Number(argValue('limit', '0')) || 0;
const DELAY_MS = Number(argValue('delay-ms', USE_LOCAL ? '0' : '7000')) || 0;
const CATEGORY_FILTER = new Set(
  argValue('categories')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const SECTION_FILTER = new Set(
  argValue('sections')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const ID_FILTER = new Set(
  argValue('only')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const OUT_MD = path.resolve(ROOT, argValue('out', 'scripts/test-results.md'));
const OUT_JSON = path.resolve(ROOT, argValue('json', 'scripts/test-results.json'));
const COMPARE_PATH = path.resolve(ROOT, argValue('compare', 'scripts/test-results-local.json'));

const caseKey = (row) => `${row.inventoryId}::${row.caseId}`;

const loadPreviousResults = () => {
  if (!fs.existsSync(COMPARE_PATH)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(COMPARE_PATH, 'utf8'));
  } catch {
    return null;
  }
};

const compareFalsePositives = (previous, results) => {
  const prevRows = (previous?.results || []).filter((row) => row.evaluation?.verdict === VERDICTS.false_positive);
  const currRows = results.filter((row) => row.evaluation.verdict === VERDICTS.false_positive);
  const prevMap = new Map(prevRows.map((row) => [caseKey(row), row]));
  const currMap = new Map(currRows.map((row) => [caseKey(row), row]));
  const resolved = [...prevMap.keys()].filter((key) => !currMap.has(key)).map((key) => prevMap.get(key));
  const still = [...prevMap.keys()].filter((key) => currMap.has(key)).map((key) => currMap.get(key));
  const novel = [...currMap.keys()].filter((key) => !prevMap.has(key)).map((key) => currMap.get(key));
  return { previousCount: prevRows.length, resolved, still, novel, previousMode: previous?.mode || 'desconocido' };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

const productHaystack = (product) =>
  normalize([product?.name, product?.productType, product?.productModel, product?.size].filter(Boolean).join(' '));

const modelKey = (product) => {
  const fromParts = normalize([product?.productType, product?.productModel].filter(Boolean).join(' '));
  if (fromParts) {
    return fromParts;
  }
  const name = normalize(product?.name || '');
  const size = normalize(product?.size || '');
  if (size && name.endsWith(` ${size}`)) {
    return name.slice(0, -size.length).trim();
  }
  return name;
};

const product = (productType, productModel, size, extras = {}) => ({
  id: extras.id,
  name: extras.name || [productType, productModel, size].filter(Boolean).join(' '),
  productType: productType || null,
  productModel: productModel || null,
  size: size || null,
  stockAvailable: extras.stock ?? 8,
  stockReserved: extras.reserved ?? 0,
  price: extras.price ?? 10000,
});

const client = (id, name, debt = 0, notas = null) => ({ id, name, debt, notas });

const pedido = (id, clienteId, producto, extras = {}) => ({
  id,
  clienteId,
  proveedorId: extras.proveedorId ?? null,
  producto,
  productType: extras.productType ?? null,
  productModel: extras.productModel ?? null,
  talle: extras.talle ?? null,
  qty: extras.qty ?? 1,
  estado: extras.estado ?? 'pendiente',
  fechaPedido: extras.fecha ?? '2026-08-30T15:00:00.000Z',
  notas: extras.notas ?? null,
});

const sharedPeople = () => ({
  clients: [
    client('c-juan', 'Juan', 20000, 'Cliente de siempre'),
    client('c-juan-perez', 'Juan Pérez', 5000, null),
    client('c-maria', 'María', 10000, null),
  ],
  proveedores: [{ id: 'pr-norte', name: 'Distribuidora Norte', notas: 'Entrega los lunes' }],
});

const withPeople = (catalog, pedidos) => {
  const people = sharedPeople();
  return {
    ...catalog,
    clients: people.clients,
    proveedores: people.proveedores,
    pedidos,
    transactions: [],
  };
};

const inventories = [
  {
    id: 'indumentaria',
    label: 'Indumentaria / Ropa',
    catalog: withPeople(
      {
        products: [
          product('Camiseta', 'Boca Titular', 'S', { id: 'ind-boca-tit-s', stock: 6, price: 45000 }),
          product('Camiseta', 'Boca Titular', 'M', { id: 'ind-boca-tit-m', stock: 10, price: 45000 }),
          product('Camiseta', 'Boca Titular', 'L', { id: 'ind-boca-tit-l', stock: 4, price: 45000 }),
          product('Camiseta', 'Boca Suplente', 'S', { id: 'ind-boca-sup-s', stock: 3, price: 48000 }),
          product('Camiseta', 'Boca Suplente', 'M', { id: 'ind-boca-sup-m', stock: 7, price: 48000 }),
          product('Camiseta', 'River Titular', 'M', { id: 'ind-river-tit-m', stock: 9, price: 48000 }),
          product('Camiseta', 'River Titular', 'L', { id: 'ind-river-tit-l', stock: 2, price: 48000 }),
          product('Camiseta', 'River Suplente', 'S', { id: 'ind-river-sup-s', stock: 5, price: 52000 }),
          product('Camiseta', 'River Suplente', 'M', { id: 'ind-river-sup-m', stock: 4, price: 52000 }),
          product('Camiseta', 'Argentina Titular', 'M', { id: 'ind-arg-tit-m', stock: 1, price: 65000 }),
          product('Camiseta', 'Argentina Titular', 'L', { id: 'ind-arg-tit-l', stock: 3, price: 65000 }),
          product('Camiseta', 'Argentina Suplente', 'M', { id: 'ind-arg-sup-m', stock: 2, price: 62000 }),
        ],
      },
      [
        pedido('ped-ind-juan', 'c-juan', 'Camiseta Boca Titular', { productType: 'Camiseta', productModel: 'Boca Titular', talle: 'M', qty: 1 }),
        pedido('ped-ind-maria', 'c-maria', 'Camiseta River Titular', { productType: 'Camiseta', productModel: 'River Titular', talle: 'L', qty: 1 }),
      ],
    ),
  },
  {
    id: 'calzado',
    label: 'Calzado',
    catalog: withPeople(
      {
        products: [
          product('Zapatilla', 'Nike Air Force blanca', '41', { id: 'cal-af-bl-41', stock: 4, price: 80000 }),
          product('Zapatilla', 'Nike Air Force blanca', '42', { id: 'cal-af-bl-42', stock: 6, price: 80000 }),
          product('Zapatilla', 'Nike Air Force negra', '42', { id: 'cal-af-ng-42', stock: 3, price: 78000 }),
          product('Zapatilla', 'Adidas Superstar', '39', { id: 'cal-ss-39', stock: 5, price: 70000 }),
          product('Zapatilla', 'Adidas Superstar', '40', { id: 'cal-ss-40', stock: 2, price: 70000 }),
          product('Zapatilla', 'Puma Suede gris', '41', { id: 'cal-puma-41', stock: 3, price: 65000 }),
          product('Zapatilla', 'Puma Suede gris', '42', { id: 'cal-puma-42', stock: 4, price: 65000 }),
        ],
      },
      [
        pedido('ped-cal-juan', 'c-juan', 'Zapatilla Nike Air Force blanca', { productType: 'Zapatilla', productModel: 'Nike Air Force blanca', talle: '42', qty: 1 }),
        pedido('ped-cal-maria', 'c-maria', 'Zapatilla Adidas Superstar', { productType: 'Zapatilla', productModel: 'Adidas Superstar', talle: '39', qty: 1 }),
      ],
    ),
  },
  {
    id: 'ferreteria',
    label: 'Ferretería',
    catalog: withPeople(
      {
        products: [
          product('Tornillo', 'Autoperforante', '3/4', { id: 'fer-auto-34', stock: 200, price: 80 }),
          product('Tornillo', 'Autoperforante', '1/2', { id: 'fer-auto-12', stock: 150, price: 60 }),
          product('Tornillo', 'Madera', '3/4', { id: 'fer-mad-34', stock: 90, price: 50 }),
          product('Tuerca', 'Hexagonal', '8mm', { id: 'fer-tuer-8', stock: 40, price: 30 }),
          product('Tuerca', 'Hexagonal', '10mm', { id: 'fer-tuer-10', stock: 35, price: 35 }),
          product('Destornillador', 'Phillips', null, { id: 'fer-dest-ph', stock: 12, price: 2500 }),
        ],
      },
      [
        pedido('ped-fer-juan', 'c-juan', 'Tornillo Autoperforante', { productType: 'Tornillo', productModel: 'Autoperforante', talle: '3/4', qty: 3 }),
        pedido('ped-fer-maria', 'c-maria', 'Destornillador Phillips', { productType: 'Destornillador', productModel: 'Phillips', qty: 1 }),
      ],
    ),
  },
  {
    id: 'electronica',
    label: 'Electrónica',
    catalog: withPeople(
      {
        products: [
          product('Cargador', 'Tipo C', '20W', { id: 'ele-c-20', stock: 15, price: 8000 }),
          product('Cargador', 'Tipo C', '30W', { id: 'ele-c-30', stock: 9, price: 12000 }),
          product('Auriculares', 'Bluetooth Sony', null, { id: 'ele-sony', stock: 6, price: 35000 }),
          product('Auriculares', 'Bluetooth JBL', null, { id: 'ele-jbl', stock: 4, price: 28000 }),
          product('Cable', 'HDMI', '2m', { id: 'ele-hdmi', stock: 20, price: 4500 }),
        ],
      },
      [
        pedido('ped-ele-juan', 'c-juan', 'Cargador Tipo C', { productType: 'Cargador', productModel: 'Tipo C', talle: '20W', qty: 1 }),
        pedido('ped-ele-maria', 'c-maria', 'Auriculares Bluetooth Sony', { productType: 'Auriculares', productModel: 'Bluetooth Sony', qty: 1 }),
      ],
    ),
  },
  {
    id: 'kiosco',
    label: 'Kiosco / Almacén',
    catalog: withPeople(
      {
        products: [
          product('Alfajor', 'Jorgito', null, { id: 'kio-jorgito', stock: 40, price: 900 }),
          product('Gaseosa', 'Coca Cola 1.5L', null, { id: 'kio-coca-15', name: 'Gaseosa Coca Cola 1.5L', stock: 18, price: 2200 }),
          product('Gaseosa', 'Coca Cola 500ml', null, { id: 'kio-coca-500', name: 'Gaseosa Coca Cola 500ml', stock: 24, price: 1200 }),
          product('Gaseosa', 'Sprite 1.5L', null, { id: 'kio-sprite', name: 'Gaseosa Sprite 1.5L', stock: 10, price: 2000 }),
          product('Chocolate', 'Milka', null, { id: 'kio-milka', stock: 12, price: 1800 }),
        ],
      },
      [
        pedido('ped-kio-juan', 'c-juan', 'Gaseosa Coca Cola 1.5L', { productType: 'Gaseosa', productModel: 'Coca Cola 1.5L', qty: 2 }),
        pedido('ped-kio-maria', 'c-maria', 'Alfajor Jorgito', { productType: 'Alfajor', productModel: 'Jorgito', qty: 6 }),
      ],
    ),
  },
  {
    id: 'general',
    label: 'General / Sin categoría',
    catalog: withPeople(
      {
        products: [
          product('Mate', 'Imperial', null, { id: 'gen-mate', name: 'Mate Imperial', stock: 7, price: 18000 }),
          product('Termo', 'Lumilagro', null, { id: 'gen-termo', name: 'Termo Lumilagro', stock: 5, price: 25000 }),
          product('Combo', 'Cumpleaños', null, { id: 'gen-combo', name: 'Combo Cumpleaños', stock: 3, price: 12000 }),
          product('Velas', 'Aromaticas', null, { id: 'gen-velas', name: 'Velas Aromaticas', stock: 14, price: 3500 }),
        ],
      },
      [
        pedido('ped-gen-juan', 'c-juan', 'Mate Imperial', { productType: 'Mate', productModel: 'Imperial', qty: 1 }),
        pedido('ped-gen-maria', 'c-maria', 'Termo Lumilagro', { productType: 'Termo', productModel: 'Lumilagro', qty: 1 }),
      ],
    ),
  },
];

const turns = (...items) => items;

const userTurn = (text, actions = []) => ({ role: 'user', text, actions });
const assistantTurn = (text, actions = []) => ({ role: 'assistant', text, actions });

const argentinaQueryTurns = () =>
  turns(
    userTurn('¿Cuántas de Argentina hay?', [
      { type: 'query_stock', productName: 'Camiseta Argentina Titular', productType: 'Camiseta', productModel: 'Argentina Titular' },
    ]),
    assistantTurn('Hay 1 en M y 3 en L de Argentina titular, y 2 de la suplente M.', [
      { type: 'query_stock', productName: 'Camiseta Argentina Titular', productType: 'Camiseta', productModel: 'Argentina Titular' },
    ]),
  );

const sellArgentinaTurns = () =>
  turns(
    userTurn('Vendí 2 de Argentina talle L', [
      { type: 'sell', productName: 'Camiseta Argentina Titular L', productType: 'Camiseta', productModel: 'Argentina Titular', size: 'L', qty: 2 },
    ]),
    assistantTurn('Voy a vender 2 Camiseta Argentina Titular L. Confirmá o cancelá.', [
      { type: 'sell', productName: 'Camiseta Argentina Titular L', size: 'L', qty: 2 },
    ]),
  );

const deferredLoadTurns = () =>
  turns(
    userTurn('una remera de River suplente S'),
    userTurn('otra de River suplente M'),
    userTurn('una de Boca titular L'),
  );

const testCases = [
  {
    id: 'load-boca-m',
    section: 'cargar',
    message: 'Compré 10 camisetas de Boca talle M a 45 mil',
    expected: { types: ['add_stock'], tokens: ['boca'], size: 'M', qty: 10, price: 45000, matchPolicy: 'confirm-multi' },
  },
  {
    id: 'load-air-force-42',
    section: 'cargar',
    message: 'Me llegaron 20 pares de Air Force blancas número 42',
    expected: { types: ['add_stock'], tokens: ['air', 'force', 'blanca'], size: '42', qty: 20, matchPolicy: 'sku' },
  },
  {
    id: 'load-tornillos-34',
    section: 'cargar',
    message: 'Tengo 50 tornillos autoperforantes de 3/4 para cargar',
    expected: { types: ['add_stock'], tokens: ['tornillo', 'autoperforante'], size: '3/4', qty: 50, matchPolicy: 'sku' },
  },
  {
    id: 'load-cargador-20w',
    section: 'cargar',
    message: 'Metele 15 cargadores tipo C al sistema, 20W, a 8 lucas',
    expected: { types: ['add_stock'], tokens: ['cargador'], size: '20W', qty: 15, price: 8000, matchPolicy: 'sku' },
  },
  {
    id: 'load-jorgito',
    section: 'cargar',
    message: 'Sumá 30 alfajores Jorgito a 900 pesos',
    expected: { types: ['add_stock'], tokens: ['jorgito'], qty: 30, price: 900, matchPolicy: 'sku' },
  },
  {
    id: 'load-mates-termos',
    section: 'cargar',
    message: 'Llegó mercadería: 5 mates imperiales a 18 mil y 5 termos Lumilagro a 25 mil',
    expected: {
      types: ['add_stock'],
      tokenGroups: [['mate'], ['lumilagro']],
      qty: 5,
      minActions: 2,
      requireAllTypes: true,
      matchPolicy: 'create-ok',
    },
  },
  {
    id: 'load-deferred-close',
    section: 'cargar',
    message: 'cargalo al sistema',
    conversationTurns: deferredLoadTurns(),
    expected: { types: ['add_stock'], tokens: ['river'], minActions: 2, matchPolicy: 'create-ok' },
  },
  {
    id: 'load-velez-new',
    section: 'cargar',
    message: 'Cargá camiseta de Vélez alternativa talle L a 55 mil',
    expected: { types: ['add_stock'], tokens: ['velez'], size: 'L', price: 55000, matchPolicy: 'create-ok' },
  },
  {
    id: 'stock-argentina',
    section: 'consultar',
    message: '¿Cuántas de Argentina hay?',
    expected: { types: ['query_stock'], tokens: ['argentina'], matchPolicy: 'confirm-multi' },
  },
  {
    id: 'stock-river-followup',
    section: 'consultar',
    message: '¿y las de River?',
    conversationTurns: argentinaQueryTurns(),
    expected: { types: ['query_stock'], tokens: ['river'], matchPolicy: 'confirm-multi' },
  },
  {
    id: 'stock-tornillos-34',
    section: 'consultar',
    message: '¿Cómo andamos de tornillos de 3/4?',
    expected: { types: ['query_stock'], tokens: ['tornillo'], size: '3/4', matchPolicy: 'confirm-multi' },
  },
  {
    id: 'stock-auriculares',
    section: 'consultar',
    message: '¿Tenés stock de auriculares Bluetooth?',
    expected: { types: ['query_stock'], tokens: ['auriculares'], matchPolicy: 'confirm-multi' },
  },
  {
    id: 'stock-coca',
    section: 'consultar',
    message: '¿Qué me queda de Coca?',
    expected: { types: ['query_stock'], tokens: ['coca'], matchPolicy: 'confirm-multi' },
  },
  {
    id: 'stock-air-force-41',
    section: 'consultar',
    message: 'Che, ¿hay Air Force en 41?',
    expected: { types: ['query_stock'], tokens: ['air', 'force'], size: '41', matchPolicy: 'sku' },
  },
  {
    id: 'stock-boca-ambiguous',
    section: 'consultar',
    message: '¿cuánto tengo de Boca?',
    expected: { types: ['query_stock'], tokens: ['boca'], matchPolicy: 'confirm-multi' },
  },
  {
    id: 'update-boca-price',
    section: 'actualizar',
    message: 'Las de Boca ahora valen 50 mil',
    expected: { types: ['update_product'], tokens: ['boca'], price: 50000, matchPolicy: 'confirm-multi' },
  },
  {
    id: 'update-air-force-blanca',
    section: 'actualizar',
    message: 'Subile el precio a la Nike Air Force blanca a 85 mil',
    expected: { types: ['update_product'], tokens: ['air', 'force', 'blanca'], price: 85000, matchPolicy: 'model-all' },
  },
  {
    id: 'update-tornillos-delta',
    section: 'actualizar',
    message: 'Bajale 5 mil a los tornillos de 3/4',
    expected: { types: ['update_product'], tokens: ['tornillo'], size: '3/4', matchPolicy: 'confirm-multi' },
  },
  {
    id: 'update-mate-price',
    section: 'actualizar',
    message: 'Cambiá el precio del mate imperial a 20 mil',
    expected: { types: ['update_product'], tokens: ['mate'], price: 20000, matchPolicy: 'sku' },
  },
  {
    id: 'update-cargador-qty',
    section: 'actualizar',
    message: 'Actualizá la cantidad de cargadores tipo C a 8',
    expected: { types: ['update_product'], tokens: ['cargador'], stockAvailable: 8, matchPolicy: 'confirm-multi' },
  },
  {
    id: 'update-river-ambiguous',
    section: 'actualizar',
    message: 'Subí el precio de la de River',
    expected: { types: ['update_product'], tokens: ['river'], matchPolicy: 'confirm-multi' },
  },
  {
    id: 'delete-river',
    section: 'borrar',
    message: 'Borrá la de River, no existe',
    expected: { types: ['delete_product'], tokens: ['river'], matchPolicy: 'confirm-multi' },
  },
  {
    id: 'delete-tornillos-12',
    section: 'borrar',
    message: 'Sacá los tornillos de 1/2, ya no los vendo más',
    expected: { types: ['delete_product'], tokens: ['tornillo'], size: '1/2', matchPolicy: 'sku' },
  },
  {
    id: 'delete-puma-suede',
    section: 'borrar',
    message: 'Eliminá el Puma Suede gris',
    expected: { types: ['delete_product'], tokens: ['puma', 'suede'], matchPolicy: 'confirm-multi' },
  },
  {
    id: 'delete-coca-litro-medio',
    section: 'borrar',
    message: 'Dale de baja la Coca de litro y medio',
    expected: { types: ['delete_product'], tokens: ['coca', '1.5'], matchPolicy: 'sku' },
  },
  {
    id: 'delete-velez-missing',
    section: 'borrar',
    message: 'Esa camiseta de Vélez está mal cargada, borrala',
    expected: { types: ['delete_product'], tokens: ['velez'], matchPolicy: 'create-ok' },
  },
  {
    id: 'delete-boca-ambiguous',
    section: 'borrar',
    message: 'Borrá la de Boca',
    expected: { types: ['delete_product'], tokens: ['boca'], matchPolicy: 'confirm-multi' },
  },
  {
    id: 'sell-argentina-l',
    section: 'ventas',
    message: 'Vendí 2 de Argentina talle L',
    expected: { types: ['sell'], tokens: ['argentina'], size: 'L', qty: 2, matchPolicy: 'sku' },
  },
  {
    id: 'sell-superstar-39',
    section: 'ventas',
    message: 'Se llevó una zapatilla Adidas Superstar 39',
    expected: { types: ['sell'], tokens: ['superstar'], size: '39', qty: 1, matchPolicy: 'sku' },
  },
  {
    id: 'sell-mate',
    section: 'ventas',
    message: 'Salió un mate imperial',
    expected: { types: ['sell'], tokens: ['mate'], qty: 1, matchPolicy: 'sku' },
  },
  {
    id: 'sell-media-docena-tornillos',
    section: 'ventas',
    message: 'Vendí media docena de tornillos 3/4',
    expected: { types: ['sell'], tokens: ['tornillo'], size: '3/4', qty: 6, matchPolicy: 'confirm-multi' },
  },
  {
    id: 'sell-coca-litro',
    section: 'ventas',
    message: 'Dos gaseosas Coca de litro',
    expected: { types: ['sell'], tokens: ['coca'], qty: 2, matchPolicy: 'confirm-multi' },
  },
  {
    id: 'sell-river-ambiguous',
    section: 'ventas',
    message: 'Vendí una de River',
    expected: { types: ['sell'], tokens: ['river'], qty: 1, matchPolicy: 'confirm-multi' },
  },
  {
    id: 'sales-today',
    section: 'ventas',
    message: '¿cuánto vendí hoy?',
    expected: { types: [], matchPolicy: 'none', unsupportedQuery: true },
  },
  {
    id: 'sales-week',
    section: 'ventas',
    message: '¿qué vendí esta semana?',
    expected: { types: [], matchPolicy: 'none', unsupportedQuery: true },
  },
  {
    id: 'sales-month',
    section: 'ventas',
    message: 'mostrame las ventas del mes',
    expected: { types: [], matchPolicy: 'none', unsupportedQuery: true },
  },
  {
    id: 'order-juan-boca',
    section: 'pedidos',
    message: 'Juan me pidió una camiseta de Boca talle M',
    expected: { types: ['client_order'], tokens: ['boca'], size: 'M', qty: 1, clientName: 'Juan', matchPolicy: 'confirm-multi' },
  },
  {
    id: 'order-maria-mate',
    section: 'pedidos',
    message: 'Anotame que María quiere un mate imperial',
    expected: { types: ['client_order'], tokens: ['mate'], clientName: 'María', matchPolicy: 'sku' },
  },
  {
    id: 'order-cliente-siempre',
    section: 'pedidos',
    message: 'Pedime 3 tornillos de 3/4 para el cliente de siempre',
    expected: { types: ['client_order'], tokens: ['tornillo'], qty: 3, matchPolicy: 'confirm-client' },
  },
  {
    id: 'order-query-pending',
    section: 'pedidos',
    message: '¿qué pedidos hay pendientes?',
    expected: { types: ['query_pedidos'], matchPolicy: 'none', estado: 'pendiente' },
  },
  {
    id: 'order-query-juan',
    section: 'pedidos',
    message: '¿qué me pidió Juan?',
    expected: { types: ['query_pedidos'], matchPolicy: 'none', clientName: 'Juan' },
  },
  {
    id: 'order-mark-juan',
    section: 'pedidos',
    message: 'Marcá como conseguido el pedido de Juan',
    expected: { types: ['update_pedido'], matchPolicy: 'none', estado: 'conseguido', clientName: 'Juan' },
  },
  {
    id: 'order-discard-maria',
    section: 'pedidos',
    message: 'el pedido de María se descartó, ya no lo quiere',
    expected: { types: ['update_pedido'], matchPolicy: 'none', estado: 'descartado', clientName: 'María' },
  },
  {
    id: 'order-delete-juan',
    section: 'pedidos',
    message: 'borrá el pedido de Juan',
    expected: { types: ['delete_pedido'], matchPolicy: 'none', clientName: 'Juan' },
  },
  {
    id: 'order-pedro-new',
    section: 'pedidos',
    message: 'Anotame que Pedro pidió una zapatilla 42, es cliente nuevo',
    expected: { types: ['client_order'], tokens: ['zapatilla'], size: '42', clientName: 'Pedro', matchPolicy: 'confirm-multi' },
  },
  {
    id: 'client-debt-juan',
    section: 'clientes',
    message: 'Juan me debe 20 mil',
    expected: { types: ['add_debt'], matchPolicy: 'none', clientName: 'Juan', amount: 20000 },
  },
  {
    id: 'client-pay-juan',
    section: 'clientes',
    message: 'Juan me pagó 10 mil',
    expected: { types: ['payment_received'], matchPolicy: 'none', clientName: 'Juan', amount: 10000 },
  },
  {
    id: 'client-merge',
    section: 'clientes',
    message: 'Fusioná a Juan con Juan Pérez, son la misma persona',
    expected: { types: [], matchPolicy: 'none', unsupportedQuery: true },
  },
  {
    id: 'client-debt-query-maria',
    section: 'clientes',
    message: '¿Cuánto me debe María?',
    expected: { types: [], matchPolicy: 'none', unsupportedQuery: true },
  },
  {
    id: 'reserve-boca-juan',
    section: 'clientes',
    message: 'Reservame 1 camiseta de Boca para Juan',
    expected: { types: ['reserve_stock'], tokens: ['boca'], qty: 1, clientName: 'Juan', matchPolicy: 'confirm-multi' },
  },
  {
    id: 'proveedor-nuevo',
    section: 'clientes',
    message: 'Cargá un proveedor nuevo: Distribuidora Sur, notas: entrega los martes',
    expected: { types: [], matchPolicy: 'none', unsupportedQuery: true },
  },
  {
    id: 'kpi-negocio',
    section: 'consultas',
    message: '¿Cómo está el negocio hoy?',
    expected: { types: [], matchPolicy: 'none', unsupportedQuery: true },
  },
  {
    id: 'kpi-alertas',
    section: 'consultas',
    message: '¿Qué alertas de stock bajo tengo?',
    expected: { types: [], matchPolicy: 'none', unsupportedQuery: true },
  },
  {
    id: 'kpi-valor-inventario',
    section: 'consultas',
    message: '¿Cuál es el valor total del inventario?',
    expected: { types: [], matchPolicy: 'none', unsupportedQuery: true },
  },
  {
    id: 'kpi-actividad',
    section: 'consultas',
    message: 'Mostrame la actividad de hoy',
    expected: { types: [], matchPolicy: 'none', unsupportedQuery: true },
  },
  {
    id: 'idle-hola',
    section: 'transversal',
    message: 'Hola, buen día',
    expected: { types: [], matchPolicy: 'none', noAction: true },
  },
  {
    id: 'mixed-sell-and-load',
    section: 'transversal',
    message: 'Vendí una de Boca y me llegaron 5 de River nuevas',
    expected: {
      types: ['sell', 'add_stock'],
      tokenGroups: [['boca'], ['river']],
      qty: 1,
      minActions: 2,
      requireAllTypes: true,
      matchPolicy: 'confirm-multi',
    },
  },
  {
    id: 'panel-confirmar',
    section: 'transversal',
    message: 'confirmar',
    conversationTurns: sellArgentinaTurns(),
    expected: { types: [], matchPolicy: 'none', noAction: true },
  },
  {
    id: 'panel-cancelar',
    section: 'transversal',
    message: 'cancelar',
    conversationTurns: sellArgentinaTurns(),
    expected: { types: [], matchPolicy: 'none', noAction: true },
  },
  {
    id: 'correction-talle',
    section: 'transversal',
    message: 'no, era talle S, no M',
    conversationTurns: sellArgentinaTurns(),
    expected: { types: ['sell', 'update_product', 'add_stock'], tokens: ['argentina'], size: 'S', matchPolicy: 'sku' },
  },
  {
    id: 'slang-baja-river',
    section: 'transversal',
    message: 'dale de baja la de river total no la vendo mas',
    expected: { types: ['delete_product'], tokens: ['river'], matchPolicy: 'confirm-multi' },
  },
  {
    id: 'slang-chau-boca',
    section: 'transversal',
    message: 'chau esa de boca',
    expected: { types: ['delete_product'], tokens: ['boca'], matchPolicy: 'confirm-multi' },
  },
  {
    id: 'slang-mangos-mate',
    section: 'transversal',
    message: 'sacale un par de mangos al mate',
    expected: { types: ['update_product'], tokens: ['mate'], matchPolicy: 'sku' },
  },
  {
    id: 'audio-cut',
    section: 'transversal',
    message: 'vendí dos cami de bo talle ele, el audio se cor',
    expected: { types: ['sell'], tokens: ['boca'], size: 'L', qty: 2, matchPolicy: 'confirm-multi' },
  },
  {
    id: 'general-combo-no-size',
    section: 'transversal',
    message: 'cargá un combo cumpleaños',
    expected: { types: ['add_stock'], tokens: ['combo'], matchPolicy: 'sku', forbidSize: true },
  },
];

const tokensIn = (value, tokens) => {
  const hay = normalize(value);
  return (tokens || []).every((token) => hay.includes(normalize(token)));
};

const productHasTokens = (item, tokens) => tokensIn(productHaystack(item), tokens);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const productHasSize = (item, size) => {
  if (!size) {
    return true;
  }
  const wanted = normalize(size);
  const productSize = normalize(item.size || '');
  if (productSize && productSize === wanted) {
    return true;
  }
  const hay = ` ${productHaystack(item)} `;
  return new RegExp(`\\s${escapeRegex(wanted)}\\s`).test(hay);
};

const findCatalogMatches = (catalog, tokens, size) => {
  if (!tokens?.length) {
    return [];
  }
  const query = [...tokens, size].filter(Boolean).join(' ');
  return (catalog.products || [])
    .map((item) => ({ product: item, score: scoreProductAgainstQuery(item, query) }))
    .filter((entry) => entry.score >= 16 && productHasTokens(entry.product, tokens))
    .filter((entry) => productHasSize(entry.product, size))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.product);
};

const distinctModels = (products) => [...new Set(products.map((item) => modelKey(item)).filter(Boolean))];

const findBoundProduct = (action, catalog) => {
  const name = normalize(action?.productName);
  if (!name) {
    return null;
  }
  const exact = (catalog.products || []).find((item) => normalize(item.name) === name);
  if (exact) {
    return exact;
  }
  const ranked = (catalog.products || [])
    .map((item) => ({ product: item, score: scoreProductAgainstQuery(item, action.productName) }))
    .filter((entry) => entry.score >= 100)
    .sort((left, right) => right.score - left.score);
  return ranked[0]?.product ?? null;
};

const summarizeActions = (actions) =>
  (actions || []).map((action) => {
    const bits = [action.type, action.productName, action.size ? `var=${action.size}` : null, action.qty != null ? `qty=${action.qty}` : null, action.price != null ? `$${action.price}` : null, action.amount != null ? `monto=${action.amount}` : null, action.clientName ? `cli=${action.clientName}` : null, action.estado ? `estado=${action.estado}` : null, action.stockAvailable != null ? `stock=${action.stockAvailable}` : null];
    return bits.filter(Boolean).join(' · ');
  });

const shouldConfirm = (policy, matches) => {
  const models = distinctModels(matches);
  if (policy === 'confirm-multi') {
    return models.length > 1 || matches.length > 1;
  }
  if (policy === 'model-all') {
    return models.length > 1;
  }
  if (policy === 'sku') {
    return matches.length > 1 && models.length > 1;
  }
  return false;
};

const actionLooksLikeProductFamily = (action, tokens) => {
  if (!action?.productName) {
    return false;
  }
  return tokensIn(action.productName, tokens) || tokensIn([action.productType, action.productModel, action.size].filter(Boolean).join(' '), tokens);
};

const evaluateCase = (testCase, inventory, parsed) => {
  const expected = testCase.expected || {};
  const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
  const hold = hasProductMatchHold(parsed);
  const applied = summarizeActions(actions);
  const mutating = actions.filter((action) => MUTATING_TYPES.has(action.type));
  const wouldApplyOnWhatsApp = mutating.length > 0 && !hold;
  const tokenGroups = expected.tokenGroups || (expected.tokens?.length ? [expected.tokens] : []);
  const matches = tokenGroups.flatMap((tokens) => findCatalogMatches(inventory.catalog, tokens, expected.size));
  const bound = actions.map((action) => findBoundProduct(action, inventory.catalog)).filter(Boolean);
  const matchesAnyGroup = (item) => !tokenGroups.length || tokenGroups.some((tokens) => productHasTokens(item, tokens));
  const wrongBind = bound.filter((item) => tokenGroups.length && !matchesAnyGroup(item));
  const fieldIssues = [];

  const base = {
    hold,
    wouldApplyOnWhatsApp,
    appliedSkus: bound.map((item) => item.name),
    candidateSkus: [...new Set(matches.map((item) => item.name))],
    applied,
  };

  if (wrongBind.length && wouldApplyOnWhatsApp) {
    return {
      verdict: VERDICTS.false_positive,
      reason: `Aplicó al SKU equivocado sin preguntar: ${wrongBind.map((item) => item.name).join(', ')}. Familia esperada: ${tokenGroups.map((tokens) => tokens.join(' ')).join(' / ') || '—'}`,
      ...base,
    };
  }

  if (expected.size && wouldApplyOnWhatsApp) {
    const sizeMismatched = bound.filter((item) => {
      const productSize = normalize(item.size);
      return productSize && productSize !== normalize(expected.size);
    });
    if (sizeMismatched.length) {
      return {
        verdict: VERDICTS.false_positive,
        reason: `El usuario pidió variante ${expected.size} y aplicó ${sizeMismatched.map((item) => `${item.name} (${item.size})`).join(', ')} sin preguntar`,
        ...base,
      };
    }
  }

  if (expected.noAction) {
    if (!actions.length) {
      return { verdict: VERDICTS.correct_idle, reason: 'No disparó ninguna acción, como se esperaba', ...base };
    }
    if (mutating.length) {
      return {
        verdict: VERDICTS.false_positive,
        reason: `Mensaje sin pedido claro mutó inventario: ${applied.join(' | ')}`,
        ...base,
      };
    }
    return {
      verdict: VERDICTS.false_positive,
      reason: `Detectó acción (${applied.join(' | ')}) cuando no debía hacer nada`,
      ...base,
    };
  }

  if (expected.unsupportedQuery) {
    if (mutating.length && !hold) {
      return {
        verdict: VERDICTS.false_positive,
        reason: `Consulta/operación no soportada mutó inventario: ${applied.join(' | ')}`,
        ...base,
      };
    }
    if (!actions.length) {
      return { verdict: VERDICTS.missed, reason: 'No hay tipo de acción en el schema actual para esta operación', ...base };
    }
    return { verdict: VERDICTS.incorrect_fields, reason: `El schema no cubre esta operación y el parser devolvió: ${applied.join(' | ')}`, ...base };
  }

  if (!actions.length) {
    if (hold && !expected.noAction && !expected.unsupportedQuery) {
      return {
        verdict: VERDICTS.correct_confirm,
        reason: 'Hold de productMatch sin aplicar acciones (ambigüedad, no mutó)',
        ...base,
      };
    }
    return { verdict: VERDICTS.missed, reason: 'No se detectó ninguna acción debiendo detectarla', ...base };
  }

  const expectedTypes = expected.types || [];
  const actualTypes = actions.map((action) => action.type);
  if (expectedTypes.length) {
    const present = expected.requireAllTypes ? expectedTypes.every((type) => actualTypes.includes(type)) : expectedTypes.some((type) => actualTypes.includes(type));
    if (!present) {
      if (wouldApplyOnWhatsApp) {
        return {
          verdict: VERDICTS.false_positive,
          reason: `Tipo incorrecto y se aplicaría: obtuvo [${actualTypes.join(', ')}] vs [${expectedTypes.join(', ')}]`,
          ...base,
        };
      }
      return {
        verdict: VERDICTS.incorrect_fields,
        reason: `Tipo distinto: obtuvo [${actualTypes.join(', ')}] vs [${expectedTypes.join(', ')}]`,
        ...base,
      };
    }
  }

  if (expected.minActions && actions.length < expected.minActions) {
    fieldIssues.push(`esperaba ≥${expected.minActions} acciones, obtuvo ${actions.length}`);
  }

  if (expected.qty != null) {
    const qtyActions = actions.filter((action) => expectedTypes.includes(action.type) || PRODUCT_TYPES.has(action.type));
    if (qtyActions.length && !qtyActions.some((action) => Number(action.qty) === expected.qty)) {
      fieldIssues.push(`qty esperada ${expected.qty}, obtuvo ${qtyActions.map((action) => action.qty).join(', ')}`);
    }
  }

  if (expected.price != null) {
    const priced = actions.filter((action) => action.price != null);
    if (priced.length && !priced.some((action) => Number(action.price) === expected.price)) {
      fieldIssues.push(`precio esperado ${expected.price}, obtuvo ${priced.map((action) => action.price).join(', ')}`);
    }
  }

  if (expected.amount != null) {
    const withAmount = actions.filter((action) => action.amount != null);
    if (!withAmount.some((action) => Number(action.amount) === expected.amount)) {
      fieldIssues.push(`monto esperado ${expected.amount}, obtuvo ${withAmount.map((action) => action.amount).join(', ') || '—'}`);
    }
  }

  if (expected.stockAvailable != null) {
    const withStock = actions.filter((action) => action.stockAvailable != null);
    if (!withStock.some((action) => Number(action.stockAvailable) === expected.stockAvailable)) {
      fieldIssues.push(`stockAvailable esperado ${expected.stockAvailable}`);
    }
  }

  if (expected.estado) {
    const withEstado = actions.filter((action) => action.estado);
    if (withEstado.length && !withEstado.some((action) => normalize(action.estado) === normalize(expected.estado))) {
      fieldIssues.push(`estado esperado ${expected.estado}, obtuvo ${withEstado.map((action) => action.estado).join(', ')}`);
    }
  }

  if (expected.clientName) {
    const withClient = actions.filter((action) => action.clientName);
    if (withClient.length && !withClient.some((action) => normalize(action.clientName) === normalize(expected.clientName))) {
      fieldIssues.push(`cliente esperado ${expected.clientName}, obtuvo ${withClient.map((action) => action.clientName).join(', ')}`);
    }
  }

  if (expected.forbidSize && actions.some((action) => String(action.size || '').trim())) {
    fieldIssues.push(`forzó variante (${actions.map((action) => action.size).filter(Boolean).join(', ')}) en un producto sin dimensiones`);
  }

  if (expected.matchPolicy === 'confirm-client') {
    const named = actions.find((action) => action.clientName);
    if (named && !hold) {
      return {
        verdict: VERDICTS.false_positive,
        reason: `Asignó el pedido al cliente "${named.clientName}" sin preguntar, con cliente ambiguo ("el de siempre")`,
        ...base,
      };
    }
    if (hold || actions.some((action) => !action.clientName)) {
      return { verdict: VERDICTS.correct_confirm, reason: 'Pidió aclarar el cliente ambiguo', ...base, fieldIssues };
    }
  }

  if (tokenGroups.length) {
    const needsConfirm = tokenGroups.some((tokens) =>
      shouldConfirm(expected.matchPolicy, findCatalogMatches(inventory.catalog, tokens, expected.size)),
    );

    if (wrongBind.length && hold) {
      return {
        verdict: VERDICTS.correct_confirm,
        reason: `Ambigüedad/hold activo; candidatos ajenos mencionados: ${wrongBind.map((item) => item.name).join(', ')}`,
        ...base,
      };
    }

    if (needsConfirm) {
      if (hold) {
        return { verdict: VERDICTS.correct_confirm, reason: `Ambigüedad correcta. Candidatos: ${matches.map((item) => item.name).join(', ') || '—'}`, ...base, fieldIssues };
      }
      const silentlyPicked = bound.filter((item) => matchesAnyGroup(item));
      if (silentlyPicked.length && wouldApplyOnWhatsApp) {
        return {
          verdict: VERDICTS.false_positive,
          reason: `Había varios SKUs (${matches.map((item) => item.name).join(', ')}) y eligió ${silentlyPicked.map((item) => item.name).join(', ')} sin preguntar`,
          ...base,
        };
      }
      if (silentlyPicked.length === 1 && matches.length > 1) {
        return {
          verdict: VERDICTS.false_positive,
          reason: `Ató la consulta/acción a un solo SKU (${silentlyPicked[0].name}) con familia ambigua: ${matches.map((item) => item.name).join(', ')}`,
          ...base,
        };
      }
      if (mutating.length && !hold) {
        return {
          verdict: VERDICTS.false_positive,
          reason: `Catálogo ambiguo (${matches.map((item) => item.name).join(', ')}) y la mutación se aplicaría en WhatsApp sin preguntar: ${applied.join(' | ')}`,
          ...base,
        };
      }
    }

    const familyOk = actions.filter((action) => PRODUCT_TYPES.has(action.type)).every((action) => {
      const boundProduct = findBoundProduct(action, inventory.catalog);
      if (boundProduct) {
        return matchesAnyGroup(boundProduct);
      }
      return tokenGroups.some((tokens) => actionLooksLikeProductFamily(action, tokens));
    });

    if (!familyOk) {
      const names = actions.map((action) => action.productName).filter(Boolean).join(', ') || applied.join(' | ');
      const expectedFamily = tokenGroups.map((tokens) => tokens.join(' ')).join(' / ');
      if (wouldApplyOnWhatsApp) {
        return { verdict: VERDICTS.false_positive, reason: `El productName no corresponde a la familia esperada (${expectedFamily}): ${names}`, ...base };
      }
      return { verdict: VERDICTS.incorrect_fields, reason: `productName fuera de familia: ${names}`, ...base };
    }

    if (!needsConfirm && hold) {
      return { verdict: VERDICTS.over_ask, reason: 'Pidió confirmación aunque el match era único', ...base, fieldIssues };
    }
  }

  if (fieldIssues.length) {
    return { verdict: VERDICTS.incorrect_fields, reason: fieldIssues.join('; '), ...base, fieldIssues };
  }

  if (hold && expected.matchPolicy !== 'confirm-multi' && expected.matchPolicy !== 'confirm-client') {
    return { verdict: VERDICTS.over_ask, reason: 'Hold de productMatch con match no ambiguo', ...base };
  }

  return { verdict: VERDICTS.correct_direct, reason: 'Match/intención correcta sin hold de ambigüedad', ...base };
};

const pct = (count, total) => (total ? `${((count / total) * 100).toFixed(1)}%` : '0.0%');

const escapeCell = (value) =>
  String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();

const verdictLabel = (verdict) =>
  ({
    correct_direct: 'Match correcto (sin confirmación de ambigüedad)',
    correct_confirm: 'Confirmación por ambigüedad (correcta)',
    correct_idle: 'Sin acción, y no debía haberla',
    over_ask: 'Preguntó de más',
    incorrect_fields: 'Acción correcta a grandes rasgos, campos mal',
    false_positive: 'FALSO POSITIVO — SKU/acción incorrecta',
    missed: 'No detectó acción debiendo detectarla',
    error: 'Error al llamar al parser',
  })[verdict] || verdict;

const buildMarkdown = ({ mode, model, startedAt, finishedAt, results, totals, comparison }) => {
  const falsePositives = results.filter((row) => row.evaluation.verdict === VERDICTS.false_positive);
  const incorrect = results.filter((row) => row.evaluation.verdict === VERDICTS.incorrect_fields);
  const lines = [];
  lines.push('# Resultados del parser Stocky (robustez multi-rubro)');
  lines.push('');
  lines.push(`- Generado: ${finishedAt}`);
  lines.push(`- Duración: ${((new Date(finishedAt) - new Date(startedAt)) / 1000).toFixed(1)}s`);
  lines.push(`- Modo: **${mode}**`);
  lines.push(`- Modelo: ${model || 'n/a (parser local)'}`);
  lines.push(`- Casos corridos: **${totals.n}** (${inventories.length} inventarios × batería de prompts)`);
  lines.push('- Criterio: un falso positivo (aplicar al SKU equivocado sin preguntar) es más grave que preguntar de más.');
  lines.push('- La confirmación de ambigüedad se mide con `missingFields: ["productMatch"]` (hold de catálogo), no con el `requiresConfirmation` genérico del panel.');
  lines.push('');
  lines.push('## Resumen');
  lines.push('');
  lines.push('| Métrica | Cantidad | % |');
  lines.push('|---|---:|---:|');
  lines.push(`| Match correcto sin confirmación de ambigüedad | ${totals.correct_direct} | ${pct(totals.correct_direct, totals.n)} |`);
  lines.push(`| Confirmación por ambigüedad correcta | ${totals.correct_confirm} | ${pct(totals.correct_confirm, totals.n)} |`);
  lines.push(`| **Falsos positivos (SKU/acción incorrecta sin preguntar)** | **${totals.false_positive}** | **${pct(totals.false_positive, totals.n)}** |`);
  lines.push(`| No detectó ninguna acción debiendo detectarla | ${totals.missed} | ${pct(totals.missed, totals.n)} |`);
  lines.push(`| Preguntó de más (ambigüedad inexistente) | ${totals.over_ask} | ${pct(totals.over_ask, totals.n)} |`);
  lines.push(`| Acción detectada con campos incorrectos (qty/precio/tipo) | ${totals.incorrect_fields} | ${pct(totals.incorrect_fields, totals.n)} |`);
  lines.push(`| Sin acción esperada y no disparó (OK) | ${totals.correct_idle} | ${pct(totals.correct_idle, totals.n)} |`);
  lines.push(`| Error de parser | ${totals.error} | ${pct(totals.error, totals.n)} |`);
  lines.push('');

  if (comparison) {
    lines.push('## Comparación vs corrida anterior');
    lines.push('');
    lines.push(`- Baseline: ${comparison.previousMode} (${comparison.previousCount} falsos positivos)`);
    lines.push(`- Resueltos: **${comparison.resolved.length}** de ${comparison.previousCount}`);
    lines.push(`- Siguen fallando: **${comparison.still.length}**`);
    lines.push(`- Falsos positivos nuevos: **${comparison.novel.length}**`);
    lines.push('');
    if (comparison.resolved.length) {
      lines.push('### Resueltos');
      lines.push('');
      lines.push('| Inventario | Caso | Mensaje | Antes |');
      lines.push('|---|---|---|---|');
      for (const row of comparison.resolved) {
        lines.push(`| ${row.inventoryId} | ${row.caseId} | ${escapeCell(row.message)} | ${escapeCell(row.evaluation.reason)} |`);
      }
      lines.push('');
    }
    if (comparison.still.length) {
      lines.push('### Siguen siendo falsos positivos');
      lines.push('');
      lines.push('| Inventario | Caso | Mensaje | Ahora |');
      lines.push('|---|---|---|---|');
      for (const row of comparison.still) {
        lines.push(`| ${row.inventoryId} | ${row.caseId} | ${escapeCell(row.message)} | ${escapeCell(row.evaluation.reason)} |`);
      }
      lines.push('');
    }
    if (comparison.novel.length) {
      lines.push('### Falsos positivos nuevos (no estaban en la corrida anterior)');
      lines.push('');
      lines.push('| Inventario | Caso | Mensaje | Por qué |');
      lines.push('|---|---|---|---|');
      for (const row of comparison.novel) {
        lines.push(`| ${row.inventoryId} | ${row.caseId} | ${escapeCell(row.message)} | ${escapeCell(row.evaluation.reason)} |`);
      }
      lines.push('');
    } else {
      lines.push('_No aparecieron falsos positivos nuevos._');
      lines.push('');
    }
  }

  lines.push('## Falsos positivos (todos)');
  lines.push('');
  if (!falsePositives.length) {
    lines.push('_No se registraron falsos positivos en esta corrida._');
    lines.push('');
  } else {
    lines.push('| # | Inventario | Caso | Mensaje | SKU aplicado | Por qué está mal | WhatsApp aplicaría |');
    lines.push('|---:|---|---|---|---|---|---|');
    falsePositives.forEach((row, index) => {
      lines.push(
        `| ${index + 1} | ${row.inventoryId} | ${row.caseId} | ${escapeCell(row.message)} | ${escapeCell((row.evaluation.appliedSkus || []).join(', ') || row.evaluation.applied.join(' · '))} | ${escapeCell(row.evaluation.reason)} | ${row.evaluation.wouldApplyOnWhatsApp ? 'SÍ' : 'no'} |`,
      );
    });
    lines.push('');
    falsePositives.forEach((row, index) => {
      lines.push(`### FP ${index + 1}. ${row.inventoryId} / ${row.caseId}`);
      lines.push('');
      lines.push(`- Mensaje: "${row.message}"`);
      lines.push(`- Candidatos reales en catálogo: ${(row.evaluation.candidateSkus || []).join(', ') || 'ninguno'}`);
      lines.push(`- SKUs a los que ató: ${(row.evaluation.appliedSkus || []).join(', ') || 'ninguno (nombre libre)'}`);
      lines.push(`- Hold productMatch: ${row.evaluation.hold ? 'sí' : 'no'}`);
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(row.parsed, null, 2));
      lines.push('```');
      lines.push('');
    });
  }

  if (incorrect.length) {
    lines.push('## Acciones aplicadas incorrectamente (campos)');
    lines.push('');
    lines.push('| Inventario | Caso | Mensaje | Detalle | Salida |');
    lines.push('|---|---|---|---|---|');
    for (const row of incorrect) {
      lines.push(`| ${row.inventoryId} | ${row.caseId} | ${escapeCell(row.message)} | ${escapeCell(row.evaluation.reason)} | ${escapeCell(row.evaluation.applied.join(' · '))} |`);
    }
    lines.push('');
  }

  lines.push('## Por inventario');
  lines.push('');
  for (const inventory of inventories) {
    const rows = results.filter((row) => row.inventoryId === inventory.id);
    if (!rows.length) {
      continue;
    }
    const fp = rows.filter((row) => row.evaluation.verdict === VERDICTS.false_positive).length;
    lines.push(`### ${inventory.label} (\`${inventory.id}\`) — ${rows.length} casos, ${fp} falsos positivos`);
    lines.push('');
    lines.push('| Caso | Sección | Mensaje | Veredicto | Acciones | Hold |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of rows) {
      lines.push(
        `| ${row.caseId} | ${row.section} | ${escapeCell(row.message)} | ${verdictLabel(row.evaluation.verdict)} | ${escapeCell(row.evaluation.applied.join(' · ') || '—')} | ${row.evaluation.hold ? 'sí' : 'no'} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Detalle por caso');
  lines.push('');
  for (const row of results) {
    lines.push(`### ${row.inventoryId} · ${row.caseId}`);
    lines.push('');
    lines.push(`- Sección: ${row.section}`);
    lines.push(`- Mensaje: "${row.message}"`);
    lines.push(`- Inventario: ${row.inventoryLabel} (${(row.catalogNames || []).join(', ')})`);
    lines.push(`- Veredicto: **${verdictLabel(row.evaluation.verdict)}**`);
    lines.push(`- Motivo: ${row.evaluation.reason}`);
    lines.push(`- WhatsApp aplicaría la mutación: ${row.evaluation.wouldApplyOnWhatsApp ? 'sí' : 'no'}`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(row.parsed, null, 2));
    lines.push('```');
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
};

const parseArgsInventory = () => {
  if (!CATEGORY_FILTER.size) {
    return inventories;
  }
  return inventories.filter((inventory) => CATEGORY_FILTER.has(inventory.id));
};

const parseArgsCases = () => {
  let selected = testCases;
  if (SECTION_FILTER.size) {
    selected = selected.filter((item) => SECTION_FILTER.has(item.section));
  }
  if (ID_FILTER.size) {
    selected = selected.filter((item) => ID_FILTER.has(item.id));
  }
  return selected;
};

const callParser = async (text, inventory, conversationTurns) => {
  if (USE_LOCAL) {
    return parseLocalText(text, conversationTurns, inventory.catalog);
  }
  return parseVoiceText(text, {
    businessCategory: inventory.id,
    catalog: inventory.catalog,
    conversationTurns,
  });
};

const main = async () => {
  const selectedInventories = parseArgsInventory();
  const selectedCases = parseArgsCases();
  const hasKey = Boolean(process.env.VITE_VOICE_MODEL_API_KEY);
  const mode = USE_LOCAL ? 'local (parseLocalText, sin Groq)' : hasKey ? 'LLM real (parseVoiceText / Groq Llama)' : 'local fallback (no hay VITE_VOICE_MODEL_API_KEY)';
  const model = USE_LOCAL || !hasKey ? null : process.env.VITE_VOICE_MODEL_NAME || 'openai/gpt-oss-20b';

  if (!USE_LOCAL && !hasKey) {
    console.warn('[test-parser] No hay VITE_VOICE_MODEL_API_KEY. Se usa el parser local, no el modelo.');
  }

  let planned = selectedInventories.length * selectedCases.length;
  if (LIMIT > 0) {
    planned = Math.min(planned, LIMIT);
  }

  console.log(`[test-parser] ${planned} corridas · modo=${mode}${DELAY_MS ? ` · delay ${DELAY_MS}ms` : ''}`);
  console.log(`[test-parser] salida: ${OUT_MD}`);

  const startedAt = new Date().toISOString();
  const results = [];
  let index = 0;

  outer: for (const inventory of selectedInventories) {
    for (const testCase of selectedCases) {
      if (LIMIT > 0 && index >= LIMIT) {
        break outer;
      }
      index += 1;
      const prefix = `[${index}/${planned}] ${inventory.id} / ${testCase.id}`;
      process.stdout.write(`${prefix} … `);
      const t0 = Date.now();
      let parsed = null;
      let evaluation;
      try {
        parsed = await callParser(testCase.message, inventory, testCase.conversationTurns || []);
        evaluation = evaluateCase(testCase, inventory, parsed);
      } catch (error) {
        evaluation = {
          verdict: VERDICTS.error,
          reason: error instanceof Error ? error.message : String(error),
          hold: false,
          wouldApplyOnWhatsApp: false,
          appliedSkus: [],
          candidateSkus: [],
          applied: [],
        };
      }
      console.log(`${evaluation.verdict} (${Date.now() - t0}ms)`);
      results.push({
        inventoryId: inventory.id,
        inventoryLabel: inventory.label,
        catalogNames: inventory.catalog.products.map((item) => item.name),
        caseId: testCase.id,
        section: testCase.section,
        message: testCase.message,
        expected: testCase.expected,
        parsed: parsed ?? { intent: 'unknown', actions: [], sourceText: testCase.message },
        evaluation,
      });
      if (DELAY_MS && !(USE_LOCAL || !hasKey)) {
        await sleep(DELAY_MS);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const totals = {
    n: results.length,
    correct_direct: 0,
    correct_confirm: 0,
    correct_idle: 0,
    over_ask: 0,
    incorrect_fields: 0,
    false_positive: 0,
    missed: 0,
    error: 0,
  };
  for (const row of results) {
    totals[row.evaluation.verdict] = (totals[row.evaluation.verdict] || 0) + 1;
  }

  const previous = loadPreviousResults();
  const comparison = previous ? compareFalsePositives(previous, results) : null;
  const markdown = buildMarkdown({ mode, model, startedAt, finishedAt, results, totals, comparison });
  fs.writeFileSync(OUT_MD, markdown, 'utf8');
  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify({ mode, model, startedAt, finishedAt, totals, results }, null, 2),
    'utf8',
  );

  console.log('');
  console.log(`[test-parser] listo. ${totals.n} casos.`);
  console.log(`  match correcto:     ${totals.correct_direct} (${pct(totals.correct_direct, totals.n)})`);
  console.log(`  confirmación OK:    ${totals.correct_confirm} (${pct(totals.correct_confirm, totals.n)})`);
  console.log(`  FALSOS POSITIVOS:   ${totals.false_positive} (${pct(totals.false_positive, totals.n)})`);
  console.log(`  no detectó acción:  ${totals.missed} (${pct(totals.missed, totals.n)})`);
  console.log(`  preguntó de más:    ${totals.over_ask} (${pct(totals.over_ask, totals.n)})`);
  console.log(`  campos incorrectos: ${totals.incorrect_fields} (${pct(totals.incorrect_fields, totals.n)})`);
  console.log(`  markdown: ${OUT_MD}`);
  console.log(`  json:     ${OUT_JSON}`);
  if (comparison) {
    console.log(`  vs baseline: resueltos ${comparison.resolved.length}/${comparison.previousCount} · siguen ${comparison.still.length} · nuevos ${comparison.novel.length}`);
  }
};

main().catch((error) => {
  console.error('[test-parser] falló:', error);
  process.exit(1);
});
