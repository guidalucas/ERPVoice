import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const origin = 'https://erpvoice.onrender.com';
const source = process.argv.find(value => value.startsWith('--source='))?.slice(9) ?? 'production-after';
if (!/^[a-z0-9-]{1,64}$/.test(source)) throw new Error('Supply a valid measurement label.');
const audit = JSON.parse(await fs.readFile(`docs/catalog-performance/${source}.json`, 'utf8'));
const photoPaths = new Set();
for (const row of audit.journeys) {
  for (const request of row.requestDetails) {
    if (request.status === 200 && /^\/api\/catalog\/v1\/fullmatch-casacas\/products\/[a-z0-9-]+\/images\/[a-f0-9-]{36}$/.test(request.path)) {
      photoPaths.add(request.path);
    }
  }
}
const photos = [...photoPaths].slice(0, 6);
assert.ok(photos.length, 'The measurement must contain photographed products.');
async function liveCommit() {
  const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok);
  return (await response.json()).deployment;
}
const result = { startedAt: new Date().toISOString(), deployment: await liveCommit(), sharp: sharp.versions.sharp, repetitions: 5, sampleCount: photos.length, photos: [] };
const dimensions = { width: 960, height: 1200, fit: 'inside', withoutEnlargement: true };
for (const path of photos) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok && response.headers.get('content-type')?.startsWith('image/jpeg'));
  const master = Buffer.from(await response.arrayBuffer());
  const { data: reference, info } = await sharp(master).resize(dimensions).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const photo = { path, masterBytes: master.length, width: info.width, height: info.height, candidates: [] };
  for (const effort of [4, 2, 1, 0]) {
    const encode = () => sharp(master).resize(dimensions).webp({ quality: 80, effort }).toBuffer();
    let image = await encode();
    const times = [];
    for (let index = 0; index < result.repetitions; index++) {
      const start = performance.now();
      image = await encode();
      times.push(performance.now() - start);
    }
    const decoded = await sharp(image).toColourspace('srgb').raw().toBuffer();
    assert.equal(decoded.length, reference.length);
    let squaredError = 0;
    for (let index = 0; index < reference.length; index++) squaredError += (reference[index] - decoded[index]) ** 2;
    const psnr = 10 * Math.log10(255 ** 2 / (squaredError / reference.length));
    photo.candidates.push({ effort, bytes: image.length, medianMs: times.sort((a, b) => a - b)[2], times, psnr });
  }
  result.photos.push(photo);
}
result.deploymentAfter = await liveCommit();
assert.equal(result.deployment, result.deploymentAfter);
await fs.writeFile('docs/catalog-performance/image-encoding-benchmark.json', JSON.stringify(result, null, 2) + '\n');
console.log(`Benchmarked ${result.sampleCount} public JPEGs locally at four WebP effort levels.`);
