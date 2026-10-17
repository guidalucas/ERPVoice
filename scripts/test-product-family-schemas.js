import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductFamilySchemaError, normalizeFamilyPublication, normalizeFamilyReference, productFamilyPublicationDigest, validateProductFamily } from '../server/productFamilySchemas.js';
import { operationRequestDigest } from '../server/operationHash.js';

const publication = (schema = {}) => ({ operationId: ' publish-1 ', familyId: ' electrical ', expectedVersion: 0, schema: { name: ' Componentes eléctricos ', unit: ' UNIT ', attributes: {
  ' Voltaje ': { type: 'number', required: true, unit: ' V ', values: [110, 220] },
  dirección: { type: 'text', values: [' Entrada ', ' SALIDA '], allowedStates: ['known', 'unknown', 'not_applicable', 'missing'] },
  aislado: { type: 'boolean', values: [true, false] },
}, ...schema } });
const known = (type, value, unit) => ({ state: 'known', type, value, ...(unit ? { unit } : {}) });
const published = (input = publication(), version = input.expectedVersion + 1) => {
  const normalized = normalizeFamilyPublication(input);
  return { familyId: normalized.familyId, version, schema: normalized.schema };
};
const product = (attributes = {}) => ({ name: 'Conector', family: { id: 'electrical', version: 1 }, unit: 'unit', attributes: { voltaje: known('number', 220, 'v'), ...attributes } });
const reject = (callback, code = 'INVALID_PRODUCT_SCHEMA') => assert.throws(callback, error => error instanceof ProductFamilySchemaError && error.name === 'ProductFamilySchemaError' && error.code === code && Boolean(error.message));

test('publication normalizes explicit fields, typed enumerations, defaults and immutable copies', () => {
  const input = publication(), before = structuredClone(input), normalized = normalizeFamilyPublication(input);
  assert.deepEqual(input, before);
  assert.deepEqual(Object.keys(normalized), ['operationId', 'familyId', 'expectedVersion', 'schema']);
  assert.equal(normalized.operationId, 'publish-1'); assert.equal(normalized.familyId, 'electrical');
  assert.equal(normalized.schema.name, 'Componentes eléctricos'); assert.equal(normalized.schema.unit, 'unit');
  assert.equal(normalized.schema.allowAdditionalAttributes, false);
  assert.deepEqual(normalized.schema.attributes.voltaje, { type: 'number', required: true, allowedStates: ['known'], unit: 'v', values: [110, 220] });
  assert.deepEqual(normalized.schema.attributes.dirección.values, ['entrada', 'salida']);
  assert.equal(normalized.schema.attributes.aislado.required, false);
  for (const item of [normalized, normalized.schema, normalized.schema.attributes, normalized.schema.attributes.voltaje, normalized.schema.attributes.voltaje.values, normalized.schema.attributes.voltaje.allowedStates]) assert.ok(Object.isFrozen(item));
  input.schema.attributes[' Voltaje '].values[0] = 999;
  assert.equal(normalized.schema.attributes.voltaje.values[0], 110);
  assert.equal(productFamilyPublicationDigest(before), operationRequestDigest(normalized));
});

test('families are generic: sizes, direction and voltage use only explicitly typed attributes', () => {
  const garment = published({ operationId: 'garment', familyId: 'textiles', expectedVersion: 0, schema: { name: 'Textiles', unit: 'unit', attributes: { medida: { type: 'text', required: true, values: ['S', 'M', 'L'] } } } });
  const textile = { unit: 'unit', family: { id: 'textiles', version: 1 }, size: 'L', productModel: 'Modelo', attributes: { medida: known('text', ' M ') } };
  assert.equal(validateProductFamily(textile, [garment]), textile);
  reject(() => validateProductFamily({ ...textile, attributes: {} }, [garment]), 'PRODUCT_SCHEMA_MISMATCH');
  assert.equal(validateProductFamily(product({ dirección: known('text', ' SALIDA ') }), [published()]).name, 'Conector');
});

test('optional unknown, missing and not-applicable states are explicit and distinct from omission', () => {
  const schemas = [published()];
  for (const state of ['unknown', 'missing', 'not_applicable']) assert.equal(validateProductFamily(product({ dirección: { type: 'text', state } }), schemas).attributes.dirección.state, state);
  validateProductFamily(product(), schemas);
  reject(() => validateProductFamily(product({ aislado: { type: 'boolean', state: 'unknown' } }), schemas), 'PRODUCT_SCHEMA_MISMATCH');
  reject(() => validateProductFamily(product({ voltaje: { type: 'number', state: 'unknown', unit: 'v' } }), schemas), 'PRODUCT_SCHEMA_MISMATCH');
  reject(() => validateProductFamily(product({ dirección: { type: 'text', state: 'unknown', value: 'salida' } }), schemas), 'PRODUCT_SCHEMA_MISMATCH');
});

