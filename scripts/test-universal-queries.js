import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareUniversalQueries, authorizeUniversalQueries } from '../server/universalQueries.js';
import { InventoryOperationError } from '../server/inventoryOperations.js';

const context = { businessId: 'tenant-a', actorId: 'actor-a', permissions: ['inventory:read', 'orders:read', 'accounts:read'], sourceText: 'Mostrame inventario, pedidos y cuentas.' };
const catalog = () => ({
  products: [
    { id: 'z-private', name: 'Cable', unit: 'm', stockAvailable: 5, stockReserved: 2, price: 19, priceCurrency: 'UYU', size: 'largo', attributes: { flexible: { state: 'known', type: 'boolean', value: false }, potencia: { state: 'known', type: 'number', value: 0 } }, family: { id: 'electrico', version: 2 } },
    { id: 'a-private', name: 'Conector', unit: 'box', stockAvailable: 0, stockReserved: 0, price: 0 },
  ],
  clients: [{ id: 'c-private', name: 'Ana', debt: 0 }, { id: 'd-private', name: 'Luis', debt: 28 }],
  proveedores: [{ id: 's-private', name: 'Suministros' }],
  pedidos: [
    { id: 'o2-private', producto: 'Cable', talle: 'largo', qty: 4, estado: 'conseguido', clienteId: 'c-private', proveedorId: 's-private', productId: 'z-private', stockPosting: { skuId: 'z-private', quantity: 4, unit: 'm' } },
    { id: 'o1-private', producto: 'Conector', qty: 3, estado: 'pendiente', clienteId: 'd-private', proveedorId: null, stockPosting: null },
  ],
});
const plan = (type = 'inventory.query', extra = {}) => ({ contractVersion: 1, kind: 'query', queries: [{ itemId: 'q1', type, selector: { kind: 'all' }, ...extra }], evidence: [{ itemId: 'q1', quote: 'Mostrame' }] });
const run = (input = plan(), data = catalog(), auth = context) => prepareUniversalQueries(input, data, auth);
const rejects = callback => assert.throws(callback, error => error instanceof InventoryOperationError);

test('inventory copies exact facts, preserves zero/false and family, sorts stable IDs and groups unlike units', () => {
  const data = catalog(), result = run(plan(), data), item = result.answer.items[0];
  assert.deepEqual(item.rows.map(row => row.id), ['a-private', 'z-private']);
  assert.equal(item.rows[0].price, 0);
  assert.equal(item.rows[1].attributes.flexible.value, false);
  assert.equal(item.rows[1].attributes.potencia.value, 0);
  assert.deepEqual(item.rows[1].family, { id: 'electrico', version: 2 });
  assert.deepEqual(item.summary.totals, [{ unit: 'box', available: 0, reserved: 0 }, { unit: 'm', available: 5, reserved: 2 }]);
  assert.match(result.answer.text, /Cable.*largo.*false.*0/);
  assert.doesNotMatch(result.answer.text, /private|electrico/);
  data.products[0].stockAvailable = 100;
  assert.equal(item.rows[1].stockAvailable, 5);
  assert.throws(() => { item.rows[1].attributes.flexible.value = true; }, TypeError);
  assert.throws(() => { result.queries.push({}); }, TypeError);
  assert.equal(JSON.parse(JSON.stringify(result)).answer.items[0].rows[1].stockAvailable, 5);
});

test('accounts compute exact safe totals, including zero balance', () => {
  const result = run(plan('accounts.query'));
  assert.deepEqual(result.answer.items[0].summary, { count: 2, totalDebt: 28 });
  assert.match(result.answer.text, /Ana: saldo 0/);
  assert.match(result.answer.text, /Saldo total: 28/);
});

test('orders resolve actual names and variant, status is explicit and posting is snapshot only', () => {
  const result = run(plan('orders.query', { estado: 'conseguido' }));
  assert.equal(result.answer.items[0].rows.length, 1);
  assert.deepEqual(result.answer.items[0].rows[0].stockPosting, { skuId: 'z-private', quantity: 4, unit: 'm' });
  assert.match(result.answer.text, /Cable \(largo\): 4; conseguido; cliente Ana; proveedor Suministros/);
  assert.doesNotMatch(result.answer.text, /private/);
  assert.equal(run(plan('orders.query')).answer.items[0].rows.length, 1);
  assert.equal(run(plan('orders.query')).queries[0].estado, 'pendiente');
  assert.equal(run(plan('orders.query', { estado: 'todos' })).answer.items[0].rows.length, 2);
  assert.equal(run(plan('orders.query', { estado: 'pendiente' })).answer.items[0].rows[0].id, 'o1-private');
});

