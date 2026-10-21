import type { Appearance } from '../../src/shared/catalogAppearance.js';
export function renderCatalogList(data: {
  catalog: { slug: string; brandName: string; path: string; appearance: Appearance; salesWhatsapp?: string | null };
  items: { title: string; path: string; available: boolean; category?: string; photos: { thumbnailUrl: string; url: string; alt: string }[];
    sizes: { size: string; available: boolean }[]; priceRange: null }[];
  facets?: { categories?: string[] };
}, query: Record<string, string>, origin?: string): string;
