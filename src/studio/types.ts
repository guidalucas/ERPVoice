export type Money = { amountMinor: string; currency: string; fractionDigits: number };
export type Variant = { skuId: string; name: string; size: string; label?: string; unit?: string; productType?: string | null; specifications?: { label: string; value: string }[]; active: boolean; revision: number; identityFingerprint: string;
  identityReviewed: boolean; stockAvailable: number | null; stockReserved: number | null; price: Money | null };
export type Candidate = { label?: string; unit?: string; skuId: string; name: string; size: string; revision: number; identityFingerprint: string;
  productType?: string | null; productModel?: string | null;
  stockAvailable: number; stockReserved: number; price: Money | null };
export type Photo = { id: string; status: string; altText: string; sortOrder: number; focalX: number; focalY: number;
  revision: number; width: number | null; height: number | null; errorCode: string | null };
export type CommercialFields = { title: string; description: string; teamKey: string | null; teamName: string | null; teamKind: string | null;
  season: string | null; kitKey: string | null; versionKey: string | null; sleeveKey: string | null };
export type Product = CommercialFields & { id: string; slug: string; status: 'draft' | 'ready' | 'archived'; revision: number;
  coverImageId: string | null; images: Photo[]; variants: Variant[]; availableQuantity: number | null; availability: string;
  priceRange: { currency: string; fractionDigits: number; minAmountMinor: string; maxAmountMinor: string } | null;
  readiness: { canPrepare: boolean; canGenerateStory: boolean; blockers: string[]; missingFields?: string[]; moneyIssues?: { skuId: string; cause: string }[] }; moneyPolicyRevision: number | null; readAt: string };
export type Appearance = { preset?: 'classic' | 'editorial' | 'technical' | 'local'; logoId: string | null; coverId: string | null; primaryColor: string; accentColor: string;
  tagline: string; heroTitle: string; heroDescription: string; collectionTitle: string };
export const defaultAppearance: Appearance = { logoId: null, coverId: null, primaryColor: '#001A4D', accentColor: '#FF6A00',
  tagline: 'Productos con identidad', heroTitle: 'Conocé nuestros productos',
  heroDescription: 'Explorá el catálogo y consultanos por WhatsApp.', collectionTitle: 'Nuestro catálogo' };
export const brandInitials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase() || 'S';
export const textOnColor = (hex: string) => {
  const rgb = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 0.179 ? '#000000' : '#FFFFFF';
};
export type Profile = { brandName: string; salesWhatsapp: string | null; brandPreset: string; revision: number; appearance?: Appearance;
  moneyPolicy: { currency: string; storageUnit: string; fractionDigits: number; revision: number } | null };
export type Receipt<T> = { contractVersion: number; operationId: string; status: 'applied'; result: T };
export const moneyLabel = (money: Money | null) => {
  if (!money) return 'Moneda pendiente';
  const units = BigInt(money.amountMinor), scale = 10n ** BigInt(money.fractionDigits);
  const whole = (units / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const decimals = (units % scale).toString().padStart(money.fractionDigits, '0');
  return `${money.currency} $ ${whole}${Number(decimals) ? ',' + decimals : ''}`;
};
export const priceLabel = (product: Product) => product.priceRange ? `${product.priceRange.minAmountMinor !== product.priceRange.maxAmountMinor ? 'Desde ' : ''}${moneyLabel({
  amountMinor: product.priceRange.minAmountMinor, currency: product.priceRange.currency, fractionDigits: product.priceRange.fractionDigits })}` : 'Precio pendiente';
