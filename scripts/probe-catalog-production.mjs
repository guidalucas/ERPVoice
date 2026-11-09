import fs from 'node:fs/promises';
import sharp from 'sharp';

const origin = 'https://erpvoice.onrender.com', shop = 'fullmatch-casacas';
const source = process.argv.find(value => value.startsWith('--source='))?.slice('--source='.length) || 'production-after';
const label = process.argv.find(value => value.startsWith('--label='))?.slice('--label='.length) || 'production-probes';
if (![source, label].every(value => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value))) throw new Error('Use short kebab-case report labels.');
const measured = JSON.parse(await fs.readFile(`docs/catalog-performance/${source}.json`, 'utf8'));
const sample = measured.journeys.find(row => row.name === 'image-product');
const product = sample.requestDetails.find(row => row.path.startsWith('/c/') && row.path.includes('/p/')).path.split('/p/')[1];
const image = sample.requestDetails.find(row => row.path.includes('/images/') && row.query.includes('variant=detail')).path;
const brand = measured.journeys.find(row => row.name === 'cold-list').requestDetails.filter(row => row.path.includes('/brand-assets/')).map(row => row.path);
const result = { measuredAt: new Date().toISOString(), sourceDeployment: measured.deploymentBefore, readOnly: true, probes: [] };
const cases = [['health', '/api/health'], ['static-js', '/catalog-assets/catalog.js?v=1'], ['brand-json', `/api/catalog/v1/${shop}`],
  ['list-json', `/api/catalog/v1/${shop}/products`], ['list-html', `/c/${shop}`], ['detail-json', `/api/catalog/v1/${shop}/products/${product}`],
  ['logo', brand[0]], ['cover', brand[1]], ['thumbnail-jpeg', `${image}?variant=thumbnail`], ['thumbnail-webp', `${image}?variant=thumbnail&format=webp`],
  ['detail-webp', `${image}?variant=detail&format=webp`], ['master-jpeg', image]];
for (let run = 0; run < 3; run++) for (const [name, path] of cases) {
  const start = performance.now(), response = await fetch(origin + path, { signal: AbortSignal.timeout(20000) });
  const ttfbMs = performance.now() - start, bytes = Buffer.from(await response.arrayBuffer());
  const item = { run, name, path, status: response.status, ttfbMs, totalMs: performance.now() - start, bytes: bytes.length,
    cacheControl: response.headers.get('cache-control'), etag: response.headers.get('etag'), serverTiming: response.headers.get('server-timing') };
  if (!response.ok) throw new Error(`Unexpected HTTP ${response.status} for ${name}`);
  if (response.headers.get('content-type')?.startsWith('image/')) {
    const metadata = await sharp(bytes).metadata(); Object.assign(item, { format: metadata.format, width: metadata.width, height: metadata.height });
    const at = performance.now(), conditional = await fetch(origin + path, { headers: { 'If-None-Match': item.etag, 'Cache-Control': 'max-age=0' }, signal: AbortSignal.timeout(20000) });
    item.conditional = { status: conditional.status, ttfbMs: performance.now() - at, bytes: (await conditional.arrayBuffer()).byteLength };
  }
  result.probes.push(item);
}
const health = await (await fetch(origin + '/api/health', { signal: AbortSignal.timeout(20000) })).json();
result.deploymentAfter = health.deployment;
if (result.sourceDeployment !== result.deploymentAfter) throw new Error('DEPLOYMENT_CHANGED');
await fs.writeFile(`docs/catalog-performance/${label}.json`, JSON.stringify(result, null, 2) + '\n');
console.log(`Saved ${result.probes.length} sequential read-only probes; deployment ${result.deploymentAfter}`);
