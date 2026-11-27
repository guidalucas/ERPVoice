import test from 'node:test';
import assert from 'node:assert/strict';
import { salesWhatsapp } from '../server/commerce/salesWhatsapp.js';
import { publicProductSlug } from '../server/commerce/productIdentity.js';
import { catalogIdentity } from '../server/commerce/catalogIdentity.js';
import { normalizeAppearance, defaultAppearance } from '../server/commerce/appearance.js';
import { renderCatalogList } from '../server/catalog/render.js';

test('sales contact repairs national Argentine mobiles only with Argentine country context', () => {
  for (const phone of ['3454326660', '543454326660', '+54 (345) 432-6660', '5493454326660']) assert.equal(salesWhatsapp(phone, '5491100000000'), '5493454326660');
  assert.equal(salesWhatsapp('+54 9 345 4326660', '59899000088'), '5493454326660');
  assert.equal(salesWhatsapp('59899000088', '59899000088'), '59899000088');
  for (const value of ['3454326660', 'javascript:alert(1)', '5493454326660?text=bad', '', null, {}, '00000000000']) assert.equal(salesWhatsapp(value, '59899000088'), null);
});

test('live public links keep a stable product suffix and clean renamed titles', () => {
  const product = { id: '13ba4cbd-b500-4000-8000-000000000000', slug: 'argentina-2025-13ba4cbdb5', title: 'Argentina suplente 2026' };
  assert.equal(publicProductSlug(product), 'argentina-suplente-2026-13ba4cbdb5');
  assert.equal(publicProductSlug({ ...product, title: 'Buzo Boca Juniors retro' }), 'buzo-boca-juniors-retro-13ba4cbdb5');
});

test('Nacional and Retro supply useful filters, including retro player editions', () => {
  const resolve = name => catalogIdentity({}, [{ name, active: true }]);
  assert.equal(resolve('Camiseta Selección Argentina - Homenaje a Messi - Versión Nacional').versionKey, 'national');
  assert.deepEqual(resolve('Buzo Boca Juniors retro').versionKeys, ['retro']);
  assert.deepEqual(resolve('Camiseta Inglaterra retro, mangas largas, versión jugador').versionKeys, ['player', 'retro']);
  assert.equal(resolve('Taladro Retro').versionKey, null);
});

test('store information and merchandising stay optional, validated and escaped', () => {
  const appearance = normalizeAppearance({ ...defaultAppearance, storeInfo: { address: '<img src=x>', instagram: '@fmcasacas', payments: 'Todos los medios de pago' }, featuredSlugs: ['camiseta'], promotionSlugs: [] });
  assert.equal(appearance.storeInfo.instagram, 'fmcasacas');
  for (const patch of [{ storeInfo: { instagram: 'https://bad.example' } }, { storeInfo: { extra: 'private' } }, { featuredSlugs: ['bad?url'] }, { promotionSlugs: ['same', 'same'] }]) assert.throws(() => normalizeAppearance({ ...defaultAppearance, ...patch }));
  const html = renderCatalogList({ catalog: { slug: 'tienda', path: '/c/tienda', brandName: 'Tienda', salesWhatsapp: '5493454326660', appearance }, items: [], facets: { variants: ['M'], variantLabel: 'Talle' } }, {}, '');
  assert.match(html, /Todos los talles/); assert.match(html, /name="sort"/);
  assert.match(html, /https:\/\/www.instagram.com\/fmcasacas\//); assert.match(html, /&lt;img src=x&gt;/); assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /Versión jugador e hincha/); assert.doesNotMatch(html, />Pedidos ↗</);
});
