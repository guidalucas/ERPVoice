import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommercialReadiness } from '../server/commerce/readiness.js';
import { inventoryProductFingerprint } from '../server/inventoryOperations.js';
import { normalizeAppearance, defaultAppearance, textOnColor } from '../server/commerce/appearance.js';
import { commercialSpecifications } from '../server/commerce/presentation.js';
import { publicProductProjection } from '../server/commerce/catalogService.js';
import { renderCatalogList, renderCatalogProduct } from '../server/catalog/render.js';
import { catalogThemeCss, defaultHeroLayout } from '../src/shared/catalogAppearance.js';

const policy = { currency: 'UYU', storageUnit: 'major_integer', fractionDigits: 2, revision: 1 };
const sku = patch => { const item = { id: 'fixture', name: 'Producto', size: null, unit: 'unit', status: 'active', revision: 1, attributes: {}, price: 150, priceCurrency: 'UYU', stockAvailable: 2, stockReserved: 0, ...patch }; return { ...item, linkFingerprint: inventoryProductFingerprint(item) }; };
test('optional presets preserve all existing brand fields and reject unsafe tokens', () => {
  for (const preset of ['classic', 'editorial', 'technical', 'local']) assert.deepEqual(normalizeAppearance({ ...defaultAppearance, preset }), { preset, ...defaultAppearance });
  assert.deepEqual(normalizeAppearance(defaultAppearance), defaultAppearance);
  assert.throws(() => normalizeAppearance({ ...defaultAppearance, preset: 'red;body{}' }));
  for (const color of ['#ffffff', '#000000', '#ffff00', '#123456']) assert.ok(['#000000', '#FFFFFF'].includes(textOnColor(color)));
});
test('banner copy is optional and layout positions are validated before saving', () => {
  const appearance = { ...defaultAppearance, tagline: '', heroTitle: '', heroDescription: '', heroContentVisible: false, heroButtonVisible: false, heroLayout: structuredClone(defaultHeroLayout) };
  assert.deepEqual(normalizeAppearance(appearance), appearance);
  assert.equal(normalizeAppearance({ ...defaultAppearance, heroLayout: null }).heroLayout, null);
  assert.throws(() => normalizeAppearance({ ...defaultAppearance, collectionTitle: '' }));
  for (const field of ['heroContentVisible', 'heroButtonVisible']) for (const bad of [null, 0, 'false']) assert.throws(() => normalizeAppearance({ ...appearance, [field]: bad }));
  for (const bad of [null, {}, { x: -1, y: 50, width: 50 }, { x: 101, y: 50, width: 50 }, { x: 1.5, y: 0, width: 50 }, { x: 50, y: 50, width: 19 }, { x: 50, y: '0; color:red', width: 50 }])
    assert.throws(() => normalizeAppearance({ ...appearance, heroLayout: { ...defaultHeroLayout, title: bad } }));
  assert.throws(() => normalizeAppearance({ ...appearance, heroLayout: { ...defaultHeroLayout, other: {} } }));
  assert.match(catalogThemeCss(appearance), /data-hero-block="title"\]\{left:8%;top:30%;width:65%/);
  assert.doesNotMatch(catalogThemeCss({ ...appearance, heroLayout: { title: { x: 'red;body{}' } } }), /red;body/);
});
test('public banners can show only an image, omit empty copy, and keep movable text escaped', () => {
  const catalog = { slug: 'tienda', path: '/c/tienda', brandName: 'Tienda', appearance: { ...defaultAppearance, coverId: 'cover', heroContentVisible: false } };
  const hero = appearance => renderCatalogList({ catalog: { ...catalog, appearance }, items: [] }, {}, '').match(/<section aria-label="Portada del catálogo"[\s\S]*?<\/section>/)[0];
  const imageOnly = hero(catalog.appearance);
  assert.match(imageOnly, /image-only/); assert.match(imageOnly, /catalog-cover/); assert.doesNotMatch(imageOnly, /hero-copy|<h1|Explorar catálogo/);
  const blank = hero({ ...defaultAppearance, tagline: '', heroTitle: '', heroDescription: '', heroButtonVisible: false });
  assert.match(blank, /image-only/); assert.doesNotMatch(blank, /<h1|<p|<a /);
  const custom = hero({ ...defaultAppearance, heroTitle: '<script>alert(1)</script>', heroLayout: defaultHeroLayout, heroButtonVisible: false });
  assert.match(custom, /custom-layout/); assert.match(custom, /data-hero-block="title"/); assert.match(custom, /&lt;script&gt;/); assert.doesNotMatch(custom, /<script>|data-hero-block="button"/);
});
test('universal readiness permits no size, non-unit sales and no photo; stories still need a photo', () => {
  for (const unit of ['unit', 'kg', 'm', 'pack']) {
    const item = sku({ unit }), before = structuredClone(item);
    const result = buildCommercialReadiness({ title: 'Producto', status: 'ready' }, [item], [], policy);
    assert.equal(result.readiness.canPrepare, true); assert.equal(result.readiness.canGenerateStory, false);
    assert.equal(result.variants[0].label, 'Producto'); assert.equal(result.variants[0].unit, unit); assert.deepEqual(item, before);
  }
});
test('inventory, price and identity checks still block unsafe publication', () => {
  for (const [patch, code] of [[{ stockAvailable: -1 }, 'INVENTORY_INVALID'], [{ priceCurrency: 'XXX' }, 'MONEY_UNCONFIRMED'], [{ price: 0 }, 'PRICE_NOT_READY'], [{ linkFingerprint: 'changed' }, 'SKU_IDENTITY_CHANGED']]) {
    const item = { ...sku(), ...patch };
    assert.ok(buildCommercialReadiness({ title: 'Producto', status: 'ready' }, [item], [], policy).readiness.blockers.includes(code));
  }
  assert.ok(buildCommercialReadiness({ title: 'Producto' }, [sku(), sku({ id: 'other' })], [], policy).readiness.blockers.includes('DUPLICATE_SIZE'));
});
test('only known, explicitly public specifications leave the inventory boundary', () => {
  assert.deepEqual(commercialSpecifications({ potencia: { state: 'known', type: 'number', value: 650, unit: 'w' }, proveedor: { state: 'known', type: 'text', value: 'privado' }, color: { state: 'unknown', type: 'text' } }), [{ label: 'potencia', value: '650 w' }]);
});
test('public pages render generic products without photos or football fields, escaping content', () => {
  const detail = { title: 'Taladro <seguro>', status: 'ready', slug: 'taladro', images: [], ...buildCommercialReadiness({ title: 'Taladro', status: 'ready' }, [sku({ productType: 'Herramientas' })], [], policy) };
  const product = publicProductProjection(detail, 'ferreteria'), catalog = { slug: 'ferreteria', brandName: 'Ferretería', path: '/c/ferreteria', appearance: { ...defaultAppearance, preset: 'technical' } };
  const html = renderCatalogList({ catalog, items: [product], facets: { categories: ['Herramientas'], variants: ['Producto'] } }, {}, '');
  assert.match(html, /data-preset="technical"/); assert.match(html, /Taladro &lt;seguro&gt;/); assert.match(html, /Sin fotografía/);
  assert.doesNotMatch(html, /Todos los equipos|Todas las versiones|undefined/);
  const page = renderCatalogProduct({ catalog, product }, ''); assert.match(page, /Presentación para tu consulta/); assert.doesNotMatch(page, /Talles|VERSIÓN HINCHA|undefined/);
});
