import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePromotion, promotionalAmount, requireActivePromotion } from '../server/commerce/promotions.js';
const input = { percentage: 15, startsAt: '2026-10-20T00:00:00Z', endsAt: '2026-10-21T00:00:00Z', timeZone: 'America/Montevideo', label: 'PROMO FULLMATCH' };
test('promotional values use exact minor-unit half-up rounding without floating point', () => {
  assert.equal(promotionalAmount('6500000', 15), '5525000');
  assert.equal(promotionalAmount('101', 50), '51');
  assert.equal(promotionalAmount('900719925474099100', 10), '810647932926689190');
  assert.throws(() => promotionalAmount('1', 90), { code: 'PROMOTION_PRICE_TOO_LOW' });
});
test('promotion intervals use explicit instants and reject invalid ranges/time zones', () => {
  const promotion = normalizePromotion(input);
  assert.doesNotThrow(() => requireActivePromotion(promotion, Date.parse('2026-10-20T12:00:00Z')));
  assert.throws(() => requireActivePromotion(promotion, Date.parse(input.endsAt)), { code: 'PROMOTION_NOT_ACTIVE' });
  assert.throws(() => normalizePromotion({ ...input, endsAt: input.startsAt }), { code: 'PROMOTION_INVALID' });
  assert.throws(() => normalizePromotion({ ...input, timeZone: 'not-a-zone' }), { code: 'PROMOTION_INVALID' });
  for (const percentage of [0, -1, 1.5, 91, NaN, '15']) assert.throws(() => normalizePromotion({ ...input, percentage }));
});
