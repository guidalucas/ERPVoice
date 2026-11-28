// Read-only equivalences for catalog filters. SKU labels, IDs and stock stay intact.
export const catalogSizeGroups = Object.freeze([
  { label: '3XS', aliases: ['3XS', 'XXXS'] },
  { label: 'XXS', aliases: ['XXS', '2XS'] },
  { label: 'XS', aliases: ['XS'] },
  { label: 'S', aliases: ['S'] },
  { label: 'M', aliases: ['M'] },
  { label: 'L', aliases: ['L'] },
  { label: 'XL', aliases: ['XL', '1XL'] },
  { label: 'XXL', aliases: ['XXL', '2XL'] },
  ...Array.from({ length: 7 }, (_, index) => {
    const count = index + 3;
    return { label: `${count}XL`, aliases: [`${count}XL`, `${'X'.repeat(count)}L`] };
  }),
]);
const aliases = new Map(catalogSizeGroups.flatMap(group => group.aliases.map(alias => [alias, group.label])));
const ranks = new Map(catalogSizeGroups.map((group, index) => [group.label, index]));
export function normalizeCatalogSize(value) {
  const label = String(value ?? '').normalize('NFC').trim();
  return aliases.get(label.toLocaleUpperCase('es').replace(/[\s-]+/g, '')) ?? label;
}
export function sortCatalogSizes(values) {
  return [...new Set(values.map(normalizeCatalogSize).filter(Boolean))].sort((a, b) =>
    (ranks.get(a) ?? 100) - (ranks.get(b) ?? 100) || a.localeCompare(b, 'es', { numeric: true }));
}
