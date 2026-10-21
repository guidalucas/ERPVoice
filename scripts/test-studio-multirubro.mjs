import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from 'pg';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';
import { inventoryRowToProduct } from '../server/inventoryPostgres.js';
import { inventoryProductFingerprint } from '../server/inventoryOperations.js';
import { operationRequestDigest } from '../server/operationHash.js';
import { migrateUniversalCommerce } from '../server/commerce/universalMigration.js';

// This helper creates a fresh, isolated localhost PostgreSQL database. Never use real stores.
const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
const output = path.resolve('.fullmatch-runtime/multirubro');
const prefix = '/api/commerce/v1';
let browser;
const api = async (user, route, method = 'GET', body, status = 200, type = 'application/json') => {
  const response = await fetch(fixture.apiUrl + route, { method, headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': type },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
};
try {
  await sql.connect(); await fs.mkdir(output, { recursive: true });
  assert.equal((await migrateUniversalCommerce(sql)).changed, false);
  const shops = [
    { ...fixture, slug: 'fullmatch-demo', preset: 'editorial', title: 'FullMatch', products: fixture.products },
    { ...fixture.freshOwners[0], slug: 'ferreteria-fixture', preset: 'technical', title: 'Ferretería · PRUEBA', category: 'Herramientas', unit: 'unit', spec: { potencia: { state: 'known', type: 'number', value: 650, unit: 'w' } }, names: ['Taladro 650 W', 'Broca 8 mm'] },
    { ...fixture.freshOwners[1], slug: 'kiosco-fixture', preset: 'local', title: 'Kiosco · PRUEBA', category: 'Bebidas', unit: 'pack', spec: { presentacion: { state: 'known', type: 'text', value: '6 × 500 ml' } }, names: ['Agua 500 ml', 'Agua pack de seis'] },
  ];
  // Fixture-only artwork explicitly labelled; no external or invented product photography.
  const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#e6e9ee"/><text x="300" y="400" text-anchor="middle" font-family="Arial" font-size="26" fill="#465568">IMAGEN DE PRUEBA</text></svg>')).png().toBuffer();
  for (const shop of shops.slice(1)) {
    await api(shop, prefix + '/setup', 'POST', { operationId: randomUUID(), expectedProfileRevision: 0, expectedPolicyRevision: 0, brandName: shop.title, salesWhatsapp: shop.owner, currency: 'UYU', confirmedMajorInteger: true });
    await sql.query('UPDATE auth_users SET business_category=$2 WHERE phone_number=$1', [shop.owner, shop.preset === 'technical' ? 'ferreteria' : 'kiosco']);
    await api(shop, prefix + '/catalog', 'PUT', { operationId: randomUUID(), expectedRevision: 0, slug: shop.slug, publicEnabled: true });
    shop.products = [];
    for (const [index, name] of shop.names.entries()) {
      const row = (await sql.query(`INSERT INTO products(id,owner_phone,name,product_type,stock_available,price,price_currency,inventory_unit,attributes_json)
        VALUES($1,$2,$3,$4,3,150,'UYU',$5,$6::jsonb) RETURNING *`, [randomUUID(), shop.owner, name, shop.category, shop.unit,
        JSON.stringify({ ...(shop.preset === 'technical' && index ? { medida: { state: 'known', type: 'number', value: 8, unit: 'mm' } } : shop.spec), proveedor: { state: 'known', type: 'text', value: 'PRIVADO_NO_PUBLICAR' } })])).rows[0];
      const sku = inventoryRowToProduct(row);
      let product = (await api(shop, prefix + '/products', 'POST', { operationId: randomUUID(), product: { title: name, description: 'Producto ficticio en base temporal de pruebas.' }, skuLinks: [{ skuId: sku.id, expectedRevision: sku.revision, expectedFingerprint: inventoryProductFingerprint(sku) }] }, 201)).result;
      assert.equal(product.readiness.canPrepare, true); assert.equal(product.readiness.canGenerateStory, false);
      if (!index) {
        const initialized = (await api(shop, prefix + `/products/${product.id}/images`, 'POST', { operationId: randomUUID(), expectedRevision: product.revision, sourceSha256: createHash('sha256').update(image).digest('hex'), sourceSizeBytes: image.length, altText: 'Imagen de prueba aislada' }, 201)).result;
        product = await api(shop, prefix + `/products/${product.id}/images/${initialized.imageId}/content`, 'PUT', image, 200, 'image/png');
      }
      product = (await api(shop, prefix + `/products/${product.id}/status`, 'POST', { operationId: randomUUID(), expectedRevision: product.revision, status: 'ready', reason: 'Fixture local multirrubro' })).result;
      await api(shop, prefix + `/products/${product.id}/publication`, 'PUT', { operationId: randomUUID(), expectedRevision: 0, expectedProductRevision: product.revision, status: 'published', reason: 'Fixture local' });
      shop.products.push(product);
    }
  }
  const inventoryBefore = (await sql.query('SELECT * FROM products ORDER BY id')).rows;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const shop of shops) {
    const profile = await api(shop, prefix + '/profile');
    const appearance = { ...profile.appearance, preset: shop.preset };
    await api(shop, prefix + '/profile', 'PUT', { operationId: randomUUID(), expectedRevision: profile.revision, brandName: profile.brandName, salesWhatsapp: profile.salesWhatsapp, appearance });
    const persisted = await api(shop, prefix + '/profile'); assert.deepEqual(persisted.appearance, appearance);
    // An older client omitting preset must not erase it.
    const { preset, ...oldAppearance } = appearance;
    await api(shop, prefix + '/profile', 'PUT', { operationId: randomUUID(), expectedRevision: persisted.revision, brandName: profile.brandName, salesWhatsapp: profile.salesWhatsapp, appearance: oldAppearance });
    assert.equal((await api(shop, prefix + '/profile')).appearance.preset, preset);
    const response = await fetch(`${fixture.apiUrl}/api/catalog/v1/${shop.slug}/products?limit=1`), listing = await response.json();
    assert.equal(response.status, 200); assert.ok(listing.nextCursor); assert.ok(listing.facets.variants.length >= 2);
    assert.ok(!JSON.stringify(listing).includes('PRIVADO_NO_PUBLICAR')); assert.ok(!JSON.stringify(listing).includes('owner_phone'));
    if (shop.category) {
      assert.deepEqual(listing.facets.categories, [shop.category]); assert.deepEqual(listing.facets.teams, []); assert.deepEqual(listing.facets.versions, []);
      const filtered = await (await fetch(`${fixture.apiUrl}/api/catalog/v1/${shop.slug}/products?category=${encodeURIComponent(shop.category)}`)).json(); assert.equal(filtered.items.length, 2);
      const quote = await (await fetch(`${fixture.apiUrl}/api/catalog/v1/${shop.slug}/inquiry-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ productSlug: listing.items[0].slug, size: listing.items[0].sizes[0].size, quantity: 1 }] }) })).json();
      assert.equal(quote.canContact, true); assert.ok(!decodeURIComponent(quote.contactUrl).includes('talle'));
      await api(shop, prefix + `/products/${fixture.products[0].id}`, 'GET', undefined, 404);
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.addInitScript(({ token, owner, origin }) => { if (location.origin === origin) { localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner); } }, { ...shop, origin: new URL(fixture.url).origin });
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`${fixture.apiUrl}/c/${shop.slug}`); await page.locator('.catalog-card').first().waitFor();
      assert.equal(await page.locator('body').getAttribute('data-preset'), shop.preset);
      if (shop.category) { assert.equal(await page.locator('select[name=team]').count(), 0); assert.equal(await page.locator('select[name=version]').count(), 0); }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(output, `${shop.preset}-${viewport.width}-catalog.png`), fullPage: true });
      await page.locator('.catalog-card a').first().click(); await page.locator('.public-product-info h1').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(output, `${shop.preset}-${viewport.width}-product.png`), fullPage: true });
      await page.goto(fixture.url); await page.getByRole('heading', { name: 'Productos comerciales' }).waitFor();
      if (shop.category) assert.equal(await page.getByLabel('Filtrar equipo').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(output, `${shop.preset}-${viewport.width}-studio.png`), fullPage: true });
    }
    // Choosing a preset is one optional control in the current settings screen.
    await page.goto(fixture.url + '#/settings');
    const presetRadio = preset => page.locator(`input[name="catalog-design"][value="${preset}"]`);
    await presetRadio('classic').check(); await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click();
    await page.getByText('Configuración guardada.', { exact: true }).waitFor(); await page.reload();
    assert.equal(await presetRadio('classic').isChecked(), true);
    assert.equal(await page.getByLabel('Título de portada', { exact: true }).inputValue(), appearance.heroTitle);
    await presetRadio(shop.preset).check(); await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click();
    await page.getByText('Configuración guardada.', { exact: true }).waitFor();
    await page.goto(fixture.url + `#/products/${shop.products[0].id}`); await page.getByRole('button', { name: 'Generar historia ↗' }).click();
    await page.getByRole('button', { name: 'Generar previsualización', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.export-actions button')?.hasAttribute('disabled'));
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar PNG ↓' }).click();
    const bytes = await fs.readFile(await (await download).path()); const metadata = await sharp(bytes).metadata(); assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1920);
    await fs.writeFile(path.join(output, `${shop.preset}-story.png`), bytes);
    const snapshot = (await sql.query("SELECT result_json FROM commercial_operations WHERE owner_phone=$1 AND operation_type='story.prepare' ORDER BY created_at DESC LIMIT 1", [shop.owner])).rows[0].result_json.result;
    assert.equal(snapshot.rendererVersion, 5);
    if (shop.category) assert.equal(snapshot.content.variantLabel, 'PRESENTACIONES DISPONIBLES');
    // Historical v4 snapshots still revalidate against their original projection.
    if (shop.preset === 'editorial') {
      const legacy = structuredClone(snapshot), legacyId = randomUUID();
      legacy.snapshotId = legacyId; legacy.rendererVersion = 4; delete legacy.content.variantLabel;
      for (const variant of legacy.content.variants) { delete variant.label; delete variant.unit; }
      legacy.contentFingerprint = operationRequestDigest(legacy.content);
      await sql.query(`INSERT INTO commercial_operations(owner_phone,operation_id,actor_id,operation_type,entity_id,request_hash,request_json,result_json)
        VALUES($1,$2,$1,'story.prepare',$3,$4,'{}'::jsonb,$5::jsonb)`, [shop.owner, legacyId, legacy.content.productId, 'a'.repeat(64), JSON.stringify({ result: legacy })]);
      assert.equal((await api(shop, prefix + `/story-snapshots/${legacyId}/validate`, 'POST', {})).valid, true);
    }
    const latest = await api(shop, prefix + '/profile');
    await api(shop, prefix + '/profile', 'PUT', { operationId: randomUUID(), expectedRevision: latest.revision, brandName: latest.brandName, salesWhatsapp: latest.salesWhatsapp, appearance: { ...latest.appearance, preset: 'classic' } });
    assert.equal((await api(shop, prefix + `/story-snapshots/${snapshot.snapshotId}/validate`, 'POST', {})).valid, true);
    assert.deepEqual(errors, []); await context.close();
    console.log(`PASS multirubro ${shop.preset}: private isolation, optional preset persistence, full-catalog facets, desktop/mobile catalog + detail + Studio, real PNG export`);
  }
  assert.deepEqual((await sql.query('SELECT * FROM products ORDER BY id')).rows, inventoryBefore);
  console.log('PASS all inventory rows, prices, attributes and identities unchanged after theme changes and story exports');
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
