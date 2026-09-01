export const BUSINESS_CATEGORIES = [
  {
    id: 'indumentaria',
    label: 'Indumentaria / Ropa',
    productTypeLabel: 'Tipo de prenda',
    productModelLabel: 'Modelo',
    variantLabel: 'Talle',
    useVariants: true,
  },
  {
    id: 'calzado',
    label: 'Calzado',
    productTypeLabel: 'Tipo de calzado',
    productModelLabel: 'Modelo',
    variantLabel: 'Número',
    useVariants: true,
  },
  {
    id: 'ferreteria',
    label: 'Ferretería',
    productTypeLabel: 'Rubro',
    productModelLabel: 'Modelo / Marca',
    variantLabel: 'Medida',
    useVariants: true,
  },
  {
    id: 'electronica',
    label: 'Electrónica / Tecnología',
    productTypeLabel: 'Categoría',
    productModelLabel: 'Modelo',
    variantLabel: 'Variante',
    useVariants: true,
  },
  {
    id: 'kiosco',
    label: 'Kiosco / Almacén',
    productTypeLabel: 'Categoría',
    productModelLabel: 'Marca',
    variantLabel: null,
    useVariants: false,
  },
  {
    id: 'general',
    label: 'General / Otro rubro',
    productTypeLabel: 'Categoría',
    productModelLabel: 'Modelo',
    variantLabel: null,
    useVariants: false,
  },
];

/** Keywords users may say for the `size` field across categories (normalized without accents). */
export const VARIANT_KEYWORDS = [
  'talle',
  'talles',
  'numero',
  'numeros',
  'nro',
  'num',
  'medida',
  'medidas',
  'variante',
  'variantes',
];

export const getBusinessCategoryPreset = (id) =>
  BUSINESS_CATEGORIES.find((category) => category.id === id) ??
  BUSINESS_CATEGORIES.find((category) => category.id === 'general');

export const getVariantWord = (preset) => {
  const label = preset?.variantLabel?.trim();
  if (label) {
    return label.toLowerCase();
  }
  return 'variante';
};

export const formatVariantRef = (preset, size) => {
  const value = String(size ?? '').trim();
  if (!value) {
    return '';
  }
  return `${getVariantWord(preset)} ${value}`;
};

export const formatAllVariantsScope = (preset) => {
  if (!preset?.useVariants) {
    return 'todas las presentaciones';
  }

  const word = getVariantWord(preset);
  if (word === 'talle') {
    return 'todos los talles';
  }
  if (word === 'número' || word === 'numero') {
    return 'todos los números';
  }
  if (word === 'medida') {
    return 'todas las medidas';
  }
  if (word === 'variante') {
    return 'todas las variantes';
  }

  return `todas las variantes`;
};

export const formatMissingVariantLabel = (preset) => {
  if (!preset?.useVariants) {
    return 'sin variante';
  }
  return `sin ${getVariantWord(preset)}`;
};

/**
 * Shared voice-prompt section injected per business category.
 * Keeps one base schema; only vocabulary/examples change.
 */
export const buildCategoryPromptContext = (preset) => {
  const resolved = preset ?? getBusinessCategoryPreset('general');
  const variantLine = resolved.useVariants
    ? `- Este rubro USA variantes. El campo JSON "size" representa "${resolved.variantLabel}". El usuario puede decir "${resolved.variantLabel.toLowerCase()}", talle, número, medida o variante: mapealo siempre a "size".`
    : `- Este rubro NO usa variantes tipicas. NO inventes "size". Solo completa "size" si el usuario lo pidio explicitamente como dato del producto.`;

  return `
Contexto del rubro del negocio:
- Rubro: ${resolved.label} (id: ${resolved.id})
- productType = "${resolved.productTypeLabel}"
- productModel = "${resolved.productModelLabel}"
- size / variante = ${resolved.useVariants ? `"${resolved.variantLabel}"` : 'no aplica por defecto'}
${variantLine}
- Si la frase incluye tipo, modelo y variante, separá productType, productModel y size.
- En query_stock NO pongas size salvo que el usuario pida una variante puntual.
- En query_stock de una familia (equipo, marca, tipo) usá un productModel genérico. No elijas un SKU puntual del inventario.
- update_product sin size aplica a TODAS las variantes del modelo.
- Los nombres exactos salen del inventario del negocio cuando esté disponible, no de ejemplos genéricos.
`.trim();
};

/** Regex fragment for variant keywords (with accents optional via normalize). Use on normalized text. */
export const VARIANT_KEYWORD_ALT = 'talle|talles|numero|numeros|nro|num|medida|medidas|variante|variantes';
