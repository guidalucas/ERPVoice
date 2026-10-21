import { createHash } from 'node:crypto';
import { record, text } from './validation.js';
import { fail } from './errors.js';

export const identityFields = ['teamKey', 'season', 'kitKey', 'versionKey', 'sleeveKey'];
const choice = (value, choices, field) => {
  if (!choices.includes(value)) fail('INVALID_COMMAND', `Invalid ${field}.`, 400);
  return value;
};
export function normalizeCommercialProduct(input) {
  const data = record(input, ['title', 'description', 'teamKey', 'teamName', 'teamKind', 'season', 'kitKey', 'versionKey', 'sleeveKey']);
  const result = { title: text(data.title, 120, 'title'), description: text(data.description ?? '', 4000, 'description', { empty: true }) };
  for (const field of [...identityFields, 'teamName', 'teamKind']) {
    const value = data[field];
    result[field] = value == null || value === '' ? null : text(value, field === 'teamName' ? 100 : 80, field);
  }
  if (result.teamKey && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.teamKey)) fail('INVALID_COMMAND', 'Invalid team key.', 400);
  if (result.season && !/^\d{4}(?:\/\d{2}(?:\d{2})?)?$/.test(result.season)) fail('INVALID_COMMAND', 'Invalid season.', 400);
  if (result.teamKind) choice(result.teamKind, ['club', 'national_team'], 'team kind');
  if (result.kitKey) choice(result.kitKey, ['home', 'away', 'third', 'goalkeeper', 'special'], 'kit');
  if (result.versionKey) choice(result.versionKey, ['fan', 'player'], 'version');
  if (result.sleeveKey) choice(result.sleeveKey, ['short', 'long', 'sleeveless'], 'sleeve');
  return result;
}
export function commercialIdentityKey(product) {
  if (identityFields.some(field => !product[field])) return null;
  return createHash('sha256').update(JSON.stringify(identityFields.map(field => product[field]))).digest('hex');
}
export function commercialSlug(title, id) {
  const base = title.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'camiseta';
  return `${base}-${id.replaceAll('-', '').slice(0, 10)}`;
}