test('exact family version is required and later publication cannot reinterpret earlier products', () => {
  const first = published(), second = published(publication({ attributes: { voltaje: { type: 'number', required: true, unit: 'v', values: [12] } } }), 2);
  const input = product(), snapshots = structuredClone([first, second]), before = structuredClone(input);
  assert.equal(validateProductFamily(input, [first, second]), input);
  reject(() => validateProductFamily({ ...input, family: { id: 'electrical', version: 2 } }, [first, second]), 'PRODUCT_SCHEMA_MISMATCH');
  reject(() => validateProductFamily({ ...input, family: { id: 'electrical', version: 3 } }, [first, second]), 'PRODUCT_SCHEMA_NOT_FOUND');
  reject(() => validateProductFamily({ ...input, family: { id: 'different', version: 1 } }, [first]), 'PRODUCT_SCHEMA_NOT_FOUND');
  assert.deepEqual(input, before); assert.deepEqual([first, second], snapshots);
  reject(() => validateProductFamily(input, [first, first]));
});

test('types, enum membership, exact units and required known values are enforced without conversion', () => {
  const schemas = [published()];
  for (const attributes of [ { voltaje: known('text', '220', 'v') }, { voltaje: known('number', 12, 'v') }, { voltaje: known('number', 220, 'kv') }, { voltaje: known('number', 220) }, { aislado: known('boolean', 'true') }, { dirección: known('text', 'norte') } ]) reject(() => validateProductFamily(product(attributes), schemas), 'PRODUCT_SCHEMA_MISMATCH');
  reject(() => validateProductFamily({ ...product(), attributes: {} }, schemas), 'PRODUCT_SCHEMA_MISMATCH');
  reject(() => validateProductFamily({ ...product(), unit: 'kg' }, schemas), 'PRODUCT_SCHEMA_MISMATCH');
  reject(() => validateProductFamily(product({ dirección: known('text', 'entrada', 'unit') }), schemas), 'PRODUCT_SCHEMA_MISMATCH');
  validateProductFamily(product({ aislado: known('boolean', false) }), schemas);
});

test('additional attributes need explicit opt-in and still follow inventory attribute typing', () => {
  const input = product({ acabado: known('text', 'Mate') });
  reject(() => validateProductFamily(input, [published()]), 'PRODUCT_SCHEMA_MISMATCH');
  assert.equal(validateProductFamily(input, [published(publication({ allowAdditionalAttributes: true }))]), input);
  reject(() => validateProductFamily(product({ extra: known('number', Infinity) }), [published(publication({ allowAdditionalAttributes: true }))]), 'PRODUCT_SCHEMA_MISMATCH');
});

test('legacy absence/null family leaves products unchanged and does not infer legacy metadata', () => {
  for (const input of [{ name: 'Legacy', size: 'L', productModel: '220', unit: 'kg' }, { family: null, name: 'Legacy', size: 'L' }, { family: null, optionalLegacyField: undefined }]) {
    const before = structuredClone(input);
    assert.equal(validateProductFamily(input, undefined), input); assert.deepEqual(input, before);
  }
  const empty = published(publication({ attributes: {} }));
  validateProductFamily({ ...product(), size: 'M', productModel: '220', attributes: {} }, [empty]);
});

test('references and publication IDs/versions are closed, bounded and explicit', () => {
  assert.deepEqual(normalizeFamilyReference({ id: ' electrical ', version: 1 }), { id: 'electrical', version: 1 });
  assert.ok(Object.isFrozen(normalizeFamilyReference({ id: 'x', version: 1 })));
  for (const input of [{ id: '', version: 1 }, { id: 'x'.repeat(121), version: 1 }, { id: 'x', version: 0 }, { id: 'x', version: 0.5 }, { id: 'x', version: Number.MAX_SAFE_INTEGER + 1 }, { id: 'x', version: 1, extra: true }]) reject(() => normalizeFamilyReference(input));
  for (const expectedVersion of [-1, 0.5, Number.MAX_SAFE_INTEGER, undefined, '0']) reject(() => normalizeFamilyPublication({ ...publication(), expectedVersion }));
  assert.equal(normalizeFamilyPublication({ ...publication(), expectedVersion: Number.MAX_SAFE_INTEGER - 1 }).expectedVersion + 1, Number.MAX_SAFE_INTEGER);
  for (const patch of [{ operationId: 'x'.repeat(181) }, { operationId: '' }, { familyId: 'x'.repeat(121) }, { familyId: '' }, { extra: true }]) reject(() => normalizeFamilyPublication({ ...publication(), ...patch }));
  reject(() => normalizeFamilyPublication(publication({ name: 'x'.repeat(201) })));
  reject(() => normalizeFamilyPublication(publication({ unit: undefined })));
});

