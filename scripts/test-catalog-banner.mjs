import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { Client } from 'pg';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

// Optional local file arguments exercise real artwork without copying it into the repository.
const sources = process.argv.slice(2);
const images = sources.length ? await Promise.all(sources.map(async file => ({ name: path.basename(file), bytes: await fs.readFile(file) }))) :
  await Promise.all([949, 1080].map(async height => ({ name: `fixture-1920x${height}.png`, bytes: await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="${height}"><rect width="1920" height="${height}" fill="#102b40"/><rect x="0" y="0" width="30" height="${height}" fill="#ff6a00"/><rect x="1890" y="0" width="30" height="${height}" fill="#ff6a00"/><path d="M0 ${height - 15}H1920" stroke="#ff6a00" stroke-width="30"/><text x="80" y="180" font-size="70" fill="white">BANNER DE PRUEBA · BORDE IZQUIERDO</text><text x="1840" y="${height - 90}" text-anchor="end" font-size="55" fill="white">BORDE DERECHO</text></svg>`)).png().toBuffer() })));
const output = path.resolve('.fullmatch-runtime/banner-fit', process.env.BANNER_PHASE === 'before' ? 'before' : sources.length ? 'after' : 'fixture');
const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
let browser;
const measurements = [], presets = ['technical', 'classic', 'editorial', 'local'];
const api = async (route, method = 'GET', body, type = 'application/json') => {
  const response = await fetch(fixture.apiUrl + '/api/commerce/v1' + route, { method,
    headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': type },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
};
async function measure(root) {
  const image = root.locator('.catalog-hero.image-only .catalog-cover');
  await image.waitFor(); await image.evaluate(image => image.decode());
  return image.evaluate(async image => {
    const hero = image.closest('.catalog-hero'), main = hero.closest('main');
    const rect = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
    const style = getComputedStyle(main), mainBounds = rect(main);
    const bytes = await (await fetch(image.src)).arrayBuffer();
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    return { sha256, image: rect(image), hero: rect(hero), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
      contentWidth: mainBounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  });
}
function verify(value, label, expectedHash) {
  assert.equal(value.sha256, expectedHash, `${label}: render the uploaded file, not a previous preview`);
  assert.ok(Math.abs(value.hero.width - value.contentWidth) <= 1, `${label}: banner must fill the content width ${JSON.stringify(value)}`);
  assert.ok(Math.abs(value.image.width - value.hero.width) <= 1, `${label}: image width`);
  assert.ok(Math.abs(value.image.height - value.image.width * value.naturalHeight / value.naturalWidth) <= 1, `${label}: preserve the entire image ratio`);
  assert.ok(Math.abs(value.hero.height - value.image.height) <= 1, `${label}: no extra empty canvas`);
  assert.equal(value.scrollWidth, value.viewport, `${label}: horizontal overflow`);
}
try {
  await sql.connect(); const inventory = (await sql.query('SELECT * FROM products ORDER BY id')).rows;
  await fs.mkdir(output, { recursive: true });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ token, owner, origin }) => { if (location.origin === origin) {
    localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner);
  } }, { ...fixture, origin: new URL(fixture.url).origin });
  const studio = await context.newPage(), publicPage = await context.newPage(), errors = [];
  for (const page of [studio, publicPage]) page.on('pageerror', error => errors.push(error.message));
  for (const [index, source] of images.entries()) {
    const original = await sharp(source.bytes).metadata();
    const asset = await api('/brand-assets/cover', 'POST', source.bytes, original.format === 'jpeg' ? 'image/jpeg' : 'image/png');
    const stored = await fetch(fixture.apiUrl + '/api/commerce/v1/brand-assets/' + asset.id, { headers: { Authorization: `Bearer ${fixture.token}` } });
    assert.ok(stored.ok);
    const expectedHash = createHash('sha256').update(Buffer.from(await stored.arrayBuffer())).digest('hex');
    let profile = await api('/profile');
    await api('/profile', 'PUT', { operationId: randomUUID(), expectedRevision: profile.revision, brandName: profile.brandName,
      salesWhatsapp: profile.salesWhatsapp, appearance: { ...profile.appearance, preset: 'technical', coverId: asset.id, heroContentVisible: false } });
    if (studio.url() === fixture.url + '#/settings') await studio.reload();
    else await studio.goto(fixture.url + '#/settings');
    await studio.getByRole('heading', { name: 'Identidad visual' }).waitFor();
    const preview = studio.frameLocator('.catalog-preview-shell iframe');
    for (const preset of presets) {
      profile = await api('/profile');
      await api('/profile', 'PUT', { operationId: randomUUID(), expectedRevision: profile.revision, brandName: profile.brandName,
        salesWhatsapp: profile.salesWhatsapp, appearance: { ...profile.appearance, preset } });
      await studio.locator(`input[name="catalog-design"][value="${preset}"]`).check();
      for (const [width, height] of [[1440,1000],[390,844]]) {
        await publicPage.setViewportSize({ width, height });
        await publicPage.goto(fixture.apiUrl + '/c/fullmatch-demo');
        const actual = await measure(publicPage), label = `image-${index + 1}-${preset}-${width}`;
        measurements.push({ source: source.name, surface: 'catalog', preset, width, ...actual });
        if (sources.length) await publicPage.screenshot({ path: path.join(output, `${label}-catalog.png`), fullPage: true });
        await fs.writeFile(path.join(output, 'measurements.json'), JSON.stringify(measurements, null, 2));
        verify(actual, label, expectedHash);
        await studio.setViewportSize({ width, height });
        await studio.getByRole('button', { name: width === 390 ? 'Celular' : 'Escritorio', exact: true }).click();
        await preview.locator(`body[data-preset="${preset}"]`).waitFor();
        const rendered = await measure(preview);
        verify(rendered, `${label}-preview`, expectedHash);
        measurements.push({ source: source.name, surface: 'preview', preset, width, ...rendered });
        if (sources.length) await studio.locator('.appearance-preview-panel').screenshot({ path: path.join(output, `${label}-preview.png`) });
        assert.equal(await studio.evaluate(() => document.documentElement.scrollWidth), width);
      }
    }
    for (const frame of studio.frames().filter(frame => frame !== studio.mainFrame())) {
      const actual = await measure(frame); verify(actual, 'design sample', expectedHash);
    }
    console.log(`PASS banner ${index + 1}: ${original.width}x${original.height}, four presets, public + Studio preview, desktop/mobile, full width and original proportions`);
  }
  assert.deepEqual((await sql.query('SELECT * FROM products ORDER BY id')).rows, inventory);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'measurements.json'), JSON.stringify(measurements, null, 2));
  console.log(`PASS ${measurements.length} banner states; miniatures, inventory unchanged and no browser errors`);
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
