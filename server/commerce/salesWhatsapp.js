// National numbers need an explicit country context; never guess from currency.
export function salesWhatsapp(value, ownerPhone = '') {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 32 || !/^\+?[\d\s().-]+$/.test(value)) return null;
  let digits = value.replace(/\D/g, '');
  if (String(ownerPhone).startsWith('54') && /^\d{10}$/.test(digits)) digits = `549${digits}`;
  else if (/^54\d{10}$/.test(digits)) digits = `549${digits.slice(2)}`;
  return /^[1-9]\d{10,14}$/.test(digits) ? digits : null;
}