test('persisted queries are reauthorized with current scope and permissions without source/catalog', () => {
  const queries = run(plan()).queries;
  const { sourceText, ...auth } = context;
  assert.deepEqual(authorizeUniversalQueries(queries, auth), queries);
  assert.throws(() => authorizeUniversalQueries(queries, { ...auth, permissions: [] }), { code: 'FORBIDDEN' });
  assert.throws(() => authorizeUniversalQueries(queries, { ...auth, actorId: '' }), { code: 'BUSINESS_SCOPE_REQUIRED' });
  rejects(() => authorizeUniversalQueries([queries[0], queries[0]], auth));
});

test('empty ID selectors return no matches, never fall back to all/name lookup', () => {
  for (const type of ['inventory.query', 'orders.query', 'accounts.query']) {
    const result = run(plan(type, { selector: { kind: 'ids', ids: [] } }));
    assert.deepEqual(result.answer.items[0].rows, []);
    assert.match(result.answer.text, /^No encontré/);
    rejects(() => run(plan(type, { selector: { kind: 'ids', ids: ['Cable'] } })));
  }
});

test('permissions are checked before any catalog getter can run; no write permission substitutes read', () => {
  for (const [type, permissions] of [['inventory.query', ['inventory:receive']], ['orders.query', ['orders:create']], ['accounts.query', ['accounts:charge']]]) {
    let read = false;
    const data = { get products() { read = true; throw new Error('should not read'); } };
    assert.throws(() => run(plan(type), data, { ...context, permissions }), { code: 'FORBIDDEN' });
    assert.equal(read, false);
  }
});

test('rejects authority, write fields and malformed closed selectors at every model level', () => {
  for (const mutate of [
    value => { value.businessId = 'tenant-a'; }, value => { value.actions = []; }, value => { value.source = context.sourceText; },
    value => { value.queries[0].quantity = 3; }, value => { value.queries[0].type = 'stock.receive'; },
    value => { value.queries[0].selector.actorId = 'actor-a'; }, value => { value.queries[0].selector.ids = []; },
    value => { value.queries[0].selector = { kind: 'name', name: 'Cable' }; },
    value => { value.evidence[0].permissions = []; }, value => { value.queries[0].estado = 'todos'; },
  ]) { const value = plan(); mutate(value); rejects(() => run(value)); }
});

test('literal evidence must cover every unique query exactly once', () => {
  for (const change of [value => { value.evidence = []; }, value => { value.evidence.push({ ...value.evidence[0] }); }, value => { value.evidence[0].quote = 'inventario inventado'; }, value => { value.evidence[0].itemId = 'unknown'; }, value => { value.queries.push({ ...value.queries[0] }); }]) {
    const value = plan(); change(value); rejects(() => run(value));
  }
  const value = plan();
  value.queries.push({ itemId: 'q2', type: 'accounts.query', selector: { kind: 'all' } });
  value.evidence.push({ itemId: 'q2', quote: 'cuentas' });
  assert.equal(run(value).answer.items.length, 2);
});

test('rejects wrong/cross-tenant IDs, repeated catalog/selector IDs and missing scope', () => {
  for (const change of [data => { data.products[0].businessId = 'tenant-b'; }, data => { data.products.push({ ...data.products[0] }); }]) {
    const data = catalog(); change(data); rejects(() => run(plan(), data));
  }
  rejects(() => run(plan('inventory.query', { selector: { kind: 'ids', ids: ['z-private', 'z-private'] } })));
  rejects(() => run(plan('accounts.query', { selector: { kind: 'ids', ids: ['z-private'] } })));
  for (const patch of [{ businessId: '' }, { businessId: '__default__' }, { actorId: '' }, { sourceText: '' }, { sourceText: 'x'.repeat(12001) }]) rejects(() => run(plan(), catalog(), { ...context, ...patch }));
  for (const field of ['clienteId', 'proveedorId']) {
    const data = catalog(); data.pedidos[0][field] = 'foreign'; rejects(() => run(plan('orders.query'), data));
  }
});

