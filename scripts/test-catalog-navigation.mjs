import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { createCatalogAssetHandler } from '../server/catalog/staticAssets.js';
import { renderCatalogList, renderCatalogProduct } from '../server/catalog/render.js';
import { catalogThemeCss, defaultAppearance } from '../src/shared/catalogAppearance.js';

// Deterministic navigation tests, without an inventory database or external requests.
const catalog = { slug: 'navigation-test', brandName: 'Navigation fixture', path: '/c/navigation-test', salesWhatsapp: '59899000088', appearance: defaultAppearance };
const products = Array.from({ length: 24 }, (_, index) => ({ slug: `item-${index}`, title: `Product ${index}`, path: `${catalog.path}/p/item-${index}`, description: '',
  available: true, category: 'Fixture', photos: [], sizes: [{ size: 'M', available: true, price: { amountMinor: '10000', currency: 'ARS', fractionDigits: 2 } }],
  priceRange: { minAmountMinor: '10000', maxAmountMinor: '10000', currency: 'ARS', fractionDigits: 2 } }));
const app = express();
for (const name of ['catalog.css', 'templates.css', 'catalog.js']) app.get(`/catalog-assets/${name}`, createCatalogAssetHandler(name));
app.get('/catalog-assets/:shop/theme.css', (_req, res) => res.type('css').send(catalogThemeCss(defaultAppearance)));
app.get(catalog.path, (req, res) => res.type('html').send(renderCatalogList({ catalog, items: products, facets: {} }, req.query)));
app.get(`${catalog.path}/p/:slug`, (req, res) => res.type('html').send(renderCatalogProduct({ catalog, product: products.find(item => item.slug === req.params.slug) })));
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const errors = [], pages = []; page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname === catalog.path) pages.push(request.url()); });
    await page.goto(base + catalog.path);
    const beforeAnchor = pages.length;
    await page.locator('[data-hero-block=button]').click();
    await page.waitForURL('**#coleccion'); await page.waitForTimeout(450);
    assert.ok(await page.evaluate(() => scrollY > 100), 'Hero CTA must leave the collection in view');
    assert.equal(pages.length, beforeAnchor, 'Hash navigation must not fetch and rebuild the document');
    await page.goBack(); await page.waitForTimeout(100);
    assert.equal(pages.length, beforeAnchor, 'Back within document hashes must not fetch');
    await page.locator('.catalog-card > a').first().click();
    await page.locator('.public-product-heading').waitFor();
    await page.locator('a.back').click();
    await page.locator('.catalog-card').first().waitFor();
    await page.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('PASS desktop/mobile native hash links, hash history and product/back navigation');
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
