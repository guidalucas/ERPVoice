// Read-only browser journey. The default database/media are disposable and isolated.
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
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
if (remote && label === 'production-before') throw new Error('The historical production baseline must not be overwritten.');
let fixture, browser;
const result = { label, measuredAt: new Date().toISOString(), environment: remote ? 'production-read-only' : 'isolated-local-postgres', repetitions,
  conditions: { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844, dpr: 2, cpuSlowdown: 4, latencyMs: 80, downloadBytesPerSecond: 200000, uploadBytesPerSecond: 100000 },
    cold: 'New browser context, empty browser cache. Server/cache state is uncontrolled; no restart or cache purge.', warm: 'Same browser context; earlier product images and assets may be reused.' }, journeys: [], database: [] };
try {
  if (!remote) fixture = await startCommerceFixture();
  const base = remote ? 'https://erpvoice.onrender.com' : fixture.apiUrl;
  const shop = remote ? 'fullmatch-casacas' : 'fullmatch-demo';
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  result.browserVersion = browser.version();
  const liveCommit = async () => { const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(30000) }); if (!response.ok) throw new Error('HEALTH_UNAVAILABLE'); return (await response.json()).deployment; };
  if (remote) {
    result.deploymentBefore = await liveCommit();
    const baseline = await fs.readFile('docs/catalog-performance/production-before.json');
    result.baselineSha256 = createHash('sha256').update(baseline.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
  }
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
    let requests = [], bytes = 0, cached = 0, memoryCached = 0, responses304 = 0;
    const details = new WeakMap();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url()), record = { path: url.pathname, query: url.search, type: request.resourceType(), request };
      details.set(request, record); requests.push(record);
    });
    page.on('response', response => {
      const record = details.get(response.request()); if (!record) return;
      const headers = response.headers(); Object.assign(record, { status: response.status(), cacheControl: headers['cache-control'] ?? null,
        contentType: headers['content-type'] ?? null, serverTiming: headers['server-timing'] ?? null });
    });
    page.on('requestfailed', request => { const record = details.get(request); if (record) record.failure = request.failure()?.errorText; });
    cdp.on('Network.loadingFinished', event => { bytes += event.encodedDataLength; });
    cdp.on('Network.responseReceived', event => { if (event.response.fromDiskCache || event.response.fromPrefetchCache) cached++; });
    cdp.on('Network.requestServedFromCache', () => { memoryCached++; });
    cdp.on('Network.responseReceivedExtraInfo', event => { if (event.statusCode === 304) responses304++; });
    async function step(name, action, selector) {
      requests = []; bytes = 0; cached = 0; memoryCached = 0; responses304 = 0;
      const start = performance.now();
      await action(); await page.locator(selector).first().waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const visibleMs = performance.now() - start;
      await page.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));
      // Wait for visible images, including lazy cards, without crawling below the fold.
      await page.waitForFunction(() => [...document.images].filter(img => { const r = img.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 && r.width > 0; }).every(img => img.complete));
      const visibleImages = await page.evaluate(async () => {
        const images = [...document.images].filter(img => { const r = img.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 && r.width > 0; });
        await Promise.all(images.filter(img => img.naturalWidth).map(img => img.decode().catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return images.map(img => ({ path: new URL(img.currentSrc || img.src).pathname, width: img.naturalWidth, height: img.naturalHeight, productImage: img.matches('[data-gallery-main],.catalog-card img') }));
      });
      const imageReadyMs = visibleImages.length ? performance.now() - start : null;
      if (visibleImages.some(img => !img.width)) throw new Error(`Broken visible image in ${name}`);
      await page.waitForTimeout(150);
      const metrics = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        return { documentTtfbMs: nav?.responseStart - nav?.requestStart, documentFcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, ...window.catalogMetrics };
      });
      const requestDetails = requests.map(({ request, ...record }) => {
        const timing = request.timing(); return { ...record, ttfbMs: timing.requestStart >= 0 && timing.responseStart >= 0 ? timing.responseStart - timing.requestStart : null,
          totalMs: timing.responseEnd >= 0 ? timing.responseEnd : null };
      });
      const pageRequest = requestDetails.find(r => r.path.startsWith('/c/') && ['document', 'fetch'].includes(r.type));
      result.journeys.push({ mobile, run, name, visibleMs, imageReadyMs, visibleImages, settledMs: performance.now() - start,
        navigationTtfbMs: pageRequest?.ttfbMs ?? null, navigationMode: pageRequest?.type ?? 'cached-or-prefetched',
        requests: requests.length, documentRequests: requests.filter(r => r.type === 'document').length,
        dataApiRequests: requests.filter(r => r.path.startsWith('/api/') && r.type !== 'image').length,
        imageApiRequests: requests.filter(r => r.path.startsWith('/api/') && r.type === 'image').length,
        transferredBytes: bytes, cachedResponses: cached, browserCacheServed: memoryCached, responses304,
        paths: requests.map(({ path, type }) => ({ path, type })), requestDetails, ...metrics });
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
    await step('warm-list', () => page.goto(`${base}/c/${shop}`), '.catalog-card');
    const photographed = await page.locator('.catalog-card > a').evaluateAll(links => links.find(link => link.querySelector('img'))?.getAttribute('href'));
    if (photographed) {
      await step('image-product', () => page.locator(`.catalog-card > a[href="${photographed}"]`).click(), '[data-gallery-main]');
      await step('image-product-reload', () => page.reload(), '[data-gallery-main]');
      await step('image-back', () => page.locator('a.back').click(), '.catalog-card');
      await step('image-product-warm', () => page.locator(`.catalog-card > a[href="${photographed}"]`).click(), '[data-gallery-main]');
    }
    if (errors.length) throw new Error(errors.join('\n'));
    await context.close();
  }
  if (remote) {
    result.deploymentAfter = await liveCommit();
    if (result.deploymentBefore !== result.deploymentAfter) throw new Error('DEPLOYMENT_CHANGED_DURING_MEASUREMENT');
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
