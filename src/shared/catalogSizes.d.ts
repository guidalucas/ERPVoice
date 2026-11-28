export const catalogSizeGroups: readonly { label: string; aliases: string[] }[];
export function normalizeCatalogSize(value: string): string;
export function sortCatalogSizes(values: string[]): string[];
