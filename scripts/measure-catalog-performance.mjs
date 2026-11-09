// Read-only browser journey. The default database/media are disposable and isolated.
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { Client } from 'pg';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';
import { createDatabaseRuntime } from '../server/dbRuntime.js';
import { createCatalogService } from '../server/commerce/catalogService.js';

const args = process.argv.slice(2), remote = args.includes('--production');
const label = args.find(value => value.startsWith('--label='))?.split('=')[1] || 'current';
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(label)) throw new Error('Use a short kebab-case report label.');
const repetitions = Number(args.find(value => value.startsWith('--runs='))?.split('=')[1] || (remote ? 1 : 3));
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error('Use 1–5 runs; no load testing.');
const output = path.resolve(`docs/catalog-performance/${label}.json`);
let fixture, browser;
const result = { label, measuredAt: new Date().toISOString(), environment: remote ? 'production-read-only' : 'isolated-local-postgres', repetitions, journeys: [], database: [] };
try {
  if (!remote) fixture = await startCommerceFixture();
  const base = remote ? 'https://erpvoice.onrender.com' : fixture.apiUrl;
  const shop = remote ? 'fullmatch-casacas' : 'fullmatch-demo';
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const mobile of [false, true]) for (let run = 0; run < repetitions; run++) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile });
    await context.addInitScript(() => {
      window.catalogMetrics = { lcp: null, longestInteraction: null, longTasks: 0 };
      for (const type of ['largest-contentful-paint', 'event', 'longtask']) try {
        new PerformanceObserver(list => { for (const entry of list.getEntries()) {
          if (type === 'largest-contentful-paint') window.catalogMetrics.lcp = entry.startTime;
          if (type === 'event' && entry.interactionId) window.catalogMetrics.longestInteraction = Math.max(window.catalogMetrics.longestInteraction || 0, entry.duration);
          if (type === 'longtask') window.catalogMetrics.longTasks++;
        } }).observe({ type, buffered: true, ...(type === 'event' ? { durationThreshold: 16 } : {}) });
      } catch {}
    });
    const page = await context.newPage(), cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    if (mobile) {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 80, downloadThroughput: 200_000, uploadThroughput: 100_000 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    let requests = [], bytes = 0, cached = 0;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push({ path: new URL(request.url()).pathname, type: request.resourceType() }));
    cdp.on('Network.loadingFinished', event => { bytes += event.encodedDataLength; });
    cdp.on('Network.responseReceived', event => { if (event.response.fromDiskCache || event.response.fromPrefetchCache) cached++; });
    async function step(name, action, selector) {
      requests = []; bytes = 0; cached = 0;
      const start = performance.now();
      await action(); await page.locator(selector).first().waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const visibleMs = performance.now() - start;
      await page.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));
      // Wait for visible images, including lazy cards, without crawling below the fold.
      await page.waitForFunction(() => [...document.images].filter(img => { const r = img.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }).every(img => img.complete));
      await page.waitForTimeout(150);
      const metrics = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        return { documentTtfbMs: nav?.responseStart - nav?.requestStart, documentFcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, ...window.catalogMetrics };
      });
      result.journeys.push({ mobile, run, name, visibleMs, settledMs: performance.now() - start, requests: requests.length, documentRequests: requests.filter(r => r.type === 'document').length, transferredBytes: bytes, cachedResponses: cached, paths: requests, ...metrics });
    }
    await step('cold-list', () => page.goto(`${base}/c/${shop}`), '.catalog-card');
    const paths = await page.locator('.catalog-card > a').evaluateAll(links => links.slice(0, 3).map(link => link.getAttribute('href')));
    for (let index = 0; index < paths.length; index++) {
      await step(`product-${index + 1}`, () => page.locator(`.catalog-card > a[href="${paths[index]}"]`).click(), '.public-product-heading');
      await step(`back-${index + 1}`, () => page.locator('a.back').click(), '.catalog-card');
    }
    await step('search', async () => { await page.locator('.catalog-filters input[name=q]').fill('Barcelona'); await page.locator('.catalog-filters button[type=submit]').first().click(); }, '.active-filters');
    for (const [filter, value] of [['category', 'Camiseta'], ['team', 'barcelona'], ['version', 'player']]) {
      await step(`filter-${filter}`, () => page.goto(`${base}/c/${shop}?${filter}=${value}#coleccion`), '.catalog-results');
    }
    if (paths[0]) {
      await step('visited-product', () => page.goto(base + paths[0]), '.public-product-heading');
      await step('reload-product', () => page.reload(), '.public-product-heading');
    }
    if (errors.length) throw new Error(errors.join('\n'));
    await context.close();
  }
  if (fixture) {
    const runtime = createDatabaseRuntime({ connectionString: fixture.connection });
    let count = 0, dbMs = 0;
    const instrumented = { ...runtime, transaction: (callback, options) => runtime.transaction(client => callback({ query: async (...params) => {
      count++; const start = performance.now();
      try { return await client.query(...params); } finally { dbMs += performance.now() - start; }
    } }), options) };
    const service = createCatalogService(instrumented);
    await service.brand(shop); // schema check is intentionally excluded from steady-state counts
    for (let run = 0; run < repetitions; run++) {
      count = 0; dbMs = 0; let start = performance.now();
      const listing = await service.list(shop, { limit: '24' });
      result.database.push({ run, name: 'list-3', queryCount: count, dbMs, totalMs: performance.now() - start });
      count = 0; dbMs = 0; start = performance.now();
      await service.detail(shop, listing.items[0].slug);
      result.database.push({ run, name: 'detail', queryCount: count, dbMs, totalMs: performance.now() - start });
    }
    await runtime.close();
    const sql = new Client({ connectionString: fixture.connection }); await sql.connect();
    result.queryPlan = (await sql.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT p.id,p.slug FROM commercial_products p JOIN commercial_publications s ON s.owner_phone=p.owner_phone AND s.commercial_product_id=p.id WHERE p.owner_phone=$1 AND p.status='ready' AND s.status='published' ORDER BY p.slug LIMIT 25`, [fixture.owner])).rows;
    await sql.end();
  }
} catch (error) { result.error = error.message; process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  if (fixture) await fixture.stop();
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`${result.environment}: ${result.journeys.length} samples, ${output}${result.error ? `; ${result.error}` : ''}`);
}
if (result.error) process.exitCode = 1;
