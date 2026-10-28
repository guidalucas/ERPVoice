import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
let browser, page, checks = 0;
const check = async (name, run) => { await run(); console.log(`PASS self-service: ${name}`); checks++; };
const [first, second, racing] = fixture.freshOwners;
const api = async (user, route, method = 'GET', body, expected = 200) => {
  const response = await fetch(fixture.apiUrl + route, { method, headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
};
const commerce = '/api/commerce/v1';
const profile = (currency, brandName = 'Negocio nuevo') => ({ operationId: randomUUID(), expectedProfileRevision: 0, expectedPolicyRevision: 0, brandName, currency, confirmedMajorInteger: true, salesWhatsapp: null });
try {
  await sql.connect();
  await check('new owners start without configuration; authentication and membership protect activation', async () => {
    const state = await api(first, commerce + '/setup'); assert.equal(state.needsSetup, true); assert.equal(state.moneyPolicy, null);
    await api(fixture.member, commerce + '/setup', 'GET', undefined, 403);
    await api(fixture.member, commerce + '/setup', 'POST', profile('ARS'), 403);
    await api(first, commerce + '/setup', 'POST', { ...profile('ARS'), businessId: second.owner }, 400);
    await api(first, commerce + '/setup', 'POST', { ...profile('ARS'), confirmedMajorInteger: false }, 422);
    await api(first, commerce + '/setup', 'POST', profile('EUR'), 422);
  });
  const legacyInput = { operationId: randomUUID(), name: 'Camiseta histórica Argentina', size: 'M', price: 65000, stockAvailable: 2 };
  const oldSku = await api(first, '/api/products', 'POST', legacyInput, 201);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await context.addInitScript(({ owner, token }) => { localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner); }, first);
  page = await context.newPage(); const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(new URL(request.url()).pathname));
  await check('owner configures business, category, contact and money on mobile; lost activation response replays the same body', async () => {
    const attempts = []; let loseFirst = true;
    await page.route('**/api/commerce/v1/setup', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push(route.request().postDataJSON()); const response = await route.fetch();
      if (loseFirst) { loseFirst = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_LOST_RESPONSE', message: 'Conexión interrumpida después de guardar.' } }) }); }
      return route.fulfill({ response });
    });
    await page.goto(fixture.url); await page.getByRole('heading', { name: 'Configurá tu negocio' }).waitFor();
    await page.getByLabel('Nombre comercial', { exact: true }).fill('Casacas del Sur');
    await page.getByLabel('Rubro', { exact: true }).selectOption('indumentaria');
    await page.getByLabel('WhatsApp para consultas (opcional)', { exact: true }).fill('59899000091');
    await page.getByLabel('Moneda de tus precios', { exact: true }).selectOption('ARS');
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Activar mi espacio comercial' }).click();
    await page.getByRole('button', { name: 'Reintentar activación guardada' }).waitFor();
    await page.getByRole('button', { name: 'Reintentar activación guardada' }).click();
    await page.getByRole('heading', { name: 'Productos comerciales' }).waitFor();
    for (const label of ['Filtrar equipo', 'Filtrar temporada', 'Filtrar versión', 'Filtrar manga']) assert.equal(await page.getByLabel(label, { exact: true }).count(), 0);
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
    const state = await api(first, commerce + '/setup'); assert.equal(state.enabled, true); assert.equal(state.moneyPolicy.currency, 'ARS');
    const sku = (await sql.query('SELECT price,price_currency,stock_available FROM products WHERE owner_phone=$1 AND id=$2', [first.owner, oldSku.id])).rows[0];
    assert.deepEqual(sku, { price: '65000', price_currency: 'XXX', stock_available: '2' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.unroute('**/api/commerce/v1/setup');
  });
  await check('second owner activates a different currency independently, with replay, races and policy conflicts', async () => {
    await api(second, '/api/business-profile', 'POST', { businessName: 'Otra tienda', businessCategory: 'indumentaria' });
    const input = profile('UYU', 'Otra tienda'); const receipt = await api(second, commerce + '/setup', 'POST', input);
    assert.deepEqual(await api(second, commerce + '/setup', 'POST', input), receipt);
    await api(second, commerce + '/setup', 'POST', { ...input, brandName: 'Contenido cambiado' }, 409);
    await api(second, commerce + '/setup', 'POST', profile('UYU'), 409);
    await api(second, commerce + '/setup', 'POST', { ...profile('ARS'), expectedProfileRevision: 1, expectedPolicyRevision: 1 }, 409);
    assert.equal((await api(first, commerce + '/setup')).profile.brandName, 'Casacas del Sur');
    assert.equal((await api(second, commerce + '/products')).items.length, 0);
    const ownPolicy = await api(fixture.member, commerce + '/money-policy'); assert.equal(ownPolicy.moneyPolicy.currency, 'ARS');
    const race = await Promise.all([profile('ARS'), profile('UYU')].map(body => fetch(fixture.apiUrl + commerce + '/setup', {
      method: 'POST', headers: { Authorization: `Bearer ${racing.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })));
    assert.deepEqual(race.map(response => response.status).sort(), [200, 409]);
    assert.equal((await sql.query('SELECT count(*)::int AS count FROM inventory_money_policies WHERE owner_phone=$1', [racing.owner])).rows[0].count, 1);
    await sql.query('UPDATE commerce_profiles SET enabled=false WHERE owner_phone=$1', [racing.owner]);
    const disabled = await api(racing, commerce + '/setup');
    await api(racing, commerce + '/setup', 'POST', { ...profile(disabled.moneyPolicy.currency), expectedProfileRevision: 1, expectedPolicyRevision: 1 }, 403);
  });
  await check('historical currency is reviewed from UI and applied by sku.update with immutable core receipt', async () => {
    await page.getByRole('button', { name: /Configuración/ }).click();
    await page.getByRole('heading', { name: 'Revisar moneda del inventario anterior' }).waitFor();
    await page.locator('.money-review .variant-row').filter({ hasText: 'Camiseta histórica Argentina' }).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Revisar selección (1)' }).click();
    await page.getByRole('heading', { name: 'Revisá antes de confirmar' }).waitFor();
    await page.getByRole('button', { name: 'Confirmar moneda de estas variantes' }).click();
    await page.getByText(/Moneda confirmada. Los precios y saldos/).waitFor();
    const row = (await sql.query('SELECT price,price_currency,stock_available,inventory_revision FROM products WHERE owner_phone=$1 AND id=$2', [first.owner, oldSku.id])).rows[0];
    assert.deepEqual(row, { price: '65000', price_currency: 'ARS', stock_available: '2', inventory_revision: 1 });
    const receipt = (await sql.query("SELECT plan_json FROM inventory_operations WHERE owner_phone=$1 AND plan_json->'actions'->0->>'type'='sku.update'", [first.owner])).rows[0];
    assert.equal(receipt.plan_json.actions[0].changes.priceCurrency, 'ARS'); assert.equal(receipt.plan_json.actions[0].target.expectedRevision, 0);
    await api(second, `/api/inventory/selections/${encodeURIComponent((await sql.query('SELECT selection_id FROM inventory_selections WHERE owner_phone=$1', [first.owner])).rows[0].selection_id)}/confirm`, 'POST', { digest: 'wrong-owner' }, 409);
  });
  await check('single and model creation explicitly enforce each business currency and preserve retries', async () => {
    assert.deepEqual(await api(first, '/api/products', 'POST', legacyInput, 201), oldSku, 'Historical replay survives activation and correction without rewriting its original currency.');
    const input = { operationId: randomUUID(), name: 'Nueva Argentina L', size: 'L', stockAvailable: 1, price: 65000, priceCurrency: 'ARS' };
    const created = await api(first, '/api/products', 'POST', input, 201);
    assert.deepEqual(await api(first, '/api/products', 'POST', input, 201), created);
    const response = await fetch(fixture.apiUrl + '/api/products', { method: 'POST', headers: { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, operationId: randomUUID(), name: 'Moneda omitida', priceCurrency: undefined }) });
    assert.ok(!response.ok);
    const model = await api(second, '/api/products/model', 'POST', { operationId: randomUUID(), productType: 'Camiseta', productModel: 'Modelo propio', priceCurrency: 'UYU', variants: [{ size: 'S', stockAvailable: 2, price: 2500 }, { size: 'M', stockAvailable: 3, price: 2600 }] }, 201);
    assert.equal(model.length, 2); assert.ok(model.every(item => item.priceCurrency === 'UYU'));
    await api(second, commerce + '/products/' + fixture.products[0].id, 'GET', undefined, 404);
  });
  let productId;
  await check('pending selection creates a linked draft; actionable blockers lead to identity, photo, preparation and story', async () => {
    await page.getByRole('button', { name: /Pendientes/ }).click();
    await page.locator('.variant-row').filter({ hasText: 'Camiseta histórica Argentina' }).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Crear ficha y vincular', exact: true }).click();
    await page.getByLabel('Título comercial', { exact: true }).fill('Argentina titular 2026');
    await page.getByRole('button', { name: 'Crear ficha', exact: true }).click();
    await page.getByRole('heading', { name: 'Argentina titular 2026', exact: true }).waitFor();
    await page.waitForURL(/#\/products\/[a-f0-9-]{36}$/);
    productId = await page.evaluate(() => location.hash.split('/').at(-1));
    assert.equal((await api(first, commerce + '/products/' + productId)).variants[0].skuId, oldSku.id);
    await page.getByRole('button', { name: '← Volver a productos', exact: true }).click();
    await page.getByRole('button', { name: /Pendientes/ }).click();
    await page.locator('.variant-row').filter({ hasText: 'Nueva Argentina L' }).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Vincular a una ficha existente', exact: true }).click();
    await page.getByRole('button', { name: /Argentina titular 2026 · 1 SKU vinculados/ }).click();
    await page.getByRole('button', { name: 'Guardar vínculos', exact: true }).click();
    await page.getByText('Vínculos revisados y guardados.', { exact: true }).waitFor();
    assert.equal((await api(first, commerce + '/products/' + productId)).variants.length, 2);
    await page.getByRole('button', { name: '01 Información', exact: true }).click();
    assert.equal(await page.getByLabel('Tipo de equipo', { exact: true }).count(), 0);
    await page.getByLabel('Descripción · opcional', { exact: true }).fill('Camiseta disponible en varias presentaciones.');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).click(); await page.getByText('Ficha guardada.', { exact: true }).waitFor();
    await page.getByRole('button', { name: '03 Fotografías', exact: true }).click();
    const photo = await sharp({ create: { width: 500, height: 800, channels: 3, background: '#76c8ef' } }).png().toBuffer();
    await page.getByLabel('Subir fotografía', { exact: true }).setInputFiles({ name: 'fixture-onboarding.png', mimeType: 'image/png', buffer: photo });
    await page.getByText('Foto procesada y guardada.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Preparar ficha', exact: true }).click(); await page.getByText('Ficha preparada para generar contenido.', { exact: true }).waitFor();
    const started = Date.now(); await page.getByRole('button', { name: 'Generar historia ↗' }).click();
    await page.getByRole('button', { name: 'Generar previsualización', exact: true }).click();
    const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar PNG ↓' }).click();
    const download = await downloadPromise, metadata = await sharp(await fs.readFile(await download.path())).metadata();
    assert.equal(metadata.width, 1080); assert.equal(metadata.height, 1920); assert.ok(Date.now() - started < 60_000);
    console.log(`INFO self-service: prepared product to PNG ${Date.now() - started} ms (local fixture, desktop browser in mobile viewport)`);
    await page.getByRole('button', { name: '← Volver a la ficha' }).click();
  });
  await check('anonymous catalogue stays private until explicit configuration/publication; other tenant cannot link SKU', async () => {
    await api(first, commerce + '/catalog', 'PUT', { operationId: randomUUID(), expectedRevision: 0, slug: 'casacas-del-sur-test', publicEnabled: true });
    const detail = await api(first, commerce + '/products/' + productId);
    await api(first, commerce + '/products/' + productId + '/publication', 'PUT', { operationId: randomUUID(), expectedRevision: 0, expectedProductRevision: detail.revision, status: 'published', reason: 'Publicación de prueba revisada' });
    const response = await fetch(fixture.apiUrl + '/c/casacas-del-sur-test'); const html = await response.text(); assert.equal(response.status, 200); assert.ok(html.includes('Argentina titular 2026')); assert.ok(!html.includes(second.owner));
    assert.equal((await api(first, commerce + '/products?publication=published&photos=ready')).items.length, 1);
    assert.equal(detail.teamKey, null); assert.equal(detail.versionKey, null);
    assert.equal((await api(first, commerce + '/products?photos=missing')).items.length, 0);
    await api(second, commerce + '/products', 'POST', { operationId: randomUUID(), product: { title: 'Vínculo indebido' }, skuLinks: [{ skuId: oldSku.id, expectedRevision: 1, expectedFingerprint: 'wrong-tenant' }] }, 404);
  });
  await check('focus refresh updates inventory availability without overwriting dirty fields; external commercial revision blocks editing', async () => {
    await page.getByRole('button', { name: '01 Información', exact: true }).click(); await page.getByLabel('Título comercial', { exact: true }).fill('Borrador conservado');
    // Scoped fixture mutation only: simulate another inventory session.
    await sql.query('UPDATE products SET stock_available=1,inventory_revision=inventory_revision+1 WHERE owner_phone=$1 AND id=$2', [first.owner, oldSku.id]);
    await page.evaluate(() => dispatchEvent(new Event('focus')));
    await page.getByText('2 unidades disponibles', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Título comercial', { exact: true }).inputValue(), 'Borrador conservado');
    await sql.query('UPDATE commercial_products SET revision=revision+1 WHERE owner_phone=$1 AND id=$2', [first.owner, productId]);
    await page.evaluate(() => dispatchEvent(new Event('focus'))); await page.getByText(/La ficha cambió en otra pantalla/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Guardar cambios', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.ok(!requests.includes('/api/state'));
    assert.deepEqual(errors, []);
    await fs.mkdir(path.resolve('.fullmatch-runtime/browser'), { recursive: true });
    await page.screenshot({ path: path.resolve('.fullmatch-runtime/browser/onboarding-mobile.png'), fullPage: true });
  });
  await context.close();
  console.log(`Self-service acceptance: ${checks} checks passed with isolated PostgreSQL and actual HTTP/UI. No production state was read or changed.`);
} catch (error) {
  if (page) { await fs.mkdir(path.resolve('.fullmatch-runtime/browser'), { recursive: true }); await page.screenshot({ path: path.resolve('.fullmatch-runtime/browser/onboarding-failure.png'), fullPage: true }); console.log((await page.locator('body').innerText()).slice(0, 3000)); }
  throw error;
} finally { if (browser) await browser.close(); await sql.end().catch(() => {}); await fixture.stop(); }
