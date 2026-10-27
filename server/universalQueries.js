import { InventoryOperationError } from './inventoryOperations.js';
import { normalizeAttributes, normalizeUnit } from './inventoryDomain.js';
import { normalizeFamilyReference } from './productFamilySchemas.js';
import { validateMoneyPolicy } from './inventoryMoneyPolicy.js';

// Pure snapshot reader. Neither selectors nor model output can supply facts,
// authority, writes, fuzzy matching, or a second catalog lookup.
const fail = (code, message) => { throw new InventoryOperationError(code, message); };
const invalid = (message = 'La consulta contiene datos inválidos.') => fail('INVALID_QUERY', message);
const own = (value, key) => Object.hasOwn(value, key);
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const record = (value, allowed) => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || unsafe.has(key) || (allowed && !allowed.includes(key)) || !descriptor.enumerable || !own(descriptor, 'value') || descriptor.value === undefined) invalid();
    result[key] = descriptor.value;
  }
  return result;
};
const array = (value, max = 1000) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value') || descriptor.value === undefined) invalid();
    return descriptor.value;
  });
};
const text = (value, max = 12000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid();
  return value;
};
const integer = value => {
  if (!Number.isSafeInteger(value) || value < 0) invalid('Los saldos, cantidades y precios deben ser enteros seguros no negativos.');
  return Object.is(value, -0) ? 0 : value;
};
const add = (left, right) => integer(left + right);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const domain = callback => {
  try { return callback(); } catch (error) {
    if (error.code === 'INVALID_INVENTORY_DOMAIN' || error.name === 'ProductFamilySchemaError') invalid(error.message);
    throw error;
  }
};
const copyJson = input => {
  let nodes = 0;
  const copy = (value, depth = 0) => {
    if (++nodes > 30000 || depth > 15) invalid('El catálogo es demasiado grande.');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { if (value.length > 200000) invalid(); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return array(value).map(entry => copy(entry, depth + 1));
    return Object.fromEntries(Object.entries(record(value)).map(([key, entry]) => [key, copy(entry, depth + 1)]));
  };
  return copy(input);
};
const types = { 'inventory.query': ['products', 'inventory:read'], 'orders.query': ['pedidos', 'orders:read'], 'accounts.query': ['clients', 'accounts:read'] };
const states = ['pendiente', 'conseguido', 'descartado'];
const orderIds = (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
const optionalText = (row, output, key) => {
  if (own(row, key) && row[key] !== null) {
    if (typeof row[key] !== 'string') invalid();
    output[key] = row[key];
  }
};
const metadata = (row, output, sizeKey = 'size') => {
  for (const key of ['productType', 'productModel', sizeKey]) optionalText(row, output, key);
  if (own(row, 'attributes')) output.attributes = domain(() => normalizeAttributes(row.attributes));
  if (own(row, 'family') && row.family !== null) output.family = domain(() => normalizeFamilyReference(row.family));
};
const variant = row => {
  const parts = [row.productType, row.productModel, row.size ?? row.talle].filter(value => typeof value === 'string' && value.trim());
  for (const [key, attribute] of Object.entries(row.attributes ?? {})) {
    if (attribute.state === 'known') parts.push(`${key}: ${String(attribute.value)}${attribute.unit ? ` ${attribute.unit}` : ''}`);
    else parts.push(`${key}: ${{ unknown: 'desconocido', not_applicable: 'no aplica', missing: 'sin dato' }[attribute.state]}${attribute.unit ? ` ${attribute.unit}` : ''}`);
  }
  return parts.length ? ` (${parts.join(' · ')})` : '';
};

/** Model contract: {contractVersion:1,kind:'query',queries,evidence}.
 * context.sourceText is supplied only by the backend. Catalogs are already
 * scoped by that backend; explicit row businessId, when present, must match.
 * All returned data is copied, validated, and recursively frozen.
 */
export function authorizeUniversalQueries(input, context) {
  const auth = record(context);
  if (typeof auth.businessId !== 'string' || !auth.businessId.trim() || auth.businessId === '__default__' || typeof auth.actorId !== 'string' || !auth.actorId.trim()) fail('BUSINESS_SCOPE_REQUIRED', 'Falta el negocio y actor autorizado.');
  if (!(Array.isArray(auth.permissions) || auth.permissions instanceof Set)) fail('FORBIDDEN', 'Faltan permisos de consulta.');
  const permissions = auth.permissions instanceof Set ? [...Set.prototype.values.call(auth.permissions)] : array(auth.permissions);
  if (permissions.some(permission => typeof permission !== 'string')) fail('FORBIDDEN', 'Permisos inválidos.');
  const itemIds = new Set();
  const queries = array(input, 20).map(value => {
    const query = record(value, ['itemId', 'type', 'selector', 'estado']);
    const itemId = text(query.itemId, 180);
    if (itemIds.has(itemId) || typeof query.type !== 'string' || !own(types, query.type)) invalid();
    itemIds.add(itemId);
    if (!permissions.includes(types[query.type][1])) fail('FORBIDDEN', `Falta el permiso ${types[query.type][1]}.`);
    const selector = record(query.selector, ['kind', 'ids']);
    let normalizedSelector;
    if (selector.kind === 'all' && !own(selector, 'ids')) normalizedSelector = { kind: 'all' };
    else if (selector.kind === 'ids') {
      const ids = array(selector.ids).map(value => text(value, 180));
      if (new Set(ids).size !== ids.length) invalid('IDs repetidos.');
      normalizedSelector = { kind: 'ids', ids: [...ids].sort() };
    } else invalid();
    const normalized = { itemId, type: query.type, selector: normalizedSelector };
    if (own(query, 'estado')) {
      if (query.type !== 'orders.query' || ![...states, 'todos'].includes(query.estado)) invalid();
      normalized.estado = query.estado;
    } else if (query.type === 'orders.query') normalized.estado = 'pendiente';
    return normalized;
  });
  if (!queries.length) invalid();
  return freeze(queries);
}

export function prepareUniversalQueries(input, catalog, context) {
  const model = record(input, ['contractVersion', 'kind', 'queries', 'evidence']);
  if (model.contractVersion !== 1 || model.kind !== 'query') invalid();
  const queries = authorizeUniversalQueries(model.queries, context);
  const auth = record(context), sourceText = text(auth.sourceText, 12000);
  const itemIds = new Set(queries.map(query => query.itemId));
  const evidenceMap = new Map();
  for (const value of array(model.evidence, 20)) {
    const evidence = record(value, ['itemId', 'quote']);
    if (!itemIds.has(evidence.itemId) || evidenceMap.has(evidence.itemId) || !sourceText.includes(text(evidence.quote))) fail('INVALID_EVIDENCE', 'Cada consulta requiere una cita literal del mensaje.');
    evidenceMap.set(evidence.itemId, { itemId: evidence.itemId, quote: evidence.quote });
  }
  if (evidenceMap.size !== queries.length) fail('INVALID_EVIDENCE', 'Falta evidencia de una consulta.');

  // Permission checks above finish before touching any catalog data.
  const snapshot = record(copyJson(catalog), ['products', 'pedidos', 'clients', 'proveedores', 'familySchemas', 'moneyPolicy']);
  if (JSON.stringify(snapshot).length > 200000) invalid('El catálogo es demasiado grande.');
  // Backend configuration can accompany the snapshot; row facts remain the
  // source of query amounts and currencies, without conversions or defaults.
  if (own(snapshot, 'moneyPolicy')) validateMoneyPolicy(snapshot.moneyPolicy);
  const maps = {};
  let count = own(snapshot, 'familySchemas') ? array(snapshot.familySchemas).length : 0;
  for (const name of ['products', 'pedidos', 'clients', 'proveedores']) {
    maps[name] = new Map();
    for (const value of array(own(snapshot, name) ? snapshot[name] : [])) {
      if (++count > 1000) invalid('El catálogo supera 1000 filas.');
      const row = record(value);
      const id = text(row.id, 180);
      if (maps[name].has(id)) invalid('El catálogo contiene IDs repetidos.');
      if (own(row, 'businessId') && row.businessId !== auth.businessId) fail('BUSINESS_SCOPE_MISMATCH', 'El catálogo pertenece a otro negocio.');
      maps[name].set(id, row);
    }
  }
  const resolveParty = (value, name) => {
    if (value === null || value === undefined) return null;
    const id = text(value, 180), party = maps[name].get(id);
    if (!party) invalid('El pedido referencia una persona fuera del catálogo autorizado.');
    return { id, name: text(party.name) };
  };
  const items = queries.map(query => {
    const map = maps[types[query.type][0]];
    const selected = query.selector.kind === 'all' ? [...map.values()] : query.selector.ids.map(id => {
      const row = map.get(id);
      if (!row) invalid('El ID no fue ofrecido en el catálogo autorizado.');
      return row;
    });
    const rows = selected.map(row => {
      if (query.type === 'inventory.query') {
        const output = { id: row.id, name: text(row.name), unit: domain(() => normalizeUnit(row.unit)), stockAvailable: integer(row.stockAvailable), stockReserved: integer(row.stockReserved), price: integer(row.price) };
        if (own(row, 'priceCurrency')) {
          if (typeof row.priceCurrency !== 'string' || !/^[A-Z]{3}$/.test(row.priceCurrency)) invalid();
          output.priceCurrency = row.priceCurrency;
        }
        metadata(row, output);
        return output;
      }
      if (query.type === 'accounts.query') return { id: row.id, name: text(row.name), debt: integer(row.debt) };
      if (!states.includes(row.estado)) invalid();
      const output = { id: row.id, producto: text(row.producto), qty: integer(row.qty), estado: row.estado, client: resolveParty(row.clienteId, 'clients'), supplier: resolveParty(row.proveedorId, 'proveedores') };
      metadata(row, output, 'talle');
      if (own(row, 'unit')) output.unit = domain(() => normalizeUnit(row.unit));
      if (own(row, 'productId') && row.productId !== null) {
        // Scoped historical orders may reference archived SKUs omitted from the
        // active product catalog. These captured references grant no authority.
        output.productId = text(row.productId, 180);
      }
      if (own(row, 'stockPosting')) {
        if (row.stockPosting === null) output.stockPosting = null;
        else {
          const posting = record(row.stockPosting, ['skuId', 'quantity', 'unit']);
          output.stockPosting = { skuId: text(posting.skuId, 180), quantity: integer(posting.quantity), unit: domain(() => normalizeUnit(posting.unit)) };
        }
      }
      return output;
    }).filter(row => query.type !== 'orders.query' || !query.estado || query.estado === 'todos' || row.estado === query.estado).sort(orderIds);
    const summary = { count: rows.length };
    if (query.type === 'accounts.query') summary.totalDebt = rows.reduce((sum, row) => add(sum, row.debt), 0);
    // Quantities with different units are deliberately not added together.
    if (query.type !== 'accounts.query') {
      const totals = new Map();
      for (const row of rows) {
        const unit = row.unit ?? null;
        const total = totals.get(unit) ?? (query.type === 'inventory.query' ? { unit, available: 0, reserved: 0 } : { unit, quantity: 0 });
        if (query.type === 'inventory.query') { total.available = add(total.available, row.stockAvailable); total.reserved = add(total.reserved, row.stockReserved); }
        else total.quantity = add(total.quantity, row.qty);
        totals.set(unit, total);
      }
      summary.totals = [...totals.values()].sort((a, b) => String(a.unit).localeCompare(String(b.unit)));
    }
    return { itemId: query.itemId, type: query.type, rows, summary };
  });
  const sections = items.map(item => {
    if (!item.rows.length) return `No encontré ${{ 'inventory.query': 'productos', 'orders.query': 'pedidos', 'accounts.query': 'cuentas' }[item.type]} para esta consulta.`;
    if (item.type === 'inventory.query') return `Inventario (${item.rows.length}):\n${item.rows.map(row => `• ${row.name}${variant(row)}: ${row.stockAvailable} ${row.unit} disponibles, ${row.stockReserved} ${row.unit} reservadas; precio ${row.price}${row.priceCurrency ? ` ${row.priceCurrency}` : ''}.`).join('\n')}`;
    if (item.type === 'accounts.query') return `Cuentas (${item.rows.length}):\n${item.rows.map(row => `• ${row.name}: saldo ${row.debt}.`).join('\n')}\nSaldo total: ${item.summary.totalDebt}.`;
    return `Pedidos (${item.rows.length}):\n${item.rows.map(row => `• ${row.producto}${variant(row)}: ${row.qty}${row.unit ? ` ${row.unit}` : ''}; ${row.estado}; cliente ${row.client?.name ?? 'sin cliente'}${row.supplier ? `; proveedor ${row.supplier.name}` : ''}.`).join('\n')}`;
  });
  return freeze({ queries, evidence: queries.map(query => evidenceMap.get(query.itemId)), answer: { text: sections.join('\n\n'), items } });
}
