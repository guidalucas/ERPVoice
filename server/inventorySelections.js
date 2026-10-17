import { createHash } from 'node:crypto';
import { canonicalIdentityText, normalizeAttributes, normalizeUnit } from './inventoryDomain.js';
import { InventoryOperationError, inventoryProductFingerprint, validateOperationPlan, operationDigest, planInventoryOperation } from './inventoryOperations.js';

const fail = (code, message) => { throw new InventoryOperationError(code, message); };
const invalid = (message) => fail('INVALID_SELECTION', message);
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} must be a nonempty string`);
  return value;
};
const record = (input, keys, label) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid(`${label} must be a plain record`);
  const result = {};
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value') || property.value === undefined) invalid(`Unsupported ${label} field: ${String(key)}`);
    result[key] = property.value;
  }
  return result;
};
const domain = (fn) => {
  try { return fn(); } catch (error) { if (error.code === 'INVALID_INVENTORY_DOMAIN') invalid(error.message); throw error; }
};

/** Public mutation channels must obtain a reviewed set before changing several SKUs. */
export function requireReviewedUpdateSelection(plan) {
  if ((Array.isArray(plan?.actions) ? plan.actions : []).some((action) => action?.type === 'sku.deactivate')) fail('SELECTION_REQUIRED', 'Revisá y confirmá una selección antes de dar de baja los SKU.');
  const ids = new Set((Array.isArray(plan?.actions) ? plan.actions : [])
    .filter((action) => ['sku.update', 'stock.adjust'].includes(action?.type))
    .map((action) => action.target?.skuId));
  if (ids.size > 1) fail('SELECTION_REQUIRED', 'Revisá una selección de SKU antes de confirmar cambios masivos.');
}

export function normalizeSelectionRequest(input) {
  const request = record(input, ['requestId', 'selector', 'mutation'], 'selection');
  const requestId = text(request.requestId, 'requestId');
  const selector = record(request.selector, ['kind', 'skuIds', 'equals'], 'selector');
  let normalized;
  if (selector.kind === 'ids') {
    if (Object.hasOwn(selector, 'equals')) invalid('ID selector cannot include filters');
    const ids = selector.skuIds;
    if (!Array.isArray(ids) || Object.getPrototypeOf(ids) !== Array.prototype || !ids.length || Reflect.ownKeys(ids).length !== ids.length + 1) invalid('skuIds must be a dense nonempty array');
    if (ids.length > 100) fail('SELECTION_TOO_LARGE', 'La selección supera los 100 SKU. Dividí el conjunto antes de confirmar.');
    const values = Array.from({ length: ids.length }, (_, index) => {
      const property = Object.getOwnPropertyDescriptor(ids, String(index));
      if (!property || !Object.hasOwn(property, 'value')) invalid('skuIds must contain data properties');
      return text(property.value, 'skuId');
    });
    if (new Set(values).size !== values.length) invalid('Duplicate SKU IDs');
    normalized = { kind: 'ids', skuIds: values.sort() };
  } else if (selector.kind === 'all') {
    if (Object.keys(selector).length !== 1) invalid('All selector cannot include filters or IDs');
    normalized = { kind: 'all' };
  } else if (selector.kind === 'filter') {
    if (Object.hasOwn(selector, 'skuIds')) invalid('Filter selector cannot include IDs');
    const equals = record(selector.equals, ['name', 'productType', 'productModel', 'size', 'unit', 'status', 'attributes'], 'equals');
    if (!Object.keys(equals).length) invalid('Empty filter; use an explicit all selector');
    normalized = { kind: 'filter', equals: {} };
    for (const [field, value] of Object.entries(equals)) {
      if (field === 'attributes') {
        const attributes = domain(() => normalizeAttributes(value));
        if (!Object.keys(attributes).length) invalid('Attribute filter cannot be empty');
        normalized.equals.attributes = attributes;
      } else if (value === null && ['productType', 'productModel', 'size'].includes(field)) normalized.equals[field] = null;
      else {
        const normalizedValue = domain(() => field === 'unit' ? normalizeUnit(text(value, field)) : canonicalIdentityText(text(value, field)));
        if (field === 'status' && !['active', 'inactive'].includes(normalizedValue)) invalid('Invalid status filter');
        normalized.equals[field] = normalizedValue;
      }
    }
  } else invalid('Unsupported selector kind');
  const mutation = record(request.mutation, ['type', 'changes', 'reason'], 'mutation');
  if (!['sku.update', 'sku.deactivate'].includes(mutation.type)) fail('UNSUPPORTED_OPERATION', 'Este conjunto solo admite cambios y bajas de SKU por ahora.');
  if (mutation.type === 'sku.deactivate' && Object.hasOwn(mutation, 'changes')) invalid('Deactivation cannot include changes');
  // Reuse the operation contract for mutation fields and values.
  const validated = validateOperationPlan({ contractVersion: 1, businessId: 'selection-validation', operationId: 'validation',
    actions: [{ itemId: 'validation', type: mutation.type, target: { kind: 'existing', skuId: 'validation', expectedRevision: 0 },
      ...(mutation.type === 'sku.update' ? { changes: mutation.changes } : {}), reason: mutation.reason }],
  }, { businessId: 'selection-validation', actorId: 'selection-validation', permissions: ['inventory:update', 'inventory:deactivate'] });
  return { requestId, selector: normalized, mutation: { type: mutation.type,
    ...(mutation.type === 'sku.update' ? { changes: validated.actions[0].changes } : {}), reason: validated.actions[0].reason } };
}

export function selectInventoryProducts(selector, products) {
  // Validate selectors identically when called independently of the HTTP adapter.
  const normalized = normalizeSelectionRequest({ requestId: 'selector', selector,
    mutation: { type: 'sku.update', changes: { price: 0 }, reason: 'Selector validation' } }).selector;
  const selected = products.filter((product) => {
    if (normalized.kind === 'ids') return normalized.skuIds.includes(product.id);
    if (normalized.kind === 'all') return (product.status ?? 'active') === 'active';
    if (!Object.hasOwn(normalized.equals, 'status') && (product.status ?? 'active') !== 'active') return false;
    return Object.entries(normalized.equals).every(([field, wanted]) => {
      if (field === 'attributes') {
        const actual = domain(() => normalizeAttributes(product.attributes ?? {}));
        return Object.entries(wanted).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value));
      }
      const actual = product[field] ?? (field === 'status' ? 'active' : field === 'unit' ? 'unit' : null);
      if (wanted === null) return actual === null || actual === '';
      return typeof actual === 'string' && domain(() => canonicalIdentityText(actual)) === wanted;
    });
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (normalized.kind === 'ids' && selected.length !== normalized.skuIds.length) fail('SKU_NOT_FOUND', 'La selección contiene SKU que ya no están disponibles en este negocio.');
  if (!selected.length) fail('EMPTY_SELECTION', 'El conjunto no contiene SKU; no se preparó ningún cambio.');
  if (selected.length > 100) fail('SELECTION_TOO_LARGE', 'La selección supera los 100 SKU. Dividí el conjunto antes de confirmar.');
  return selected;
}

export function buildSelectionPreview(input, products, { businessId, actorId, selectionId, expiresAt, permissions = ['inventory:update', 'inventory:deactivate'] }) {
  const request = normalizeSelectionRequest(input);
  text(selectionId, 'selectionId');
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) invalid('Invalid selection expiry');
  const selected = selectInventoryProducts(request.selector, products);
  const plan = validateOperationPlan({ contractVersion: 1, businessId, operationId: `selection:${selectionId}`,
    source: { channel: 'selection', text: request.mutation.reason },
    actions: selected.map((product, index) => ({ itemId: `selected-${index + 1}`, ...request.mutation,
      target: { kind: 'existing', skuId: product.id, expectedRevision: product.revision,
        expectedFingerprint: inventoryProductFingerprint(product) } })),
  }, { businessId, actorId, permissions });
  // Preflight uses the SAME planner; preview never persists its effects.
  planInventoryOperation(plan, products);
  const members = selected.map((product) => ({ skuId: product.id, name: product.name, size: product.size ?? null,
    revision: product.revision, stockAvailable: product.stockAvailable, stockReserved: product.stockReserved,
    price: product.price, priceCurrency: product.priceCurrency ?? 'XXX' }));
  const digest = createHash('sha256').update(JSON.stringify({ businessId, actorId, selectionId, expiresAt, members,
    operation: operationDigest(plan) })).digest('hex');
  return { plan, preview: { selectionId, digest, expiresAt, status: 'pending', members, mutation: request.mutation } };
}

export function selectionRequestDigest(input) {
  const stable = (value) => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(stable(normalizeSelectionRequest(input)))).digest('hex');
}
