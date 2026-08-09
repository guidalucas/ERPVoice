export type BusinessCategoryId =
  | 'indumentaria'
  | 'calzado'
  | 'ferreteria'
  | 'electronica'
  | 'kiosco'
  | 'general';

export interface BusinessCategoryPreset {
  id: BusinessCategoryId;
  label: string;
  icon: string;
  productTypeLabel: string;
  productModelLabel: string;
  variantLabel: string | null;
  useVariants: boolean;
}

/** Keywords users may say for the `size` field (normalized without accents). */
export const VARIANT_KEYWORD_ALT = 'talle|talles|numero|numeros|nro|num|medida|medidas|variante|variantes';

export const getVariantWord = (preset: BusinessCategoryPreset): string =>
  preset.variantLabel?.trim().toLowerCase() || 'variante';

export const formatVariantRef = (preset: BusinessCategoryPreset, size: string): string =>
  `${getVariantWord(preset)} ${String(size).trim()}`;

export const BUSINESS_CATEGORIES: BusinessCategoryPreset[] = [
  {
    id: 'indumentaria',
    label: 'Indumentaria / Ropa',
    icon: '👕',
    productTypeLabel: 'Tipo de prenda',
    productModelLabel: 'Modelo',
    variantLabel: 'Talle',
    useVariants: true,
  },
  {
    id: 'calzado',
    label: 'Calzado',
    icon: '👟',
    productTypeLabel: 'Tipo de calzado',
    productModelLabel: 'Modelo',
    variantLabel: 'Número',
    useVariants: true,
  },
  {
    id: 'ferreteria',
    label: 'Ferretería',
    icon: '🔧',
    productTypeLabel: 'Rubro',
    productModelLabel: 'Modelo / Marca',
    variantLabel: 'Medida',
    useVariants: true,
  },
  {
    id: 'electronica',
    label: 'Electrónica / Tecnología',
    icon: '📱',
    productTypeLabel: 'Categoría',
    productModelLabel: 'Modelo',
    variantLabel: 'Variante',
    useVariants: true,
  },
  {
    id: 'kiosco',
    label: 'Kiosco / Almacén',
    icon: '🛒',
    productTypeLabel: 'Categoría',
    productModelLabel: 'Marca',
    variantLabel: null,
    useVariants: false,
  },
  {
    id: 'general',
    label: 'General / Otro rubro',
    icon: '🏪',
    productTypeLabel: 'Categoría',
    productModelLabel: 'Modelo',
    variantLabel: null,
    useVariants: false,
  },
];

export const isBusinessCategoryId = (value: string | null | undefined): value is BusinessCategoryId =>
  BUSINESS_CATEGORIES.some((category) => category.id === value);

export const getBusinessCategoryPreset = (id: string | null | undefined): BusinessCategoryPreset =>
  BUSINESS_CATEGORIES.find((category) => category.id === id) ??
  BUSINESS_CATEGORIES.find((category) => category.id === 'general')!;
