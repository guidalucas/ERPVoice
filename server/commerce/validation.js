import { fail } from './errors.js';

export function record(value, allowed, label = 'command') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail('INVALID_COMMAND', `${label} must be a plain object.`, 400);
  const output = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) || !allowed.includes(key)
      || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) fail('INVALID_COMMAND', `Invalid ${label} field.`, 400);
    output[key] = descriptor.value;
  }
  return output;
}
export const text = (value, max, label, { empty = false } = {}) => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail('INVALID_COMMAND', `Invalid ${label}.`, 400);
  return value.normalize('NFC').trim();
};
export const integer = (value, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) fail('INVALID_COMMAND', 'Expected a safe integer.', 400);
  return value;
};
export const uuid = value => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail('INVALID_COMMAND', 'Expected a UUID.', 400);
  return value.toLowerCase();
};
export function denseArray(value, max, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) fail('INVALID_COMMAND', `Invalid ${label}.`, 400);
  return Array.from({ length: value.length }, (_, i) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) fail('INVALID_COMMAND', `Invalid ${label}.`, 400);
    return descriptor.value;
  });
}
