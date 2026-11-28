import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatalogSize, sortCatalogSizes } from '../src/shared/catalogSizes.js';
import { renderCatalogList, renderCatalogProduct } from '../server/catalog/render.js';

test('catalog sizes use one ordered label for equivalent spellings and preserve other presentations', () => {
  assert.deepEqual(sortCatalogSizes(['2XL', '3XL', '4XL', 'L', 'M', 'S', 'XL', 'XXL']), ['S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL']);
  assert.deepEqual(sortCatalogSizes(['XXXXL', 'xxxl', ' 2 xl ', 'XXL', 'XS', 'S', '2XS', 'XXXS']), ['3XS', 'XXS', 'XS', 'S', 'XXL', '3XL', '4XL']);
  assert.deepEqual(sortCatalogSizes(['40', '38', '42', '36']), ['36', '38', '40', '42']);
  for (const value of ['Pack de 2 unidades', 'Botella 1 L', 'Presentación especial', 'M/L', 'Único']) assert.equal(normalizeCatalogSize(value), value);
});

const origin = 'https://shop.example', catalog = { slug: 'tienda', path: '/c/tienda', brandName: 'Marca <segura>', appearance: { coverId: 'cover', logoId: 'logo' } };
const product = { title: 'Remera', slug: 'remera', path: '/c/tienda/p/remera', photos: [], sizes: [], available: false, description: '', priceRange: null };
const image = html => html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
test('catalog sharing prioritizes brand artwork even for empty results and a first product with no photo', () => {
  for (const items of [[], [product]]) {
    const html = renderCatalogList({ catalog, items }, {}, origin);
    assert.equal(image(html), origin + '/api/catalog/v1/tienda/brand-assets/cover');
    assert.match(html, /og:image:alt/); assert.match(html, /og:image:secure_url/);
    assert.doesNotMatch(html, /content="Marca <segura>/);
  }
  const logoCatalog = { ...catalog, appearance: { logoId: 'logo' } };
  assert.equal(image(renderCatalogList({ catalog: logoCatalog, items: [] }, { q: 'nothing' }, origin)), origin + '/api/catalog/v1/tienda/brand-assets/logo');
  const photographed = { ...product, photos: [{ url: '/photo.jpg', thumbnailUrl: '/thumb.jpg', alt: '' }] };
  assert.equal(image(renderCatalogList({ catalog: { ...catalog, appearance: {} }, items: [product, photographed] }, {}, origin)), origin + '/photo.jpg');
  assert.equal(image(renderCatalogProduct({ catalog, product: photographed }, origin)), origin + '/photo.jpg');
  assert.equal(image(renderCatalogProduct({ catalog, product }, origin)), origin + '/api/catalog/v1/tienda/brand-assets/cover');
});

test('legacy size URLs display the canonical option as selected', () => {
  const html = renderCatalogList({ catalog, items: [], facets: { variants: ['S', 'XXL', '3XL'], variantLabel: 'Talle' } }, { variant: '2XL' }, origin);
  assert.match(html, /<option value="XXL" selected>XXL<\/option>/);
  assert.doesNotMatch(html, /<option value="2XL"/);
});