test('contradictory required states, wrong enum types, normalized duplicates and numeric anomalies reject', () => {
  const definitions = [ { type: 'unknown' }, { type: 'text', required: 1 }, { type: 'text', required: true, allowedStates: ['known', 'unknown'] }, { type: 'number', allowedStates: [] }, { type: 'text', allowedStates: ['known', 'known'] }, { type: 'text', allowedStates: ['unspecified'] }, { type: 'text', unit: 'kg' }, { type: 'boolean', unit: 'unit' }, { type: 'text', values: [' A ', 'a'] }, { type: 'number', values: [0, -0] }, { type: 'number', values: [Infinity] }, { type: 'boolean', values: [1] }, { type: 'text', values: [1] }, { type: 'number', values: ['220'] }, { type: 'text', values: [] } ];
  for (const definition of definitions) reject(() => normalizeFamilyPublication(publication({ attributes: { field: definition } })));
  reject(() => normalizeFamilyPublication(publication({ attributes: { Voltaje: { type: 'number' }, ' voltaje ': { type: 'text' } } })));
  reject(() => normalizeFamilyPublication(publication({ attributes: { ' ': { type: 'text' } } })));
  reject(() => normalizeFamilyPublication(publication({ allowAdditionalAttributes: 'yes' })));
});

test('attribute and enum limits reject complete requests instead of truncating', () => {
  const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`key-${index}`, { type: 'number' }]));
  assert.equal(Object.keys(normalizeFamilyPublication(publication({ attributes: fifty })).schema.attributes).length, 50);
  reject(() => normalizeFamilyPublication(publication({ attributes: { ...fifty, extra: { type: 'text' } } })));
  const values = Array.from({ length: 100 }, (_, index) => index);
  assert.equal(normalizeFamilyPublication(publication({ attributes: { value: { type: 'number', values } } })).schema.attributes.value.values.length, 100);
  reject(() => normalizeFamilyPublication(publication({ attributes: { value: { type: 'number', values: [...values, 100] } } })));
});

test('getters, prototypes, undefined, dangerous keys and sparse arrays never execute or sneak into definitions', () => {
  const mutations = [p => p.schema.extra = true, p => p.schema.attributes.x = undefined, p => p.schema.attributes.x = { type: 'text', required: undefined }, p => Object.setPrototypeOf(p.schema, { bad: true }), p => p.schema.attributes = Object.assign([], { x: { type: 'text' } }),
    p => Object.defineProperty(p, 'operationId', { enumerable: true, get() { throw Error('getter ran'); } }),
    p => Object.defineProperty(p.schema.attributes, 'x', { enumerable: true, get() { throw Error('getter ran'); } }),
    p => Object.defineProperty(p.schema.attributes, '__proto__', { enumerable: true, value: { type: 'text' } }),
    p => p.schema.attributes[' Constructor '] = { type: 'text' },
    p => { p.schema.attributes.x = { type: 'text', values: ['a', 'b'] }; delete p.schema.attributes.x.values[0]; },
    p => { p.schema.attributes.x = { type: 'text', allowedStates: ['known'] }; Object.defineProperty(p.schema.attributes.x.allowedStates, '0', { enumerable: true, get() { throw Error('getter ran'); } }); },
  ];
  for (const mutate of mutations) { const input = publication(); mutate(input); reject(() => normalizeFamilyPublication(input)); }
  const input = product(); Object.defineProperty(input.family, 'version', { enumerable: true, get() { throw Error('getter ran'); } }); reject(() => validateProductFamily(input, [published()]));
  assert.equal({}.polluted, undefined);
});

test('digest changes for a new definition or expected version while normalized attribute order is stable', () => {
  const input = publication(), hash = productFamilyPublicationDigest(input);
  const reordered = publication({ attributes: Object.fromEntries(Object.entries(input.schema.attributes).reverse()) });
  assert.equal(productFamilyPublicationDigest(reordered), hash);
  assert.notEqual(productFamilyPublicationDigest({ ...input, expectedVersion: 1 }), hash);
  assert.notEqual(productFamilyPublicationDigest(publication({ name: 'Nueva definición' })), hash);
});
