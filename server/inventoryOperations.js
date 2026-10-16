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
    const action = record(descriptor.value, ['itemId', 'type', 'target', 'quantity', 'price'], 'action');
    if (action.type !== 'stock.receive') fail('UNSUPPORTED_OPERATION', `Unsupported operation: ${String(action.type)}`);
    const itemId = text(action.itemId, 'itemId');
    if (itemIds.has(itemId)) invalid('Duplicate itemId');
    itemIds.add(itemId);
    const target = record(action.target, ['kind', 'skuId', 'expectedFingerprint', 'sku'], 'target');
    let normalizedTarget;
    if (target.kind === 'existing') {
      if (own(target, 'sku')) invalid('Existing target cannot include sku');
      normalizedTarget = { kind: 'existing', skuId: text(target.skuId, 'skuId') };
      if (own(target, 'expectedFingerprint')) normalizedTarget.expectedFingerprint = text(target.expectedFingerprint, 'expectedFingerprint');
    } else if (target.kind === 'new') {
      if (own(target, 'skuId') || own(target, 'expectedFingerprint')) invalid('New target cannot include existing SKU fields');
      normalizedTarget = { kind: 'new', sku: normalizeSku(target.sku) };
    } else invalid('Unsupported target kind');
    const quantity = record(action.quantity, ['value', 'unit'], 'quantity');
    const normalized = { itemId, type: 'stock.receive', target: normalizedTarget, quantity: { value: integer(quantity.value, 'quantity.value', 1), unit: domain(() => normalizeUnit(text(quantity.unit, 'quantity.unit'))) } };
    if (own(action, 'price')) {
      const price = record(action.price, ['amount', 'currency', 'policy'], 'price');
      if (typeof price.currency !== 'string' || !/^[A-Z]{3}$/.test(price.currency)) invalid('price.currency must be three uppercase letters');
      if (!['initialize', 'set', 'preserve'].includes(price.policy)) invalid('Invalid price policy');
      normalized.price = { amount: integer(price.amount, 'price.amount'), currency: price.currency, policy: price.policy };
    }
    return normalized;
  });
  if (own(plan, 'source')) {
    const source = record(plan.source, ['channel', 'text', 'messageId'], 'source');
    result.source = { channel: text(source.channel, 'source.channel') };
    for (const field of ['text', 'messageId']) {
      if (own(source, field)) { if (typeof source[field] !== 'string') invalid(`source.${field} must be a string`); result.source[field] = source[field]; }
    }
  }
  return freeze(result);
}

export function validateOperationPlan(plan, context) {
  if (!context || typeof context.businessId !== 'string' || !context.businessId.trim() || context.businessId === '__default__' || typeof context.actorId !== 'string' || !context.actorId.trim()) fail('BUSINESS_SCOPE_REQUIRED', 'Explicit business and actor context is required');
  if (!(Array.isArray(context.permissions) || context.permissions instanceof Set) || ![...context.permissions].includes('inventory:receive')) fail('FORBIDDEN', 'inventory:receive permission is required');
  const normalized = normalizePlan(plan);
  if (normalized.businessId !== context.businessId) fail('BUSINESS_SCOPE_MISMATCH', 'Operation business differs from authenticated business');
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

export function planInventoryReceipt(input, products, { createId } = {}) {
  const plan = normalizePlan(input);
  if (!Array.isArray(products)) invalid('products must be an array');
  const byId = new Map();
  const identities = new Set();
  for (const row of products) {
    const product = record(row, null, 'product');
    const id = text(product.id, 'product.id');
    if (byId.has(id)) invalid('Duplicate product ID');
    const clone = { ...product, attributes: JSON.parse(JSON.stringify(domain(() => normalizeAttributes(product.attributes ?? {})))) };
    identities.add(productIdentity(clone));
    byId.set(id, clone);
  }
  const changed = new Map();
  const items = [], movements = [];
  for (const action of plan.actions) {
    let product, created = false;
    if (action.target.kind === 'existing') {
      product = byId.get(action.target.skuId);
      if (!product) fail('SKU_NOT_FOUND', 'Target SKU was not found', { skuId: action.target.skuId });
      if (action.target.expectedFingerprint && inventoryProductFingerprint(product) !== action.target.expectedFingerprint) fail('SKU_FINGERPRINT_MISMATCH', 'Target SKU identity changed');
    } else {
      const identity = productIdentity(action.target.sku);
      if (identities.has(identity)) fail('DUPLICATE_SKU_IDENTITY', 'An identical SKU already exists');
      if (typeof createId !== 'function') invalid('createId is required for new SKUs');
      const id = text(createId(), 'created SKU ID');
      if (byId.has(id)) fail('DUPLICATE_SKU_ID', 'Generated SKU ID already exists');
      product = { ...action.target.sku, attributes: JSON.parse(JSON.stringify(action.target.sku.attributes)), id, status: 'active', stockAvailable: 0, stockReserved: 0, price: 0, priceCurrency: 'XXX' };
      byId.set(id, product); identities.add(identity); created = true;
    }
    if ((product.status ?? 'active') !== 'active') fail('SKU_INACTIVE', 'Cannot receive stock for an inactive SKU');
    const unit = domain(() => normalizeUnit(product.unit ?? 'unit'));
    if (unit !== action.quantity.unit) fail('UNIT_MISMATCH', 'Receipt unit differs from SKU unit');
    const available = integer(product.stockAvailable ?? 0, 'stockAvailable');
    const reserved = integer(product.stockReserved ?? 0, 'stockReserved');
    if (!Number.isSafeInteger(available + action.quantity.value)) fail('STOCK_OVERFLOW', 'Receipt exceeds safe stock range');
    let price = integer(product.price ?? 0, 'product.price');
    let currency = product.priceCurrency ?? 'XXX';
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) invalid('Invalid stored currency');
    if (action.price) {
      const requested = action.price;
      if (currency !== 'XXX' && currency !== requested.currency) fail('CURRENCY_CONFLICT', 'Receipt currency differs from stored currency');
      if (requested.policy === 'initialize' && price !== 0 && price !== requested.amount) fail('PRICE_CONFLICT', 'Existing SKU price differs from requested initialization');
      if (requested.policy === 'set' || (requested.policy === 'initialize' && price === 0)) { price = requested.amount; currency = requested.currency; }
    }
    Object.assign(product, { stockAvailable: available + action.quantity.value, stockReserved: reserved, price, priceCurrency: currency });
    changed.set(product.id, product);
    items.push({ itemId: action.itemId, type: action.type, skuId: product.id, quantity: { ...action.quantity }, stockAvailable: product.stockAvailable, stockReserved: reserved, price, currency, created });
    movements.push({ itemId: action.itemId, skuId: product.id, deltaAvailable: action.quantity.value, deltaReserved: 0, unit });
  }
  return { changedProducts: [...changed.values()], items, movements };
}
