const GARMENT = /^(camisetas?|remeras?|buzos?|shorts?|pantalones?|camperas?)\s+(?:de(?:l)?\s+)?(.+)$/i;
const SIZES = /(?:\s+|,\s*)(?:(?:talle|talla)\s+)?(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL)$/i;

const title = (value) => String(value ?? '').trim().split(/\s+/).map((word) =>
  word ? word[0].toUpperCase() + word.slice(1) : '',
).join(' ');

export const parseGarmentName = (value) => {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  const match = raw.match(GARMENT);
  if (!match) return null;

  const sizeMatch = match[2].match(SIZES);
  const model = sizeMatch ? match[2].slice(0, -sizeMatch[0].length).trim() : match[2].trim();
  if (!model) return null;
  const type = match[1].toLowerCase();
  const productType = type.startsWith('camiseta') ? 'Camiseta'
    : type.startsWith('remera') ? 'Remera'
      : type.startsWith('buzo') ? 'Buzo'
        : type.startsWith('short') ? 'Short'
          : type.startsWith('pantalon') ? 'Pantalón' : 'Campera';
  return { productType, productModel: title(model), size: sizeMatch?.[1].toUpperCase() };
};

// Compatibility for clothing records created before type/model were separated.
export const normalizeProductMetadata = (input) => {
  const fromType = parseGarmentName(input?.productType);
  const fromName = parseGarmentName(input?.productName ?? input?.name);
  const parsed = fromType ?? fromName;
  if (!parsed) return input;

  const rawType = String(input?.productType ?? '').trim();
  const rawModel = String(input?.productModel ?? '').trim();
  const size = String(input?.size ?? parsed.size ?? '').trim().toUpperCase();
  return {
    ...input,
    productType: fromType || !rawType ? parsed.productType : rawType,
    productModel: rawModel || parsed.productModel,
    size: size || undefined,
  };
};

export const productBaseName = (input) => {
  const product = normalizeProductMetadata(input);
  const type = String(product?.productType ?? '').trim();
  const model = String(product?.productModel ?? '').trim();
  const name = String(product?.productName ?? product?.name ?? '').trim();
  let useName = !type || !model;
  // Extractors may put only the variant ("titular") in productModel while the
  // productName contains the team and season. Never discard that identity.
  if (type && model && name) {
    const words = (value) => value.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .split(/[^a-z0-9]+/).filter((word) => word && !['de', 'del', 'la', 'el', 'en'].includes(word));
    const nameWords = new Set(words(name).filter((word) => word !== type.toLowerCase()));
    const modelWords = words(model);
    if (modelWords.length && modelWords.every((word) => nameWords.has(word))) useName = true;
    else if (nameWords.size && ![...nameWords].every((word) => modelWords.includes(word))) useName = true;
  }
  if (!useName) return `${type} ${model}`;
  const size = String(product?.size ?? '').trim();
  if (!size) return name;
  const escaped = size.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return name.replace(new RegExp(`(?:[,\\s]+(?:talle|talla|numero|número|nro|num|medida|variante)?\\s*)${escaped}$`, 'i'), '').trim();
};

export const productMatchKey = (input) => {
  const product = normalizeProductMetadata(input);
  const baseName = productBaseName(product);
  if (!baseName) return null;
  const normalized = baseName
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
  const words = normalized.split(/[^a-z0-9]+/).filter((word) =>
    word && !['de', 'del', 'la', 'el', 'en', 'con', 'para', 'modelo', 'marca', 'version',
      'talle', 'talla', 'numero', 'nro', 'num', 'medida', 'variante'].includes(word),
  );
  return [...new Set(words)].sort().join(' ') || null;
};
