import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalIdentityText, normalizeAttributes, normalizeUnit, skuIdentityKey, sameSkuIdentity,
} from '../server/inventoryDomain.js';

const known = (type, value, extra = {}) => ({ state: 'known', type, value, ...extra });
const fails = (fn) => assert.throws(fn, { code: 'INVALID_INVENTORY_DOMAIN' });

test('canonical identity normalizes only Unicode composition, case, and whitespace', () => {
  assert.equal(canonicalIdentityText('  CAFE\u0301\tUSB  '), 'café usb');
  assert.equal(canonicalIdentityText(''), '');
  for (const value of [null, undefined, 42, {}, true]) fails(() => canonicalIdentityText(value));
  assert.ok(sameSkuIdentity({ name: '  CAFE\u0301 USB ' }, { name: 'café\tusb' }));
});

test('directional converters, numeric roles, punctuation, accents and repetition stay distinct', () => {
  for (const [left, right] of [
    ['convertidor hdmi a vga', 'convertidor vga a hdmi'],
    ['cable rojo largo', 'cable largo rojo'],
    ['adaptador 12 a 24 v', 'adaptador 24 a 12 v'],
    ['cable usb usb', 'cable usb'],
    ['usb-c', 'usb c'], ['café', 'cafe'], ['tornillo', 'tornillos'],
  ]) assert.equal(sameSkuIdentity({ name: left }, { name: right }), false, `${left} vs ${right}`);
});

test('arbitrary attributes use sorted keys and explicit normalized typed values', () => {
  const a = { name: 'Pieza', attributes: {
    ' Material ': known('text', '  Acero  Azul '), enabled: known('boolean', false),
    length: known('number', 12, { unit: ' MM ' }), family: known('text', 'A:B'),
  } };
  const b = { name: 'pieza', attributes: {
    family: known('text', 'a:b'), LENGTH: known('number', 12, { unit: 'mm' }),
    enabled: known('boolean', false), material: known('text', 'acero azul'),
  } };
  assert.equal(skuIdentityKey(a), skuIdentityKey(b));
  assert.notEqual(skuIdentityKey(a), skuIdentityKey({ ...a, attributes: { ...a.attributes, length: known('text', '12', { unit: 'mm' }) } }));
});

test('all non-known states and omitted attributes are distinct', () => {
  const keys = ['unknown', 'not_applicable', 'missing'].map((state) =>
    skuIdentityKey({ name: 'pieza', attributes: { color: { state, type: 'text' } } }));
  keys.push(skuIdentityKey({ name: 'pieza' }));
  keys.push(skuIdentityKey({ name: 'pieza', attributes: { color: known('text', '') } }));
  assert.equal(new Set(keys).size, keys.length);
});

test('units remain opaque and no numerical conversion occurs', () => {
  assert.equal(normalizeUnit('  KG '), 'kg');
  assert.ok(sameSkuIdentity({ name: 'pieza', unit: ' KG ' }, { name: 'pieza', unit: 'kg' }));
  assert.equal(sameSkuIdentity({ name: 'pieza', unit: 'kg' }, { name: 'pieza', unit: 'g' }), false);
  assert.equal(sameSkuIdentity(
    { name: 'pieza', attributes: { weight: known('number', 1, { unit: 'kg' }) } },
    { name: 'pieza', attributes: { weight: known('number', 1000, { unit: 'g' }) } },
  ), false);
  for (const value of ['', '  ', null, undefined, 1]) fails(() => normalizeUnit(value));
});

test('attributes are cloned, sorted and deeply immutable', () => {
  const source = { z: known('text', 'BLUE'), a: known('number', 2) };
  const result = normalizeAttributes(source);
  assert.deepEqual(Object.keys(result), ['a', 'z']);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.z));
  source.z.value = 'red';
  assert.equal(result.z.value, 'blue');
  assert.throws(() => { result.z.value = 'green'; }, TypeError);
});

test('invalid values and undefined cannot disappear from identity', () => {
  for (const attributes of [null, [], { x: undefined }, { x: known('number', NaN) },
    { x: known('number', Infinity) }, { x: known('number', '2') },
    { x: known('boolean', 0) }, { x: known('text', 3) },
    { x: { state: 'known', type: 'number' } },
    { x: { state: 'unknown', type: 'text', value: '' } },
    { x: { state: 'unknown', type: 'other' } },
    { x: known('text', 'a', { unit: undefined }) },
    { x: known('text', 'a', { extra: 'ignored?' }) },
    { ' X ': known('text', 'a'), x: known('text', 'b') },
  ]) fails(() => normalizeAttributes(attributes));
  for (const input of [{}, { name: '' }, { name: 'x', unit: undefined },
    { name: 'x', attributes: undefined }, { name: 'x', other: undefined }]) fails(() => skuIdentityKey(input));
});

test('prototype keys, inherited records, symbols and accessors are rejected', () => {
  for (const key of ['__proto__', 'constructor', 'prototype', ' Constructor ']) {
    fails(() => normalizeAttributes(Object.fromEntries([[key, known('text', 'x')]])));
    fails(() => normalizeAttributes({ x: Object.fromEntries([['state', 'unknown'], ['type', 'text'], [key, 'x']]) }));
  }
  fails(() => normalizeAttributes(Object.create({ inherited: known('text', 'x') })));
  fails(() => normalizeAttributes({ [Symbol('x')]: known('text', 'x') }));
  fails(() => normalizeAttributes(Object.defineProperty({}, 'x', {
    enumerable: true, get() { throw new Error('must not invoke getters'); },
  })));
});
