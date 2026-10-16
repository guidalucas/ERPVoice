/** Pure, conservative SKU identity. No inference, token sorting, or unit conversion. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TYPES = new Set(['text', 'number', 'boolean']);
const STATES = new Set(['known', 'unknown', 'not_applicable', 'missing']);

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_INVENTORY_DOMAIN';
  throw error;
}

export function canonicalIdentityText(value) {
  if (typeof value !== 'string') invalid('Identity text must be a string');
  return value.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function recordEntries(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${label} must be a plain record`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid(`${label} must be a plain record`);
  return Reflect.ownKeys(value).map((key) => {
    if (typeof key !== 'string' || UNSAFE_KEYS.has(canonicalIdentityText(key))) {
      invalid(`${label} contains an unsafe key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalid(`${label} must contain enumerable data properties`);
    }
    if (descriptor.value === undefined) invalid(`${label}.${key} cannot be undefined`);
    return [key, descriptor.value];
  });
}

export function normalizeUnit(value) {
  const unit = canonicalIdentityText(value);
  if (!unit) invalid('Unit cannot be empty');
  return unit;
}

export function normalizeAttributes(input) {
  const normalized = [];
  const seen = new Set();
  for (const [rawKey, rawAttribute] of recordEntries(input, 'Attributes')) {
    const key = canonicalIdentityText(rawKey);
    if (!key || seen.has(key)) invalid('Attribute keys must be nonempty and unique after normalization');
    seen.add(key);
    const entries = recordEntries(rawAttribute, `Attribute ${key}`);
    const fields = Object.fromEntries(entries);
    for (const [field] of entries) {
      if (!['state', 'type', 'value', 'unit'].includes(field)) invalid(`Unsupported attribute field: ${field}`);
    }
    const { state, type } = fields;
    if (!STATES.has(state) || !TYPES.has(type)) invalid(`Invalid state or type for attribute ${key}`);
    const attribute = { state, type };
    if (state === 'known') {
      if (!Object.hasOwn(fields, 'value')) invalid(`Known attribute ${key} requires a value`);
      const value = fields.value;
      if (type === 'text') {
        attribute.value = canonicalIdentityText(value);
      } else if (type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`Attribute ${key} requires a finite number`);
        attribute.value = Object.is(value, -0) ? 0 : value;
      } else {
        if (typeof value !== 'boolean') invalid(`Attribute ${key} requires a boolean`);
        attribute.value = value;
      }
    } else if (Object.hasOwn(fields, 'value')) {
      invalid(`Non-known attribute ${key} cannot contain a value`);
    }
    if (Object.hasOwn(fields, 'unit')) attribute.unit = normalizeUnit(fields.unit);
    normalized.push([key, Object.freeze(attribute)]);
  }
  normalized.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return Object.freeze(Object.fromEntries(normalized));
}

export function skuIdentityKey(input) {
  const entries = recordEntries(input, 'SKU identity');
  const fields = Object.fromEntries(entries);
  for (const [field] of entries) {
    if (!['name', 'attributes', 'unit'].includes(field)) invalid(`Unsupported SKU identity field: ${field}`);
  }
  const name = canonicalIdentityText(fields.name);
  if (!name) invalid('SKU name cannot be empty');
  const attributes = normalizeAttributes(Object.hasOwn(fields, 'attributes') ? fields.attributes : {});
  const unit = normalizeUnit(Object.hasOwn(fields, 'unit') ? fields.unit : 'unit');
  return JSON.stringify([name, attributes, unit]);
}

export function sameSkuIdentity(left, right) {
  return skuIdentityKey(left) === skuIdentityKey(right);
}
