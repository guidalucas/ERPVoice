export const normalizePhone = (value) => String(value ?? '').replace(/\D/g, '').trim();

export const getWhatsAppVariants = (canonicalPhone) => {
  const raw = normalizePhone(canonicalPhone);

  if (!raw) {
    return [];
  }

  const variants = [raw];

  if (raw.startsWith('549')) {
    variants.push(`54${raw.slice(3)}`);
  } else if (raw.startsWith('54') && raw.length > 2 && raw[2] !== '9') {
    variants.push(`549${raw.slice(2)}`);
  }

  return [...new Set(variants)];
};