import { normalizeFamilyPublication } from '../../server/productFamilySchemas.js';

// Sintéticos públicos para evaluación semántica del intérprete universal.
// Correr: node scripts/evaluate-universal-corpus.js --live [--out ruta.json]
// Sin --live o sin una API key, la CLI debe terminar con código 2.
// --self-test valida el comparador con salidas simuladas; nunca mide calidad live.
const family = normalizeFamilyPublication({
  operationId: 'fixture-family-publication',
  familyId: 'sensor',
  expectedVersion: 0,
  schema: {
    name: 'Sensor',
    unit: 'unit',
    attributes: {
      habilitado: { type: 'boolean', required: true },
      rango: { type: 'number', required: true, unit: 'unit' },
    },
  },
});

const product = (id, name, extra = {}) => ({
  id, name, unit: 'unit', status: 'active', stockAvailable: 8, stockReserved: 0,
  price: 100, priceCurrency: 'UYU', revision: 4, ...extra,
});
const client = { id: 'client-1', name: 'Cliente Sintético', debt: 0, accountRevision: 2, metadataRevision: 3 };
const supplier = { id: 'supplier-1', name: 'Proveedor Sintético', metadataRevision: 1 };
const order = { id: 'order-1', clienteId: client.id, proveedorId: supplier.id, producto: 'Sensor Uno',
  productType: 'Sensor', productModel: 'A1', talle: null, qty: 2, estado: 'pendiente', notas: '',
  productId: 'sensor-uno', revision: 5, stockPosting: null };

const context = {
  businessId: 'public-evaluation-business',
  actorId: 'public-evaluation-actor',
  permissions: [
    'inventory:receive', 'inventory:sell', 'inventory:update', 'inventory:deactivate',
    'accounts:charge', 'orders:update',
  ],
};
const readContext = { ...context, permissions: ['inventory:read', 'orders:read', 'accounts:read'] };

