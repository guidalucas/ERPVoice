export const normalizePhone = (value: string) => String(value ?? '').replace(/\D/g, '').trim();

export const getWhatsAppVariants = (canonicalPhone: string) => {
  const raw = normalizePhone(canonicalPhone);

  if (!raw) {
    return [];
  }

  const variants = [raw];
  let localNumber: string | null = null;

  if (raw.startsWith('549')) {
    localNumber = raw.slice(3);
    variants.push(`54${localNumber}`);
  } else if (raw.startsWith('54') && raw.length > 2 && raw[2] !== '9') {
    localNumber = raw.slice(2);
    variants.push(`549${localNumber}`);
  }

  if (!localNumber && raw.length >= 10) {
    localNumber = raw;
  }

  if (localNumber) {
    variants.push(`54${localNumber}`);
    variants.push(`549${localNumber}`);
  }

  return [...new Set(variants)];
};