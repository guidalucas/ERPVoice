// Read-only compatibility for published garments created without sports fields.
// Explicit commercial metadata wins. Never derive identity from slugs or descriptions.
const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const keyOf = value => normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const aliases = new Map([
  ['boca', ['boca', 'Boca Juniors']], ['boca juniors', ['boca', 'Boca Juniors']],
  ['river', ['river', 'River Plate']], ['river plate', ['river', 'River Plate']],
  ['seleccion argentina', ['argentina', 'Argentina']],
  ['inter de miami', ['inter-miami', 'Inter Miami']], ['inter miami', ['inter-miami', 'Inter Miami']],
]);
const knownTeams = new Set(['argentina', 'alemania', 'atletico de madrid', 'atletico mineiro', 'barcelona', 'chelsea', 'colombia', 'corinthians', 'flamengo', 'genoa', 'holanda', 'independiente', 'inglaterra', 'inter', 'italia', 'juventus', 'liverpool', 'manchester city', 'manchester united', 'milan', 'newells', 'noruega', 'porto', 'psg', 'racing', 'real madrid', 'roma', 'san lorenzo', 'santos', 'sao pablo', 'uruguay', 'velez']);
const garment = /^(camisetas?|remeras?|buzos?|camperas?|shorts?|conjuntos? de abrigo)\s+/i;
const descriptor = /\b(?:titular|suplente|tercera|tercero|cuarta|arquero|retro|version|mangas?|homenaje|prematch|edicion|color|dorsal|con dorsal)\b/;
const titleCase = value => value.split(' ').map(word => ['de', 'del'].includes(word.toLowerCase()) ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1)).join(' ');

function garmentIdentity(name, productType) {
  const original = String(name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const normalized = normalize(original), match = normalized.match(garment);
  const type = match?.[1] ?? normalize(productType);
  if (!match && !garment.test(`${type} `)) return {};
  let rest = match ? original.slice(match[0].length) : original;
  rest = rest.replace(/^(?:(?:titular|suplente|tercera(?: equipaci[oó]n)?)\s+)?(?:(?:de|del)\s+)?(?:(?:la|el)\s+)?/i, '');
  const normalizedRest = normalize(rest);
  const stop = normalizedRest.search(/(?:\b\d{4}(?:\/\d{2,4})?\b|[,;–—]|\s-\s)/);
  const qualifier = normalizedRest.search(descriptor);
  const end = Math.min(...[stop, qualifier, rest.length].filter(index => index >= 0));
  const candidate = rest.slice(0, end).replace(/[\s.,-]+$/, '').replace(/\s+(?:en|con)$/i, '').trim(), normalizedCandidate = normalize(candidate);
  const alias = aliases.get(normalizedCandidate);
  const version = normalized.match(/\bversion\s+(jugador|player|hincha|fan)\b/)?.[1];
  const category = /^camiseta/.test(type) ? 'Camiseta' : /^remera/.test(type) ? 'Remera' : /^buzo/.test(type) ? 'Buzo'
    : /^campera/.test(type) ? 'Campera' : /^short/.test(type) ? 'Short' : 'Conjunto de abrigo';
  // Generic clothing (e.g. "Remera de algodón mangas largas") has a category,
  // but must not create team filters merely because it has garment descriptors.
  const sportsContext = /\b(?:titular|suplente|tercera|tercero|cuarta|arquero|version (?:jugador|player|hincha|fan))\b/.test(normalizedRest);
  const team = candidate && (alias || knownTeams.has(normalizedCandidate) || sportsContext)
    ? alias ?? [keyOf(candidate), titleCase(candidate)] : [];
  return { teamKey: team[0], teamName: team[1], versionKey: version ? ['jugador', 'player'].includes(version) ? 'player' : 'fan' : null, category };
}

export function catalogIdentity(product, skus = []) {
  const active = skus.filter(sku => sku.active ?? (sku.status === 'active'));
  const source = active.find(sku => sku.name?.trim());
  const inferred = garmentIdentity(source?.name || product.title, source?.productType);
  return {
    teamKey: product.teamKey || inferred.teamKey || null,
    teamName: product.teamName || (product.teamKey && product.teamKey !== inferred.teamKey ? product.teamKey : inferred.teamName) || null,
    versionKey: product.versionKey || inferred.versionKey || null,
    categories: [...new Set(active.map(sku => sku.productType?.trim() || garmentIdentity(sku.name, sku.productType).category).filter(Boolean))],
  };
}
