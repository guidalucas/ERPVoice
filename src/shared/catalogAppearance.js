// Pure presentation helpers shared by Studio previews and the public catalog.
// Keep stored IDs stable so existing stores retain their selected template.
export const catalogDesigns = Object.freeze([
  { id: 'classic', name: 'Esencial', description: 'Portada panorámica, líneas limpias y una grilla abierta de productos.' },
  { id: 'editorial', name: 'Editorial', description: 'Marca centrada, portada inmersiva y fotografías de gran formato.' },
  { id: 'technical', name: 'Megatienda', description: 'Buscador en la cabecera, filtros laterales y un catálogo compacto.' },
  { id: 'local', name: 'Boutique', description: 'Portada dividida, categorías visuales y productos en fichas horizontales.' },
]);
export const defaultAppearance = Object.freeze({ logoId: null, coverId: null, primaryColor: '#001A4D', accentColor: '#FF6A00',
  tagline: 'Productos con identidad', heroTitle: 'Conocé nuestros productos',
  heroDescription: 'Explorá el catálogo y consultanos por WhatsApp.', collectionTitle: 'Nuestro catálogo' });
export const appearanceOf = profile => ({ ...defaultAppearance, ...profile?.appearance });
export const textOnColor = hex => {
  const rgb = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 0.179 ? '#000000' : '#FFFFFF';
};
export const defaultHeroLayout = Object.freeze({
  tagline: { x: 8, y: 8, width: 65 }, title: { x: 8, y: 30, width: 65 },
  description: { x: 8, y: 65, width: 60 }, button: { x: 8, y: 94, width: 35 },
});
export function catalogThemeCss(appearance) {
  const primary = /^#[0-9a-f]{6}$/i.test(appearance.primaryColor) ? appearance.primaryColor : '#001A4D';
  const accent = /^#[0-9a-f]{6}$/i.test(appearance.accentColor) ? appearance.accentColor : '#FF6A00';
  const positions = appearance.heroLayout ? Object.entries(defaultHeroLayout).map(([key, fallback]) => {
    const block = appearance.heroLayout[key] ?? fallback;
    const safe = (value, min, max, defaultValue) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : defaultValue;
    const x = safe(block.x, 0, 100, fallback.x), y = safe(block.y, 0, 100, fallback.y), width = safe(block.width, 20, 100, fallback.width);
    return `.catalog-hero [data-hero-block="${key}"]{left:${x}%;top:${y}%;width:${width}%;transform:translate(-${x}%,-${y}%)}`;
  }).join('') : '';
  return `:root{--navy:${primary};--orange:${accent};--hero-ink:${textOnColor(primary)};--accent-ink:${textOnColor(accent)}}@media(min-width:781px){${positions}}`;
}
