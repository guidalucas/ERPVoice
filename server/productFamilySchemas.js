import { canonicalIdentityText, normalizeAttributes, normalizeUnit } from './inventoryDomain.js';
import { operationRequestDigest } from './operationHash.js';

/** Immutable, pure family contracts. Publication normalization returns the closed
 * {operationId,familyId,expectedVersion,schema} request; persistence publishes
 * schema at expectedVersion+1. References always name one exact version.
 * validateProductFamily returns the original product, without deriving legacy
 * attributes, changing identity, converting units, or modifying either input.
 */
export class ProductFamilySchemaError extends Error {
  constructor(code, message) { super(message); this.name = 'ProductFamilySchemaError'; this.code = code; }
}
const fail = (code, message) => { throw new ProductFamilySchemaError(code, message); };
const invalid = (message) => fail('INVALID_PRODUCT_SCHEMA', message);
const mismatch = (message) => fail('PRODUCT_SCHEMA_MISMATCH', message);
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const states = ['known', 'unknown', 'not_applicable', 'missing'];
const types = ['text', 'number', 'boolean'];
const record = (value, keys, label) => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} debe ser un objeto de datos.`);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || unsafe.has(canonicalIdentityText(key)) || (keys && !keys.includes(key)) || !property.enumerable || !Object.hasOwn(property, 'value') || property.value === undefined) invalid(`Campo inválido en ${label}: ${String(key)}.`);
    result[key] = property.value;
  }
  return result;
};
const dense = (value, max, label) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid(`${label} debe ser una lista densa de hasta ${max} valores.`);
  return Array.from({ length: value.length }, (_, index) => {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value') || property.value === undefined) invalid(`${label} solo admite datos definidos.`);
    return property.value;
  });
};
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${label} debe ser texto no vacío de hasta ${max} caracteres.`);
  return value.trim();
};
const integer = (value, min, label, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} debe ser un entero seguro entre ${min} y ${max}.`);
  return value;
};
const domain = (callback, report = invalid) => {
  try { return callback(); }
  catch (error) { if (error.code === 'INVALID_INVENTORY_DOMAIN') report(error.message); throw error; }
};
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

const normalizeSchema = (input) => {
  const schema = record(input, ['name', 'unit', 'attributes', 'allowAdditionalAttributes'], 'esquema');
  const result = { name: text(schema.name, 200, 'Nombre'), unit: domain(() => normalizeUnit(schema.unit)), attributes: {}, allowAdditionalAttributes: false };
  if (Object.hasOwn(schema, 'allowAdditionalAttributes')) {
    if (typeof schema.allowAdditionalAttributes !== 'boolean') invalid('allowAdditionalAttributes debe ser booleano.');
    result.allowAdditionalAttributes = schema.allowAdditionalAttributes;
  }
  const definitions = record(schema.attributes, null, 'atributos de esquema'), normalized = [];
  if (Object.keys(definitions).length > 50) invalid('El esquema admite hasta 50 atributos.');
  const seen = new Set();
  for (const [rawKey, inputDefinition] of Object.entries(definitions)) {
    const key = canonicalIdentityText(rawKey);
    if (!key || unsafe.has(key) || seen.has(key)) invalid('Las claves de atributos deben ser seguras, no vacías y únicas al normalizarlas.');
    seen.add(key);
    const definition = record(inputDefinition, ['type', 'required', 'allowedStates', 'unit', 'values'], `atributo ${key}`);
    if (!types.includes(definition.type)) invalid(`Tipo inválido para ${key}.`);
    if (Object.hasOwn(definition, 'required') && typeof definition.required !== 'boolean') invalid(`required debe ser booleano para ${key}.`);
    const required = definition.required ?? false;
    const allowedStates = Object.hasOwn(definition, 'allowedStates') ? dense(definition.allowedStates, 4, `Estados de ${key}`) : ['known'];
    if (!allowedStates.length || allowedStates.some(state => !states.includes(state)) || new Set(allowedStates).size !== allowedStates.length) invalid(`Estados inválidos o repetidos para ${key}.`);
    if (required && (allowedStates.length !== 1 || allowedStates[0] !== 'known')) invalid(`El atributo obligatorio ${key} solo puede admitir el estado known.`);
    const value = { type: definition.type, required, allowedStates: [...allowedStates] };
    if (Object.hasOwn(definition, 'unit')) {
      if (definition.type !== 'number') invalid(`Solo atributos numéricos admiten unidad: ${key}.`);
      value.unit = domain(() => normalizeUnit(definition.unit));
    }
    if (Object.hasOwn(definition, 'values')) {
      const entries = dense(definition.values, 100, `Valores de ${key}`), enumSeen = new Set();
      if (!entries.length) invalid(`La enumeración de ${key} no puede estar vacía.`);
      value.values = entries.map(entry => {
        const normalizedValue = domain(() => normalizeAttributes({ value: { state: 'known', type: definition.type, value: entry } })).value.value;
        if (enumSeen.has(normalizedValue)) invalid(`Valores repetidos al normalizar ${key}.`);
        enumSeen.add(normalizedValue);
        return normalizedValue;
      });
    }
    normalized.push([key, value]);
  }
  normalized.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  result.attributes = Object.fromEntries(normalized);
  return freeze(result);
};

export function normalizeFamilyPublication(input) {
  const request = record(input, ['operationId', 'familyId', 'expectedVersion', 'schema'], 'publicación');
  return freeze({ operationId: text(request.operationId, 180, 'operationId'), familyId: text(request.familyId, 120, 'familyId'),
    expectedVersion: integer(request.expectedVersion, 0, 'expectedVersion', Number.MAX_SAFE_INTEGER - 1), schema: normalizeSchema(request.schema) });
}

export function normalizeFamilyReference(input) {
  const reference = record(input, ['id', 'version'], 'referencia de familia');
  return freeze({ id: text(reference.id, 120, 'id de familia'), version: integer(reference.version, 1, 'Versión') });
}

export const productFamilyPublicationDigest = (input) => operationRequestDigest(normalizeFamilyPublication(input));

export function validateProductFamily(product, schemas) {
  if (!product || typeof product !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(product))) invalid('producto debe ser un objeto de datos.');
  const familyProperty = Object.getOwnPropertyDescriptor(product, 'family');
  // Family validation adds no requirements to legacy products without a family.
  if (!familyProperty) return product;
  if (!familyProperty.enumerable || !Object.hasOwn(familyProperty, 'value') || familyProperty.value === undefined) invalid('La familia debe ser un dato definido.');
  if (familyProperty.value === null) return product;
  const input = record(product, null, 'producto');
  const reference = normalizeFamilyReference(input.family);
  const versions = dense(schemas, Number.MAX_SAFE_INTEGER, 'Esquemas publicados');
  let found;
  for (const value of versions) {
    const entry = record(value, ['familyId', 'version', 'schema'], 'esquema publicado');
    const familyId = text(entry.familyId, 120, 'familyId'), version = integer(entry.version, 1, 'Versión publicada');
    if (familyId === reference.id && version === reference.version) {
      if (found) invalid('Hay dos definiciones para la misma familia y versión.');
      found = entry;
    }
  }
  if (!found) fail('PRODUCT_SCHEMA_NOT_FOUND', `No existe la familia ${reference.id} en la versión ${reference.version}.`);
  const schema = normalizeSchema(found.schema);
  const unit = domain(() => normalizeUnit(input.unit), mismatch);
  if (unit !== schema.unit) mismatch(`La familia ${reference.id} requiere la unidad de inventario ${schema.unit}; se recibió ${unit}.`);
  const attributes = domain(() => normalizeAttributes(Object.hasOwn(input, 'attributes') ? input.attributes : {}), mismatch);
  for (const [key, definition] of Object.entries(schema.attributes)) {
    const attribute = attributes[key];
    if (!attribute) { if (definition.required) mismatch(`Falta el atributo obligatorio ${key}.`); continue; }
    if (attribute.type !== definition.type) mismatch(`El atributo ${key} debe tener tipo ${definition.type}.`);
    if (!definition.allowedStates.includes(attribute.state)) mismatch(`La familia no admite el estado ${attribute.state} para ${key}.`);
    if (definition.required && attribute.state !== 'known') mismatch(`El atributo obligatorio ${key} debe ser conocido.`);
    if (attribute.unit !== definition.unit) mismatch(`La unidad de ${key} debe ser ${definition.unit ?? 'ausente'}; no se realizan conversiones.`);
    if (attribute.state === 'known' && definition.values && !definition.values.includes(attribute.value)) mismatch(`El valor de ${key} no pertenece a los valores admitidos.`);
  }
  if (!schema.allowAdditionalAttributes) for (const key of Object.keys(attributes)) {
    if (!Object.hasOwn(schema.attributes, key)) mismatch(`El atributo ${key} no está declarado en la familia ${reference.id}.`);
  }
  return product;
}
