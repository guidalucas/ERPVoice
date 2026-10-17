import { normalizeProductMetadata } from './productIdentity.js';
import { InventoryOperationError } from './inventoryOperations.js';

const invalid = (message) => { throw new InventoryOperationError('INVALID_OPERATION_PLAN', message); };
const fields = (input, allowed, label) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid(`${label} must be a plain record`);
  const result = {};
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!allowed.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value')) invalid(`Unsupported ${label} field: ${String(key)}`);
    if (property.value !== undefined) result[key] = property.value;
  }
  return result;
};
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} must be a nonempty string`);
  return value.trim();
};
const openingNumber = (input, key) => {
  const value = Object.hasOwn(input, key) ? input[key] : 0;
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${key} must be a nonnegative safe integer`);
  return value;
};

const createAction = (input, reason, index) => {
  for (const field of ['productType', 'productModel', 'size']) {
    if (input[field] != null && typeof input[field] !== 'string') invalid(`${field} must be a string or null`);
  }
  const explicitName = Object.hasOwn(input, 'name') ? text(input.name, 'name') : null;
  // Compatibility normalization prepares explicit new-SKU data; it never selects an existing SKU.
  const metadata = normalizeProductMetadata(input);
  const name = explicitName !== null ? explicitName
    : text([metadata.productType, metadata.productModel].filter(Boolean).join(' '), 'name');
  const sku = { name, unit: Object.hasOwn(input, 'unit') ? input.unit : 'unit', attributes: Object.hasOwn(input, 'attributes') ? input.attributes : {} };
  if (Object.hasOwn(input,'family')) sku.family=input.family;
  for (const field of ['productType', 'productModel', 'size']) if (metadata[field] != null && metadata[field] !== '') sku[field] = metadata[field];
  return { itemId: `create-${index + 1}`, type: 'sku.create', target: { kind: 'new', sku }, reason,
    initialStock: { available: openingNumber(input, 'stockAvailable'), reserved: openingNumber(input, 'stockReserved') },
    price: { amount: openingNumber(input, 'price'), currency: Object.hasOwn(input, 'priceCurrency') ? input.priceCurrency : 'XXX', policy: 'initialize' } };
};

/** Legacy endpoint adaptation only. Core validation, IDs and persistence remain universal. */
export function productCreationToPlan(input, businessId, options = {}, model = false) {
  const productFields = ['name', 'productType', 'productModel', 'size', 'stockAvailable', 'stockReserved', 'price', 'priceCurrency', 'unit', 'attributes', 'family','operationId', 'reason'];
  const data = fields(input, model ? ['name', 'productType', 'productModel', 'variants', 'unit', 'attributes', 'family','priceCurrency', 'operationId', 'reason'] : productFields, 'product creation');
  const operationId = options.operationId ?? data.operationId;
  if (typeof operationId !== 'string' || !operationId.trim()) throw new InventoryOperationError('OPERATION_ID_REQUIRED', 'El alta necesita un ID estable para poder reintentarse.');
  const reason = options.reason ?? data.reason ?? (model ? 'Alta de variantes de modelo' : 'Alta manual de SKU');
  let actions;
  if (model) {
    const productType = text(data.productType, 'productType'), productModel = text(data.productModel, 'productModel');
    const name = Object.hasOwn(data, 'name') ? text(data.name, 'name') : `${productType} ${productModel}`;
    const variants = data.variants;
    if (!Array.isArray(variants) || Object.getPrototypeOf(variants) !== Array.prototype || !variants.length || variants.length > 100 || Reflect.ownKeys(variants).length !== variants.length + 1) invalid('variants must contain 1 to 100 entries');
    actions = Array.from({ length: variants.length }, (_, index) => {
      const property = Object.getOwnPropertyDescriptor(variants, String(index));
      if (!property || !Object.hasOwn(property, 'value')) invalid('variants must contain data properties');
      const variant = fields(property.value, ['size', 'stockAvailable', 'stockReserved', 'price', 'attributes', 'family','unit', 'priceCurrency'], 'variant');
      return createAction({ ...Object.fromEntries(['unit', 'attributes', 'family','priceCurrency'].filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]])),
        ...variant, size: text(variant.size, 'size'), name, productType, productModel }, reason, index);
    });
  } else actions = [createAction(data, reason, 0)];
  return { contractVersion: 1, businessId, operationId: `${model ? 'model-create' : 'product-create'}:${operationId}`,
    source: { channel: options.channel ?? 'panel', text: reason }, actions };
}
