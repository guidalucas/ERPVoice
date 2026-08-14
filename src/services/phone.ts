export const normalizePhone = (value: string) => String(value ?? '').replace(/\D/g, '').trim();

export const formatPhoneDisplay = (phoneNumber: string): string => {
  const digits = phoneNumber.replace(/\D/g, '');

  if (digits.length === 13 && digits.startsWith('549')) {
    const area = digits.slice(3, 5);
    const local = digits.slice(5);
    return `+54 9 ${area} ${local.slice(0, 4)}-${local.slice(4)}`;
  }

  if (digits.length === 12 && digits.startsWith('54')) {
    const area = digits.slice(2, 4);
    const local = digits.slice(4);
    return `+54 ${area} ${local.slice(0, 4)}-${local.slice(4)}`;
  }

  if (digits.length === 13 && digits.startsWith('54')) {
    const area = digits.slice(2, 4);
    const local = digits.slice(4);
    return `+54 ${area} ${local.slice(0, 4)}-${local.slice(4)}`;
  }

  if (digits.length >= 10) {
    return `+${digits.slice(0, digits.length - 10)} ${digits.slice(-10, -6)} ${digits.slice(-6, -4)}-${digits.slice(-4)}`.trim();
  }

  return phoneNumber;
};

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