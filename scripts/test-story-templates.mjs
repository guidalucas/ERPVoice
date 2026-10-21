import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import sharp from 'sharp';

const output = path.resolve('.fullmatch-runtime/templates');
await fs.mkdir(output, { recursive: true });
const server = await createServer({ configFile: path.resolve('vite.studio.config.ts'), server: { port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
  // Only the renderer and the normal Studio styles are needed; no database or real session.
  await page.goto(origin + 'studio.html');
  await page.evaluate(async () => {
    await import('/src/studio/studio.css');
    await import('/src/studio/refinements.css');
    const { renderStory } = await import('/src/studio/storyRenderer.ts');
    window.renderTemplate = renderStory;
    document.body.replaceChildren();
    const remove = Element.prototype.remove;
    Element.prototype.remove = function () {
      const template = this.querySelector('.st');
      if (template) window.lastTemplate = {
        html: template.outerHTML,
      };
      return remove.call(this);
    };
  });
  const photo = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#1255aa' } }).png().toBuffer();
  const logo = await sharp({ create: { width: 120, height: 120, channels: 3, background: '#12ab34' } }).png().toBuffer();
  await page.route('**/api/commerce/v1/brand-assets/test-logo', route => route.fulfill({ status: 200, contentType: 'image/png', body: logo }));
  const snapshot = {
    snapshotId: 'renderer-test', schemaVersion: 1, rendererVersion: 4, width: 1080, height: 1920,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    content: {
      productId: 'product-test', title: 'Argentina titular 2025', teamName: 'Argentina', season: '2025', versionKey: 'player',
      brandName: 'FULLMATCH CASACAS · DEMO', heading: 'STOCK DISPONIBLE', assertion: 'available', availableQuantity: 3, imageId: 'photo-test',
      appearance: { logoId: null, primaryColor: '#001A4D', accentColor: '#FF6A00', tagline: 'Tu colección, con identidad' },
      variants: ['M', 'L', 'XL'].map(size => ({ skuId: size, size, stockAvailable: 1, price: { amountMinor: '7000000', currency: 'ARS', fractionDigits: 2 } })),
      price: { minAmountMinor: '7000000', maxAmountMinor: '7000000', currency: 'ARS', fractionDigits: 2 },
      settings: { templateId: 'available', templateVersion: 1, imageId: 'photo-test', expectedImageRevision: 1, skuIds: ['M', 'L', 'XL'],
        showPrice: true, fit: 'contain', zoom: 1, focalX: .5, focalY: .5, caption: '', cta: 'PEDILA POR WHATSAPP' },
    },
  };
  const render = async (current, name, format = 'png') => {
    const data = await page.evaluate(async ({ current, photo, format }) => {
      const canvas = document.createElement('canvas');
      const image = await (await fetch(`data:image/png;base64,${photo}`)).blob();
      const blob = await window.renderTemplate(canvas, current, image, format);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      assertNoHolder();
      function assertNoHolder() { if (document.querySelector('.st')) throw new Error('Template holder leaked'); }
      return { base64: btoa(Array.from(bytes, value => String.fromCharCode(value)).join('')), type: blob.type };
    }, { current, photo: photo.toString('base64'), format });
    const bytes = Buffer.from(data.base64, 'base64'), metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1920);
    assert.equal(metadata.format, format); assert.equal(data.type, `image/${format}`);
    await fs.writeFile(path.join(output, `${name}.${format === 'jpeg' ? 'jpg' : 'png'}`), bytes);
    return bytes;
  };
  const pixel = async (bytes, x, y) => [...await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  for (const [templateId, heading] of Object.entries({ available: 'STOCK DISPONIBLE', arrival: 'NUEVO INGRESO', last_unit: 'ÚLTIMA UNIDAD · TALLE M', matchday: 'LA PASIÓN SE LLEVA PUESTA', promo: 'PROMOCIÓN' })) {
    const current = structuredClone(snapshot);
    current.content.settings.templateId = templateId; current.content.heading = heading;
    if (templateId === 'last_unit') { current.content.assertion = 'last_size'; current.content.variants = current.content.variants.slice(0, 1); }
    if (templateId === 'promo') current.content.promotion = { percentage: 15, minAmountMinor: '5950000', maxAmountMinor: '5950000',
      startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), timeZone: 'America/Montevideo', label: 'PROMOCIÓN' };
    const bytes = await render(current, templateId);
    if (templateId === 'promo') {
      await page.evaluate(async photo => {
        document.body.insertAdjacentHTML('beforeend', window.lastTemplate.html);
        const image = document.querySelector('.st-shot');
        image.src = `data:image/png;base64,${photo}`; await image.decode();
      }, photo.toString('base64'));
      for (const selector of ['.st-title', '.st-price b', '.st-badge']) {
        const element = page.locator(selector), box = await element.evaluate(element => {
          const bounds = element.getBoundingClientRect(), root = element.closest('.st').getBoundingClientRect();
          return { x: bounds.x - root.x, y: bounds.y - root.y, width: bounds.width, height: bounds.height };
        });
        const expected = await element.screenshot({ scale: 'css' });
        const crop = { left: Math.round(box.x), top: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
        const resize = { width: Math.round(box.width / 4), height: Math.round(box.height / 4), fit: 'fill' };
        const htmlPixels = await sharp(expected).resize(resize).removeAlpha().raw().toBuffer();
        const exportPixels = await sharp(bytes).extract(crop).resize(resize).removeAlpha().raw().toBuffer();
        const difference = htmlPixels.reduce((sum, value, index) => sum + Math.abs(value - exportPixels[index]), 0) / htmlPixels.length;
        assert.ok(difference < 8, `${selector}: exported typography differs from HTML (${difference.toFixed(2)})`);
      }
      await page.locator('.st').evaluate(element => element.remove());
      console.log('PASS exported title, badge and price match HTML typography');
    }
    assert.deepEqual(await pixel(bytes, 540, 700), [18, 85, 170], 'Actual photograph pixels must survive first export');
    assert.deepEqual(await pixel(bytes, 10, 1900), [0, 26, 77], 'Brand color must survive export');
    console.log(`PASS template ${templateId}: first PNG, photo pixels, fixed size at mobile DPR 2`);
  }
  const long = structuredClone(snapshot);
  long.content.price = { ...long.content.price, minAmountMinor: '125000000', maxAmountMinor: '130000000' };
  long.content.title = 'Camiseta edición especial de la selección Argentina 2025';
  long.content.settings.caption = '<img src=x onerror="window.templateInjected=true">';
  long.content.settings.cta = 'CONSULTANOS DISPONIBILIDAD POR WHATSAPP';
  await render(long, 'long-price-and-escaped-text', 'jpeg');
  assert.equal(await page.evaluate(() => window.templateInjected), undefined);
  console.log('PASS long price, two-line title, long CTA, escaped text and JPEG export');

  const branded = structuredClone(snapshot);
  branded.content.appearance = { ...branded.content.appearance, primaryColor: '#ffffff', accentColor: '#ffff00', logoId: 'test-logo' };
  const brandedBytes = await render(branded, 'light-brand-logo');
  assert.deepEqual(await pixel(brandedBytes, 110, 110), [18, 171, 52]);
  assert.deepEqual(await pixel(brandedBytes, 10, 1900), [255, 255, 255]);
  for (let version = 1; version <= 3; version++) {
    const legacy = structuredClone(snapshot); legacy.rendererVersion = version;
    const bytes = await render(legacy, `legacy-v${version}`);
    assert.deepEqual(await pixel(bytes, 10, 10), [0, 26, 77], 'Legacy snapshots retain their original layout');
  }
  console.log('PASS branded logo, light colors and legacy renderer versions 1–3');

  const rejected = structuredClone(snapshot); rejected.content.settings.cta = 'X'.repeat(500);
  await assert.rejects(render(rejected, 'must-not-export'), /El texto no entra en la plantilla/);
  assert.equal(await page.locator('.st').count(), 0);
  console.log('PASS overflowing text is rejected and temporary nodes are cleaned up');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close(); await server.close();
}