test('historical orders preserve archived SKU references absent from the active catalog', () => {
  const data = catalog();
  data.products = [];
  data.pedidos[0].productId = 'archived-private';
  data.pedidos[0].stockPosting.skuId = 'archived-private';
  const before = structuredClone(data);
  const result = run(plan('orders.query', { estado: 'conseguido' }), data);
  const row = result.answer.items[0].rows[0];
  assert.equal(row.productId, 'archived-private');
  assert.deepEqual(row.stockPosting, { skuId: 'archived-private', quantity: 4, unit: 'm' });
  assert.equal(row.qty, 4);
  assert.equal(row.estado, 'conseguido');
  assert.match(result.answer.text, /Cable \(largo\): 4; conseguido/);
  assert.doesNotMatch(result.answer.text, /archived-private/);
  assert.deepEqual(data, before);
  assert.ok(Object.isFrozen(row.stockPosting));
  rejects(() => run(plan('inventory.query', { selector: { kind: 'ids', ids: ['archived-private'] } }), data));
});

test('unknown attributes retain their explicit unit in rendered variants', () => {
  const data = catalog();
  data.products[0].attributes.voltaje = { state: 'unknown', type: 'number', unit: 'v' };
  const result = run(plan(), data);
  assert.match(result.answer.text, /voltaje: desconocido v/);
  assert.deepEqual(result.answer.items[0].rows[1].attributes.voltaje, { state: 'unknown', type: 'number', unit: 'v' });
});

test('rejects invalid/missing numeric facts and safe-integer overflow', () => {
  for (const value of [undefined, -1, 1.5, NaN, Infinity, '0', Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of ['stockAvailable', 'stockReserved', 'price']) { const data = catalog(); if (value === undefined) delete data.products[0][key]; else data.products[0][key] = value; rejects(() => run(plan(), data)); }
    const data = catalog(); data.clients[0].debt = value; rejects(() => run(plan('accounts.query'), data));
  }
  const data = catalog(); data.clients[0].debt = Number.MAX_SAFE_INTEGER;
  rejects(() => run(plan('accounts.query'), data));
  const stocks = catalog(); stocks.products[0].stockAvailable = Number.MAX_SAFE_INTEGER; stocks.products[1].unit = 'm'; stocks.products[1].stockAvailable = 1;
  rejects(() => run(plan(), stocks));
  const orders = catalog(); orders.pedidos[0].qty = -1; rejects(() => run(plan('orders.query'), orders));
});

test('rejects prototypes, getters, sparse/extra arrays and limits without invoking accessors', () => {
  let read = false;
  const value = plan(); Object.defineProperty(value.queries[0], 'selector', { enumerable: true, get() { read = true; } });
  rejects(() => run(value)); assert.equal(read, false);
  const sparse = plan(); sparse.queries = new Array(1); rejects(() => run(sparse));
  const extra = plan(); extra.queries.extra = true; rejects(() => run(extra));
  const inherited = plan(); Object.setPrototypeOf(inherited.queries[0], { actorId: 'forged' }); rejects(() => run(inherited));
  const hidden = plan(); Object.defineProperty(hidden, 'actorId', { value: 'forged' }); rejects(() => run(hidden));
  const tooMany = plan(); tooMany.queries = Array.from({ length: 21 }, (_, i) => ({ ...tooMany.queries[0], itemId: `q${i}` })); rejects(() => run(tooMany));
  const data = catalog(); data.products = Array.from({ length: 1001 }, (_, i) => ({ ...data.products[0], id: `p${i}` })); rejects(() => run(plan(), data));
});

test('returns every matched row without silently truncating answers', () => {
  const data = catalog(); data.clients = Array.from({ length: 200 }, (_, i) => ({ id: `c${i.toString().padStart(3, '0')}`, name: `Persona ${i}`, debt: i })); data.pedidos = [];
  const result = run(plan('accounts.query'), data);
  assert.equal(result.answer.items[0].rows.length, 200);
  assert.equal(result.answer.items[0].summary.totalDebt, 19900);
  assert.match(result.answer.text, /Persona 199: saldo 199/);
});
