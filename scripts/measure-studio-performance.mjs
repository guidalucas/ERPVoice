import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { chromium, devices } from 'playwright';
import { Client } from 'pg';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: node scripts/measure-studio-performance.mjs <output.json>');
const fixture = await startCommerceFixture({ studioBuild: true });
let browser;
const rounded = ms => Math.round(ms * 10) / 10;
const sizes = { desktop: { viewport: { width: 1440, height: 900 } }, mobile: devices['Pixel 7'] };
const pages = [
  { name: 'products', button: /^01.*Productos|^Productos$/, ready: '.product-card', photo: '.card-photo img' },
  { name: 'productDetail', ready: '.editor h1', photo: '.summary-photo img', photoAnchor: '.summary-photo' },
  { name: 'library', button: /^03.*Biblioteca|^Biblioteca$/, ready: '.library-card', photo: '.library-image img' },
  { name: 'pending', button: /^02.*Pendientes|^Pendientes$/, ready: '.pending-product' },
];

async function seed() {
  const sql = new Client({ connectionString: fixture.connection });
  await sql.connect();
  try {
    const photos = (await sql.query(`SELECT commercial_product_id,id FROM commercial_product_images
      WHERE owner_phone=$1 AND status='ready' ORDER BY created_at,id`, [fixture.owner])).rows;
    for (let i = 0; i < 30; i++) {
      const photo = photos[i % photos.length], id = randomUUID(), at = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      const result = { snapshotId: id, createdAt: at, expiresAt: '2026-01-02T00:00:00.000Z',
        content: { productId: photo.commercial_product_id, imageId: photo.id, title: `Historia de prueba ${i}`,
          settings: { templateId: 'arrival' }, imageAlt: 'Foto de prueba' } };
      await sql.query(`INSERT INTO commercial_operations(owner_phone,operation_id,actor_id,operation_type,entity_id,request_hash,request_json,result_json,created_at)
        VALUES($1,$2,$1,'story.prepare',$3,repeat('0',64),'{}',$4,$5)`, [fixture.owner, id, photo.commercial_product_id, JSON.stringify({ result }), at]);
    }
    await sql.query(`INSERT INTO commercial_products(owner_phone,id,title,slug,created_by,updated_by,updated_at)
      SELECT $1,gen_random_uuid(),'Ficha de prueba '||n,'performance-'||n,$1,$1,now()-interval '1 day'
      FROM generate_series(1,24) n`, [fixture.owner]);
    await sql.query(`INSERT INTO products(id,owner_phone,name,size,stock_available,price,price_currency,inventory_unit,product_model)
      SELECT 'performance-'||g||'-'||s,$1,'Grupo de prueba '||g,s::text,5,100,'ARS','unit','Demo'
      FROM generate_series(100,199) g CROSS JOIN generate_series(1,12) s`, [fixture.owner]);
    return photos[0];
  } finally { await sql.end(); }
}

async function api(route) {
  const samples = [];
  for (let index = 0; index < 6; index++) {
    const started = performance.now();
    const response = await fetch(fixture.apiUrl + '/api/commerce/v1' + route, { headers: { Authorization: `Bearer ${fixture.token}` } });
    const ttfbMs = rounded(performance.now() - started);
    assert.equal(response.status, 200, route);
    const bytes = (await response.arrayBuffer()).byteLength;
    samples.push({ ttfbMs, totalMs: rounded(performance.now() - started), bytes });
  }
  return { first: samples[0], warm: samples.slice(1) };
}

async function measureViewport(device) {
  const context = await browser.newContext(device);
  try {
    await context.addInitScript(({ origin, token, owner }) => {
      if (location.origin !== origin) return;
      localStorage.setItem('erpvoice.auth.token', token);
      localStorage.setItem('erpvoice.auth.phoneNumber', owner);
    }, { origin: new URL(fixture.url).origin, token: fixture.token, owner: fixture.owner });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(35_000);
    page.on('pageerror', error => errors.push(error.message));
    const waitVisiblePhoto = async selector => {
      await page.waitForFunction(selector => Array.from(document.querySelectorAll(selector)).some(img => {
        const rect = img.getBoundingClientRect();
        return img.complete && img.naturalWidth && rect.bottom > 0 && rect.top < innerHeight;
      }), selector, { timeout: 15_000 });
    };
    const measure = async (scenario, action) => {
      const requests = [], failures = [];
      const record = request => {
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname.startsWith('/api/commerce/v1/')) requests.push(url.pathname + url.search);
      };
      const recordError = response => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/api/') && response.status() >= 400) failures.push([url.pathname, response.status()]);
      };
      page.on('request', record);
      page.on('response', recordError);
      const started = performance.now();
      try {
        await action();
        await page.locator(scenario.ready).first().waitFor();
        const contentMs = rounded(performance.now() - started);
        let photoMs = null;
        if (scenario.photo) {
          await page.locator(scenario.photoAnchor ?? scenario.ready).first().scrollIntoViewIfNeeded();
          await waitVisiblePhoto(scenario.photo);
          photoMs = rounded(performance.now() - started);
        }
        // Keep successive visits comparable by letting the initial requests settle.
        await page.waitForLoadState('networkidle');
        const thumbs = requests.filter(route => route.endsWith('?variant=thumbnail'));
        return { contentMs, photoMs, apiRequests: requests.length, thumbnails: thumbs.length,
          uniqueThumbnails: new Set(thumbs).size, renderedCards: await page.locator(scenario.ready).count(),
          pendingVariantNodes: await page.locator('.pending-variant').count() };
      } catch (error) {
        const status = await page.locator('h1, [role=alert]').allTextContents();
        throw new Error(`Failed ${scenario.name}. ${JSON.stringify({ requests, failures, errors, status })}`, { cause: error });
      } finally { page.off('request', record); page.off('response', recordError); }
    };
    const visits = { cold: {}, warm: {} };
    for (const temperature of ['cold', 'warm']) {
      for (const scenario of pages) {
        visits[temperature][scenario.name] = await measure(scenario, async () => {
          if (temperature === 'cold' && scenario.name === 'products') await page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
          else if (scenario.name === 'productDetail') await page.locator('.product-card').first().click();
          else await page.getByRole('navigation', { name: 'Navegación de Studio' }).getByRole('button', { name: scenario.button }).click();
          await page.evaluate(() => window.scrollTo(0, 0));
        });
      }
    }
    assert.deepEqual(errors, []);
    return visits;
  } finally { await context.close(); }
}

try {
  const photo = await seed();
  const apiMeasurements = {};
  for (const [name, route] of Object.entries({
    setup: '/setup', products: '/products', productDetail: `/products/${photo.commercial_product_id}`,
    pending: '/inventory-candidates?grouped=true', library: '/content-library',
    thumbnail: `/products/${photo.commercial_product_id}/images/${photo.id}/content?variant=thumbnail`,
  })) apiMeasurements[name] = await api(route);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const visits = {};
  for (const [name, device] of Object.entries(sizes)) {
    visits[name] = [];
    for (let repetition = 0; repetition < 3; repetition++) {
      console.log(`Measuring ${name} ${repetition + 1}/3`);
      visits[name].push(await measureViewport(device));
    }
  }
  const report = { scope: 'isolated local fixture with compiled Studio, fresh browser context per cold visit, warm service during browser measurements',
    fixture: { products: 27, stories: 30, syntheticPendingSkus: 1200 }, measuredAt: new Date().toISOString(), api: apiMeasurements, browser: visits };
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Studio performance results saved to ${output}`);
} finally {
  await browser?.close();
  await fixture.stop();
}