export const universalIntentCorpus = [
  {
    id: 'explicit-directional-converters-two-skus',
    sourceText: 'Vendé 3 convertidores USB a HDMI y 2 convertidores HDMI a USB.',
    catalog: { products: [product('usb-hdmi', 'Convertidor USB a HDMI'), product('hdmi-usb', 'Convertidor HDMI a USB')] },
    context,
    expected: {
      kind: 'ready',
      actions: [
        { type: 'stock.sell', skuId: 'usb-hdmi', quantity: { value: 3, unit: 'unit' } },
        { type: 'stock.sell', skuId: 'hdmi-usb', quantity: { value: 2, unit: 'unit' } },
      ],
    },
  },
  {
    id: 'ambiguous-product-needs-clarification',
    sourceText: 'Cargá 3 unidades de la remera negra.',
    catalog: { products: [product('shirt-v1', 'Remera negra algodón'), product('shirt-v2', 'Remera negra deportiva')] },
    context,
    expected: { kind: 'clarification' },
  },
  {
    id: 'stock-income-and-customer-account-charge',
    sourceText: 'Ingresá 5 unidades de Sensor Uno, reemplazá su precio de catálogo por 250 pesos uruguayos cada una y cargá 120 pesos a la cuenta de Cliente Sintético por envío.',
    catalog: { products: [product('sensor-uno', 'Sensor Uno')], clients: [client] },
    context: { ...context, permissions: [...context.permissions, 'accounts:charge'] },
    expected: {
      kind: 'ready',
      actions: [
        { type: 'stock.receive', skuId: 'sensor-uno', quantity: { value: 5, unit: 'unit' }, price: { amount: 250, currency: 'UYU', policy: 'set' } },
        { type: 'account.charge', clientId: 'client-1', amount: { value: 120, unit: 'legacy-money' }, reasonAnyOf: ['envío', 'entrega'] },
      ],
    },
  },
  {
    id: 'update-existing-order-quantity',
    sourceText: 'En el pedido existente de Cliente Sintético para Sensor Uno, dejá la cantidad en 7.',
    catalog: { products: [product('sensor-uno', 'Sensor Uno')], clients: [client], proveedores: [supplier], pedidos: [order] },
    context: { ...context, permissions: [...context.permissions, 'orders:update'] },
    expected: {
      kind: 'ready',
      actions: [{ type: 'order.update', pedidoId: 'order-1', changes: { qty: 7 } }],
    },
  },
  {
    id: 'new-family-sku-required-false-and-zero',
    sourceText: 'Ingresá 2 unidades de un nuevo SKU llamado Sensor de prueba con familia sensor: habilitado falso y rango cero.',
    catalog: { products: [], familySchemas: [{ familyId: 'sensor', version: 1, schema: family.schema }] },
    context,
    expected: {
      kind: 'ready',
      actions: [{
        type: 'stock.receive',
        newSku: { name: 'Sensor de prueba', unit: 'unit', family: { id: 'sensor', version: 1 }, attributes: {
          habilitado: { state: 'known', type: 'boolean', value: false },
          rango: { state: 'known', type: 'number', value: 0, unit: 'unit' },
        } },
        quantity: { value: 2, unit: 'unit' },
      }],
    },
  },
  {
    id: 'explicit-zero-price-update',
    sourceText: 'Actualizá el precio de Sensor Uno a cero pesos uruguayos; es una decisión comercial.',
    catalog: { products: [product('sensor-uno', 'Sensor Uno')] },
    context,
    expected: {
      kind: 'ready',
      actions: [{ type: 'sku.update', skuId: 'sensor-uno', reasonAnyOf: ['decisión comercial', 'criterio comercial'], changes: { price: 0, priceCurrency: 'UYU' } }],
    },
  },
  {
    id: 'fabricated-reference-must-not-become-ready',
    sourceText: 'Vendé 4 unidades del SKU fantasma-999.',
    catalog: { products: [product('sensor-uno', 'Sensor Uno')] },
    context,
    // El proveedor puede preguntar o el backend puede rechazar una referencia inventada.
    // La condición dorada es que no se emita ningún plan listo para ejecución.
    expected: { kind: 'no_ready_plan' },
  },
  {
    id: 'query-inventory-mixed-units-zero-false-attribute',
    sourceText: '¿Qué inventario tenemos?',
    catalog: { products: [
      product('inventory-unit', 'Sensor habilitado', { unit: 'unit', stockAvailable: 0, stockReserved: 0, attributes: { habilitado: { state: 'known', type: 'boolean', value: false } } }),
      product('inventory-kg', 'Polvo', { unit: 'kg', stockAvailable: 3, stockReserved: 1, price: 0 }),
    ] },
    context: readContext,
    expected: {
      kind: 'answer',
      queries: [{ type: 'inventory.query', selector: { kind: 'all' } }],
      answerItems: [{ type: 'inventory.query', rows: [
        { id: 'inventory-kg', name: 'Polvo', unit: 'kg', stockAvailable: 3, stockReserved: 1, price: 0, priceCurrency: 'UYU' },
        { id: 'inventory-unit', name: 'Sensor habilitado', unit: 'unit', stockAvailable: 0, stockReserved: 0, price: 100, priceCurrency: 'UYU', attributes: { habilitado: { state: 'known', type: 'boolean', value: false } } },
      ], summary: { count: 2, totals: [
        { unit: 'kg', available: 3, reserved: 1 }, { unit: 'unit', available: 0, reserved: 0 },
      ] } }],
    },
  },
  {
    id: 'query-pending-orders-default-vs-explicit-todos',
    sourceText: 'Mostrame los pedidos pendientes y todos los pedidos.',
    catalog: { clients: [client], proveedores: [supplier], pedidos: [
      order,
      { ...order, id: 'order-2', estado: 'conseguido', qty: 4 },
    ] },
    context: readContext,
    expected: {
      kind: 'answer',
      queries: [
        { type: 'orders.query', selector: { kind: 'all' }, estado: 'pendiente' },
        { type: 'orders.query', selector: { kind: 'all' }, estado: 'todos' },
      ],
      answerItems: [
        { type: 'orders.query', rows: [
          { id: 'order-1', producto: 'Sensor Uno', qty: 2, estado: 'pendiente', client: { id: 'client-1', name: 'Cliente Sintético' }, supplier: { id: 'supplier-1', name: 'Proveedor Sintético' }, productType: 'Sensor', productModel: 'A1', productId: 'sensor-uno', stockPosting: null },
        ], summary: { count: 1, totals: [{ unit: null, quantity: 2 }] } },
        { type: 'orders.query', rows: [
          { id: 'order-1', producto: 'Sensor Uno', qty: 2, estado: 'pendiente', client: { id: 'client-1', name: 'Cliente Sintético' }, supplier: { id: 'supplier-1', name: 'Proveedor Sintético' }, productType: 'Sensor', productModel: 'A1', productId: 'sensor-uno', stockPosting: null },
          { id: 'order-2', producto: 'Sensor Uno', qty: 4, estado: 'conseguido', client: { id: 'client-1', name: 'Cliente Sintético' }, supplier: { id: 'supplier-1', name: 'Proveedor Sintético' }, productType: 'Sensor', productModel: 'A1', productId: 'sensor-uno', stockPosting: null },
        ], summary: { count: 2, totals: [{ unit: null, quantity: 6 }] } },
      ],
    },
  },
  {
    id: 'query-accounts-zero-balance',
    sourceText: '¿Cuánto debe Cliente Sintético?',
    catalog: { clients: [client] },
    context: readContext,
    expected: {
      kind: 'answer',
      queries: [{ type: 'accounts.query', selector: { kind: 'ids', ids: ['client-1'] } }],
      answerItems: [{ type: 'accounts.query', rows: [{ id: 'client-1', name: 'Cliente Sintético', debt: 0 }], summary: { count: 1, totalDebt: 0 } }],
    },
  },
];

for (const fixture of universalIntentCorpus) {
  fixture.catalog = { products: [], clients: [], proveedores: [], pedidos: [], ...fixture.catalog };
}

export const universalEvaluationDefaults = { channel: 'universal-evaluation', operationIdPrefix: 'public-corpus' };
