import { createHash } from 'node:crypto';
const stable = (value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : Array.isArray(value) ? value.map(stable) : value;
export const operationRequestDigest = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
