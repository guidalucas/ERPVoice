import { createHash } from 'node:crypto';
import { canonicalIdentityText, normalizeAttributes, normalizeUnit, skuIdentityKey } from './inventoryDomain.js';

export class InventoryOperationError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'InventoryOperationError'; this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new InventoryOperationError(code, message, details); };
const invalid = (message) => fail('INVALID_OPERATION_PLAN', message);
const own = (value, key) => Object.hasOwn(value, key);
function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain record`);
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || (allowed && !allowed.includes(key))) invalid(`Unsupported ${label} field: ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !own(descriptor, 'value') || descriptor.value === undefined) invalid(`${label}.${key} must be an enumerable defined data property`);
    result[key] = descriptor.value;
  }
  return result;
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} must be a nonempty string`);
  return value;
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) invalid(`${label} must be a safe integer >= ${minimum}`);
  return value;
}
function domain(fn) {
  try { return fn(); } catch (error) { if (error.code === 'INVALID_INVENTORY_DOMAIN') invalid(error.message); throw error; }
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function normalizeSku(input) {
  const sku = record(input, ['name', 'productType', 'productModel', 'size', 'attributes', 'unit'], 'SKU');
  const result = { name: text(sku.name, 'SKU.name') };
  for (const field of ['productType', 'productModel', 'size']) {
    if (own(sku, field)) { if (typeof sku[field] !== 'string') invalid(`SKU.${field} must be a string`); result[field] = sku[field]; }
  }
  result.attributes = domain(() => normalizeAttributes(own(sku, 'attributes') ? sku.attributes : {}));
  result.unit = domain(() => normalizeUnit(own(sku, 'unit') ? sku.unit : 'unit'));
  productIdentity(result);
  return result;
}
function catalogPrice(input, policies) {
  const price = record(input, ['amount', 'currency', 'policy'], 'price');
  if (typeof price.currency !== 'string' || !/^[A-Z]{3}$/.test(price.currency)) invalid('price.currency must be three uppercase letters');
  if (!policies.includes(price.policy)) invalid('Invalid price policy');
  return { amount: integer(price.amount, 'price.amount'), currency: price.currency, policy: price.policy };
}
function normalizePlan(input) {
  const plan = record(input, ['contractVersion', 'operationId', 'businessId', 'actions', 'source'], 'plan');
  if (plan.contractVersion !== 1) invalid('contractVersion must be 1');
  const result = { contractVersion: 1, operationId: text(plan.operationId, 'operationId'), businessId: text(plan.businessId, 'businessId') };
  if (result.businessId === '__default__') fail('BUSINESS_SCOPE_REQUIRED', 'Explicit business scope is required');
  const actions = plan.actions;
  if (!Array.isArray(actions) || Object.getPrototypeOf(actions) !== Array.prototype || actions.length < 1 || actions.length > 100) invalid('actions must contain 1 to 100 actions');
  if (Reflect.ownKeys(actions).length !== actions.length + 1) invalid('actions must be a dense array without extra fields');
  const itemIds = new Set();
  result.actions = Array.from({ length: actions.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(actions, String(index));
    if (!descriptor || !own(descriptor, 'value')) invalid('actions must contain data properties');
    const action = record(descriptor.value, ['itemId', 'type', 'target', 'quantity', 'price', 'salePrice', 'balances', 'changes', 'reason', 'initialStock'], 'action');
    if (!['stock.receive', 'stock.sell', 'stock.reserve', 'stock.withdraw', 'stock.adjust', 'sku.update', 'sku.deactivate', 'sku.create'].includes(action.type)) fail('UNSUPPORTED_OPERATION', `Unsupported operation: ${String(action.type)}`);
    const updating = ['stock.adjust', 'sku.update', 'sku.deactivate'].includes(action.type);
    const itemId = text(action.itemId, 'itemId');
    if (itemIds.has(itemId)) invalid('Duplicate itemId');
    itemIds.add(itemId);
    const target = record(action.target, ['kind', 'skuId', 'expectedFingerprint', 'expectedRevision', 'sku'], 'target');
    let normalizedTarget;
    if (target.kind === 'existing') {
      if (action.type === 'sku.create') invalid('SKU creation requires a new target');
      if (own(target, 'sku')) invalid('Existing target cannot include sku');
      normalizedTarget = { kind: 'existing', skuId: text(target.skuId, 'skuId') };
      if (own(target, 'expectedFingerprint')) normalizedTarget.expectedFingerprint = text(target.expectedFingerprint, 'expectedFingerprint');
      if (own(target, 'expectedRevision')) normalizedTarget.expectedRevision = integer(target.expectedRevision, 'expectedRevision');
    } else if (target.kind === 'new') {
      if (!['stock.receive', 'sku.create'].includes(action.type)) invalid('This operation requires an existing SKU');
      if (own(target, 'skuId') || own(target, 'expectedFingerprint') || own(target, 'expectedRevision')) invalid('New target cannot include existing SKU fields');
      normalizedTarget = { kind: 'new', sku: normalizeSku(target.sku) };
    } else invalid('Unsupported target kind');
    if (action.type === 'sku.create') {
      if (['quantity', 'salePrice', 'balances', 'changes'].some((key) => own(action, key))) invalid('SKU creation cannot include mutation fields from other operations');
      const initial = record(action.initialStock, ['available', 'reserved'], 'initialStock');
      return { itemId, type: action.type, target: normalizedTarget,
        initialStock: { available: integer(initial.available, 'initialStock.available'), reserved: integer(initial.reserved, 'initialStock.reserved') },
        reason: text(action.reason, 'reason'),
        ...(own(action, 'price') ? { price: catalogPrice(action.price, ['initialize']) } : {}),
      };
    }
    if (own(action, 'initialStock')) invalid('Only SKU creation can include initialStock');
    if (updating) {
      if (!own(normalizedTarget, 'expectedRevision')) invalid('Updates require expectedRevision');
      if (own(action, 'quantity') || own(action, 'price') || own(action, 'salePrice')) invalid('Updates cannot include receipt/sale quantities or prices');
      const normalized = { itemId, type: action.type, target: normalizedTarget, reason: text(action.reason, 'reason') };
      if (action.type === 'sku.deactivate') {
        if (own(action, 'balances') || own(action, 'changes')) invalid('Deactivation cannot include inventory or metadata changes');
        return normalized;
      }
      if (action.type === 'stock.adjust') {
        if (own(action, 'changes')) invalid('Adjustments cannot include SKU changes');
        const balances = record(action.balances, ['available', 'reserved'], 'balances');
        if (!Object.keys(balances).length) invalid('Adjustment requires at least one balance');
        normalized.balances = Object.fromEntries(Object.entries(balances).map(([key, value]) => [key, integer(value, `balances.${key}`)]));
      } else {
        if (own(action, 'balances')) invalid('SKU updates cannot include balances');
        const changes = record(action.changes, ['name', 'productType', 'productModel', 'size', 'attributes', 'price', 'priceCurrency'], 'changes');
        if (!Object.keys(changes).length) invalid('SKU update requires at least one change');
        normalized.changes = {};
        for (const [key, value] of Object.entries(changes)) {
          if (key === 'name') normalized.changes[key] = text(value, 'changes.name');
          else if (key === 'price') normalized.changes[key] = integer(value, 'changes.price');
          else if (key === 'priceCurrency') {
            if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) invalid('changes.priceCurrency must be three uppercase letters');
            normalized.changes[key] = value;
          } else if (key === 'attributes') normalized.changes[key] = domain(() => normalizeAttributes(value));
          else {
            if (value !== null && typeof value !== 'string') invalid(`changes.${key} must be a string or null`);
            normalized.changes[key] = value;
          }
        }
      }
      return normalized;
    }
    if (own(action, 'balances') || own(action, 'changes') || (own(action, 'reason') && action.type !== 'stock.withdraw')) invalid('Unexpected update fields on stock operation');
    const quantity = record(action.quantity, ['value', 'unit'], 'quantity');
    const normalized = { itemId, type: action.type, target: normalizedTarget, quantity: { value: integer(quantity.value, 'quantity.value', 1), unit: domain(() => normalizeUnit(text(quantity.unit, 'quantity.unit'))) } };
    if (action.type === 'stock.withdraw') {
      if (own(action, 'price') || own(action, 'salePrice')) invalid('Withdrawal cannot include prices');
      normalized.reason = text(action.reason, 'reason');
    }
    if (own(action, 'price')) {
      if (action.type !== 'stock.receive') invalid('Catalog price policies are only valid for receipts');
      normalized.price = catalogPrice(action.price, ['initialize', 'set', 'preserve']);
    }
    if (own(action, 'salePrice')) {
      if (action.type === 'stock.receive') invalid('Sale price cannot initialize catalog price');
      const price = record(action.salePrice, ['amount', 'currency'], 'salePrice');
      if (typeof price.currency !== 'string' || !/^[A-Z]{3}$/.test(price.currency)) invalid('salePrice.currency must be three uppercase letters');
      normalized.salePrice = { amount: integer(price.amount, 'salePrice.amount'), currency: price.currency };
    }
    return normalized;
  });
  if (own(plan, 'source')) {
    const source = record(plan.source, ['channel', 'text', 'messageId', 'requestHash'], 'source');
    result.source = { channel: text(source.channel, 'source.channel') };
    for (const field of ['text', 'messageId', 'requestHash']) {
      if (own(source, field)) { if (typeof source[field] !== 'string') invalid(`source.${field} must be a string`); result.source[field] = source[field]; }
    }
  }
  return freeze(result);
}

export function validateOperationPlan(plan, context) {
  if (!context || typeof context.businessId !== 'string' || !context.businessId.trim() || context.businessId === '__default__' || typeof context.actorId !== 'string' || !context.actorId.trim()) fail('BUSINESS_SCOPE_REQUIRED', 'Explicit business and actor context is required');
  if (!(Array.isArray(context.permissions) || context.permissions instanceof Set)) fail('FORBIDDEN', 'Inventory permissions are required');
  const normalized = normalizePlan(plan);
  if (normalized.operationId.startsWith('universal-child:') && !context.internalUniversalOperation) fail('FORBIDDEN','Universal child operation IDs are reserved for the universal executor');
  if (normalized.operationId.startsWith('order-stock:') && !context.internalOrderOperation) fail('FORBIDDEN', 'Order inventory operation IDs are reserved for the order executor');
  if (normalized.businessId !== context.businessId) fail('BUSINESS_SCOPE_MISMATCH', 'Operation business differs from authenticated business');
  for (const action of normalized.actions) {
    const permission = { 'stock.receive': 'inventory:receive', 'stock.sell': 'inventory:sell', 'stock.reserve': 'inventory:reserve', 'stock.withdraw': 'inventory:withdraw', 'stock.adjust': 'inventory:adjust', 'sku.update': 'inventory:update', 'sku.deactivate': 'inventory:deactivate', 'sku.create': 'inventory:create' }[action.type];
    if (![...context.permissions].includes(permission)) fail('FORBIDDEN', `${permission} permission is required`);
    if (action.type === 'sku.create' && action.initialStock.reserved > 0 && ![...context.permissions].includes('inventory:reserve')) fail('FORBIDDEN', 'inventory:reserve permission is required for initial reservations');
  }
  return normalized;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const hash = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export function operationDigest(plan) {
  const { source, ...semanticPlan } = normalizePlan(plan);
  return hash(semanticPlan);
}
export function productIdentity(product) {
  const attributes = { ...domain(() => normalizeAttributes(product.attributes ?? {})) };
  if (product.size != null && product.size !== '') {
    if (typeof product.size !== 'string') invalid('Legacy size must be a string');
    const size = { state: 'known', type: 'text', value: canonicalIdentityText(product.size) };
    if (own(attributes, 'size') && JSON.stringify(attributes.size) !== JSON.stringify(size)) fail('SKU_IDENTITY_CONFLICT', 'Legacy size conflicts with attributes.size');
    attributes.size = size;
  }
  const name = text(product.name, 'product.name');
  const metadata = ['productType', 'productModel'].map((field) => {
    const value = product[field] ?? '';
    if (typeof value !== 'string') invalid(`${field} must be a string`);
    return canonicalIdentityText(value);
  });
  return domain(() => skuIdentityKey({ name: JSON.stringify([canonicalIdentityText(name), ...metadata]), attributes, unit: product.unit ?? 'unit' }));
}
export function inventoryProductFingerprint(product) {
  return hash({ identity: productIdentity(product), status: product.status ?? 'active' });
}

export function planInventoryOperation(input, products, { createId } = {}) {
  const plan = normalizePlan(input);
  if (!Array.isArray(products)) invalid('products must be an array');
  const byId = new Map();
  for (const row of products) {
    const product = record(row, null, 'product');
    const id = text(product.id, 'product.id');
    if (byId.has(id)) invalid('Duplicate product ID');
    const clone = { ...product, attributes: JSON.parse(JSON.stringify(domain(() => normalizeAttributes(product.attributes ?? {})))) };
    productIdentity(clone);
    byId.set(id, clone);
  }
  const changed = new Map();
  // Preconditions refer to the reviewed snapshot, before any item in this plan.
  const originalFingerprints = new Map([...byId].map(([id, product]) => [id, inventoryProductFingerprint(product)]));
  const items = [], movements = [];
  for (const action of plan.actions) {
    let product, created = false;
    if (action.target.kind === 'existing') {
      product = byId.get(action.target.skuId);
      if (!product) fail('SKU_NOT_FOUND', 'Target SKU was not found', { skuId: action.target.skuId });
      if (own(action.target, 'expectedRevision') && action.target.expectedRevision !== (product.revision ?? 0)) fail('REVISION_MISMATCH', 'El SKU cambió desde su lectura. Actualizá el inventario y revisá el ajuste.', { skuId: product.id, expected: action.target.expectedRevision, actual: product.revision ?? 0 });
      if (action.target.expectedFingerprint && (originalFingerprints.get(product.id) ?? inventoryProductFingerprint(product)) !== action.target.expectedFingerprint) fail('SKU_FINGERPRINT_MISMATCH', 'Target SKU identity changed');
    } else {
      const identity = productIdentity(action.target.sku);
      const identical = [...byId.values()].filter((entry) => productIdentity(entry) === identity);
      if (action.type === 'sku.create' && identical.some((entry) => (entry.status ?? 'active') !== 'active')) fail('SKU_INACTIVE', 'Ya existe un SKU desactivado con esa identidad; no creé otro producto.');
      if (identical.length) fail('DUPLICATE_SKU_IDENTITY', 'An identical SKU already exists');
      if (typeof createId !== 'function') invalid('createId is required for new SKUs');
      const id = text(createId(), 'created SKU ID');
      if (byId.has(id)) fail('DUPLICATE_SKU_ID', 'Generated SKU ID already exists');
      product = { ...action.target.sku, attributes: JSON.parse(JSON.stringify(action.target.sku.attributes)), id, status: 'active', stockAvailable: 0, stockReserved: 0, price: 0, priceCurrency: 'XXX' };
      byId.set(id, product); created = true;
    }
    if ((product.status ?? 'active') !== 'active') fail('SKU_INACTIVE', 'Cannot mutate stock for an inactive SKU');
    const unit = domain(() => normalizeUnit(product.unit ?? 'unit'));
    if (action.type === 'sku.create') {
      Object.assign(product, { stockAvailable: action.initialStock.available, stockReserved: action.initialStock.reserved,
        price: action.price?.amount ?? 0, priceCurrency: action.price?.currency ?? 'XXX', revision: 0 });
      changed.set(product.id, product);
      items.push({ itemId: action.itemId, type: action.type, skuId: product.id, status: 'active', reason: action.reason,
        initialStock: { ...action.initialStock }, stockAvailable: product.stockAvailable, stockReserved: product.stockReserved,
        price: product.price, currency: product.priceCurrency, unit, created: true });
      movements.push({ itemId: action.itemId, skuId: product.id, deltaAvailable: product.stockAvailable, deltaReserved: product.stockReserved, unit });
      continue;
    }
    if (action.type === 'sku.deactivate') {
      const available = integer(product.stockAvailable ?? 0, 'stockAvailable');
      const reserved = integer(product.stockReserved ?? 0, 'stockReserved');
      if (reserved > 0) fail('SKU_HAS_RESERVATIONS', 'El SKU tiene unidades reservadas. Resolvé las reservas antes de darlo de baja.', { skuId: product.id, reserved });
      const price = integer(product.price ?? 0, 'product.price'), currency = product.priceCurrency ?? 'XXX';
      if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) invalid('Invalid stored currency');
      Object.assign(product, { status: 'inactive', stockAvailable: available, stockReserved: reserved, price, priceCurrency: currency });
      changed.set(product.id, product);
      items.push({ itemId: action.itemId, type: action.type, skuId: product.id, status: 'inactive', reason: action.reason,
        stockAvailable: available, stockReserved: reserved, price, currency,
        deltaAvailable: 0, deltaReserved: 0, unit, created: false });
      movements.push({ itemId: action.itemId, skuId: product.id, deltaAvailable: 0, deltaReserved: 0, unit });
      continue;
    }
    if (action.type === 'stock.adjust' || action.type === 'sku.update') {
      const beforeAvailable = integer(product.stockAvailable ?? 0, 'stockAvailable');
      const beforeReserved = integer(product.stockReserved ?? 0, 'stockReserved');
      const next = { ...product, stockAvailable: beforeAvailable, stockReserved: beforeReserved,
        price: integer(product.price ?? 0, 'product.price'), priceCurrency: product.priceCurrency ?? 'XXX' };
      if (action.type === 'stock.adjust') {
        next.stockAvailable = action.balances.available ?? beforeAvailable;
        next.stockReserved = action.balances.reserved ?? beforeReserved;
      } else {
        Object.assign(next, action.changes);
        const identity = productIdentity(next);
        if (identity !== productIdentity(product) && [...byId.values()].some((entry) => entry.id !== product.id && productIdentity(entry) === identity)) fail('DUPLICATE_SKU_IDENTITY', 'An identical SKU already exists');
      }
      Object.assign(product, next);
      if (!/^[A-Z]{3}$/.test(product.priceCurrency)) invalid('Invalid stored currency');
      changed.set(product.id, product);
      const deltaAvailable = product.stockAvailable - beforeAvailable, deltaReserved = product.stockReserved - beforeReserved;
      items.push({ itemId: action.itemId, type: action.type, skuId: product.id, reason: action.reason,
        stockAvailable: product.stockAvailable, stockReserved: product.stockReserved, price: product.price, currency: product.priceCurrency ?? 'XXX',
        ...(action.balances ? { balances: { ...action.balances } } : { changes: JSON.parse(JSON.stringify(action.changes)) }),
        deltaAvailable, deltaReserved, unit, created: false });
      movements.push({ itemId: action.itemId, skuId: product.id, deltaAvailable, deltaReserved, unit });
      continue;
    }
    if (unit !== action.quantity.unit) fail('UNIT_MISMATCH', 'Operation unit differs from SKU unit');
    const available = integer(product.stockAvailable ?? 0, 'stockAvailable');
    const reserved = integer(product.stockReserved ?? 0, 'stockReserved');
    const quantity = action.quantity.value;
    const receiving = action.type === 'stock.receive';
    const reserving = action.type === 'stock.reserve';
    if (!receiving && available < quantity) fail('INSUFFICIENT_STOCK', 'Stock disponible insuficiente; no apliqué el lote.',
      { skuId: product.id, requested: quantity, available });
    const nextAvailable = receiving ? available + quantity : available - quantity;
    const nextReserved = reserving ? reserved + quantity : reserved;
    if (!Number.isSafeInteger(nextAvailable) || !Number.isSafeInteger(nextReserved)) fail('STOCK_OVERFLOW', 'Operation exceeds safe stock range');
    let price = integer(product.price ?? 0, 'product.price');
    let currency = product.priceCurrency ?? 'XXX';
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) invalid('Invalid stored currency');
    if (action.price) {
      const requested = action.price;
      if (currency !== 'XXX' && currency !== requested.currency) fail('CURRENCY_CONFLICT', 'Receipt currency differs from stored currency');
      if (requested.policy === 'initialize' && price !== 0 && price !== requested.amount) fail('PRICE_CONFLICT', 'Existing SKU price differs from requested initialization');
      if (requested.policy === 'set' || (requested.policy === 'initialize' && price === 0)) { price = requested.amount; currency = requested.currency; }
    }
    const totalAmount = action.salePrice ? action.salePrice.amount * quantity : null;
    if (totalAmount !== null && !Number.isSafeInteger(totalAmount)) fail('MONEY_OVERFLOW', 'Sale value exceeds safe money range');
    Object.assign(product, { stockAvailable: nextAvailable, stockReserved: nextReserved, price, priceCurrency: currency });
    changed.set(product.id, product);
    if (action.type === 'stock.withdraw') {
      items.push({ itemId: action.itemId, type: action.type, skuId: product.id, quantity: { ...action.quantity },
        reason: action.reason, stockAvailable: nextAvailable, stockReserved: nextReserved, unit, created: false });
      movements.push({ itemId: action.itemId, skuId: product.id, deltaAvailable: -quantity, deltaReserved: 0, unit });
      continue;
    }
    items.push({ itemId: action.itemId, type: action.type, skuId: product.id, quantity: { ...action.quantity },
      stockAvailable: nextAvailable, stockReserved: nextReserved,
      price: receiving ? price : action.salePrice?.amount ?? null, currency: receiving ? currency : action.salePrice?.currency ?? null, created,
      ...(!receiving ? { catalogPrice: price, catalogCurrency: currency, totalAmount } : {}) });
    movements.push({ itemId: action.itemId, skuId: product.id, deltaAvailable: receiving ? quantity : -quantity, deltaReserved: reserving ? quantity : 0, unit });
  }
  return { changedProducts: [...changed.values()], items, movements };
}

// Compatibility name; receipts, sales and reservations share the same planner.
export const planInventoryReceipt = planInventoryOperation;
