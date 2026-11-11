import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';
import { createDatabaseRuntime } from '../server/dbRuntime.js';
import { createCatalogService } from '../server/commerce/catalogService.js';
import { Pool } from 'pg';

const baseline = process.argv.find(value => value.startsWith('--base='))?.slice(7) ?? '6444d97';
if (!/^[a-f0-9]{7,40}$/.test(baseline)) throw new Error('Supply a baseline commit SHA.');
const repositoryName = `.catalog-benchmark-repository-${process.pid}.js`;
const repositoryFile = new URL(`../server/commerce/${repositoryName}`, import.meta.url);
const serviceFile = new URL(`../server/commerce/.catalog-benchmark-service-${process.pid}.js`, import.meta.url);
const original = name => execFileSync('git', ['show', `${baseline}:server/commerce/${name}`], { encoding: 'utf8' });
const files = [];
let fixture;
try {
  await fs.writeFile(repositoryFile, original('publicProductRepository.js'), { flag: 'wx' });
  files.push(repositoryFile);
  await fs.writeFile(serviceFile, original('catalogService.js').replace('./publicProductRepository.js', `./${repositoryName}`), { flag: 'wx' });
  files.push(serviceFile);
  const { createCatalogService: createBaseline } = await import(serviceFile.href);
  fixture = await startCommerceFixture();
  const result = { baseline, environment: 'disposable local PostgreSQL', runs: 5, scenarios: [] };
  const shop = 'fullmatch-demo';
  const storage = { configured: true, get() { throw new Error('Conditional requests must not read storage'); } };
  let previousDetail;
  for (const roundTripDelayMs of [0, 60]) {
    for (const [version, createService] of [['before', createBaseline], ['after', createCatalogService]]) {
      let queries = 0;
      const runtime = createDatabaseRuntime({
        connectionString: fixture.connection,
        poolFactory(options) {
          const pool = new Pool(options);
          return {
            async connect() {
              const client = await pool.connect();
              return {
                async query(...args) {
                  queries++;
                  if (roundTripDelayMs) await delay(roundTripDelayMs);
                  return client.query(...args);
                },
                release: () => client.release(),
              };
            },
            end: () => pool.end(),
          };
        },
      });
      try {
        const catalog = createService(runtime, storage);
        const listing = await catalog.list(shop);
        const photoProduct = listing.items.find(item => item.photos.length);
        assert.ok(photoProduct, 'Fixture must include a photographed product.');
        const { slug, photos: [photo] } = photoProduct;
        const readDetail = () => catalog.detail(shop, slug);
        const revalidateImage = () => catalog.image(shop, slug, photo.id, 'detail', 'webp', '*');
        const warmDetail = await readDetail();
        if (version === 'before') previousDetail = warmDetail;
        else assert.deepEqual(warmDetail, previousDetail);
        assert.equal((await revalidateImage()).notModified, true);

        for (const [name, read] of [['detail', readDetail], ['image-304', revalidateImage]]) {
          const samples = [];
          for (let run = 0; run < result.runs; run++) {
            queries = 0;
            const start = performance.now();
            await read();
            samples.push({ sqlCommands: queries, elapsedMs: performance.now() - start });
          }
          const sqlCommands = version === 'before' ? 5 : 1;
          assert.ok(samples.every(sample => sample.sqlCommands === sqlCommands));
          const sorted = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
          result.scenarios.push({ version, name, roundTripDelayMs, sqlCommands, medianMs: sorted[2], samples });
        }
      } finally {
        await runtime.close();
      }
    }
  }
  await fs.writeFile('docs/catalog-performance/read-roundtrips-benchmark.json', JSON.stringify(result, null, 2) + '\n');
  for (const scenario of result.scenarios) {
    console.log(`${scenario.version} ${scenario.name} RTT=${scenario.roundTripDelayMs}ms ${scenario.sqlCommands} commands, ${scenario.medianMs.toFixed(1)}ms median`);
  }
} finally {
  try {
    if (fixture) await fixture.stop();
  } finally {
    for (const file of files) await fs.unlink(file);
  }
}
