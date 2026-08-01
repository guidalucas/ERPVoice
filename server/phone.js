export const normalizePhone = (value) => {
  const raw = String(value ?? '').replace(/\D/g, '').trim();

  if (!raw) {
    return '';
  }

  // Argentina: 54 + (9?) + 10 digits
  if (raw.startsWith('54')) {
    // Si tiene 12 dígitos y empieza con 54, es probable que le falte el 9 (móvil)
    // 54 + 10 dígitos = 12. En WhatsApp los móviles de Argentina siempre llevan 9.
    if (raw.length === 12 && raw[2] !== '9') {
      return '549' + raw.slice(2);
    }
    return raw;
  }

  // Si tiene 10 dígitos, asumimos que es un número local de Argentina (característica + número)
  // y lo convertimos al formato canónico de WhatsApp (549 + 10 dígitos)
  if (raw.length === 10) {
    return '549' + raw;
  }

  return raw;
};


export const getWhatsAppVariants = (canonicalPhone) => {
  const raw = normalizePhone(canonicalPhone);

  if (!raw) {
    return [];
  }

  const variants = [raw];
  let localNumber = null;

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