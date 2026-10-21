import { record, integer, text } from './validation.js';
import { fail } from './errors.js';

export function normalizePromotion(input) {
  const data = record(input, ['percentage', 'startsAt', 'endsAt', 'timeZone', 'label']);
  const percentage = integer(data.percentage, 1);
  if (percentage > 90) fail('PROMOTION_INVALID', 'El descuento debe estar entre 1% y 90%.', 400);
  const startsAt = Date.parse(text(data.startsAt, 40, 'promotion start')), endsAt = Date.parse(text(data.endsAt, 40, 'promotion end'));
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt || endsAt - startsAt > 30 * 86_400_000) fail('PROMOTION_INVALID', 'Revisá las fechas: la promoción puede durar hasta 30 días.', 400);
  const timeZone = text(data.timeZone ?? 'UTC', 80, 'promotion time zone');
  try { new Intl.DateTimeFormat('es', { timeZone }).format(new Date()); } catch { fail('PROMOTION_INVALID', 'Zona horaria de promoción inválida.', 400); }
  return { percentage, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), timeZone,
    label: text(data.label ?? 'PROMO FULLMATCH', 40, 'promotion label') };
}
export function requireActivePromotion(promotion, now = Date.now()) {
  if (now < Date.parse(promotion.startsAt) || now >= Date.parse(promotion.endsAt)) fail('PROMOTION_NOT_ACTIVE', 'La promoción no está vigente. Revisá sus fechas.', 422);
}
/** Round half up in minor units; inventory money is never changed. */
export function promotionalAmount(amountMinor, percentage) {
  integer(percentage, 1);
  if (percentage > 90 || typeof amountMinor !== 'string' || !/^[0-9]{1,30}$/.test(amountMinor)) fail('PROMOTION_INVALID', 'Importe promocional inválido.', 400);
  const amount = (BigInt(amountMinor) * BigInt(100 - percentage) + 50n) / 100n;
  if (amount <= 0n) fail('PROMOTION_PRICE_TOO_LOW', 'El descuento dejaría un precio demasiado bajo.', 422);
  return amount.toString();
}
