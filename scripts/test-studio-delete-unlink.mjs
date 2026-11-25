import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { chromium, expect } from 'playwright/test';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

// Isolated, disposable PostgreSQL and media store; never uses production data.
const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
let browser;
const api = async (route, method = 'GET', body, status = 200, token = fixture.token) => {
  const response = await fetch(`${fixture.apiUrl}/api/commerce/v1${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
};
const linkOf = item => ({ skuId: item.skuId, expectedRevision: item.revision, expectedFingerprint: item.identityFingerprint });
const publicStatus = async product => (await fetch(`${fixture.apiUrl}/api/catalog/v1/fullmatch-demo/products/${product.slug}`)).status;
try {
  await sql.connect();
  const inventoryBefore = (await sql.query('SELECT * FROM products ORDER BY id')).rows;
  let product = await api(`/products/${fixture.products[0].id}`);
  assert.ok(product.images.length); assert.ok(product.coverImageId); assert.ok(product.variants.length > 1);
  const allLinks = product.variants.map(linkOf), originalSkuIds = allLinks.map(item => item.skuId).sort();
  const publication = await api(`/products/${product.id}/publication`);
  assert.equal(publication.status, 'published'); assert.equal(await publicStatus(product), 200);

  // Revision conflicts and failed transactions must preserve links, images and visibility.
  const staleDelete = { operationId: randomUUID(), expectedRevision: product.revision - 1 };
  await api(`/products/${product.id}`, 'DELETE', staleDelete, 409);
  await api(`/products/${product.id}`, 'DELETE', { operationId: randomUUID(), expectedRevision: product.revision }, 403, fixture.member.token);
  assert.equal((await api(`/products/${product.id}`)).revision, product.revision);
  await sql.query(`CREATE FUNCTION reject_ficha_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'isolated rollback test'; END $$;
    CREATE TRIGGER reject_ficha_delete BEFORE DELETE ON commercial_products FOR EACH ROW EXECUTE FUNCTION reject_ficha_delete()`);
  await api(`/products/${product.id}`, 'DELETE', { operationId: randomUUID(), expectedRevision: product.revision }, 503);
  await sql.query('DROP TRIGGER reject_ficha_delete ON commercial_products; DROP FUNCTION reject_ficha_delete()');
  const afterRollback = await api(`/products/${product.id}`);
  assert.deepEqual(afterRollback.variants, product.variants); assert.deepEqual(afterRollback.images, product.images);
  assert.equal(afterRollback.coverImageId, product.coverImageId);
  assert.deepEqual(await api(`/products/${product.id}/publication`), publication);
  const partialCommand = { operationId: randomUUID(), expectedRevision: product.revision, skuLinks: allLinks.slice(1) };
  product = (await api(`/products/${product.id}/sku-links`, 'PUT', partialCommand)).result;
  assert.equal(product.status, 'ready'); assert.equal(await publicStatus(product), 200);
  assert.deepEqual(await api(`/products/${product.id}/publication`), publication);
  assert.ok((await api('/inventory-candidates?limit=100')).items.some(item => item.skuId === allLinks[0].skuId));
  assert.equal((await api(`/products/${product.id}/sku-links`, 'PUT', partialCommand)).result.revision, product.revision);
  console.log('PASS API: removing one SKU preserves the publication and returns the SKU to pending; conflicts and unauthorized deletion do not mutate');

  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ token, owner }) => {
    localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner);
  }, fixture);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const button = name => page.getByRole('button', { name, exact: true });
  await page.goto(`${fixture.url}#/products/${product.id}`);
  await expect(button('Eliminar ficha')).toBeEnabled();
  await button('02 SKU vinculados').click();
  await expect(button('Desvincular todos')).toBeEnabled();
  await button('Desvincular todos').click();
  assert.equal((await api(`/products/${product.id}`)).variants.length, allLinks.length - 1, 'Deselecting is only a local change');
  await button('Guardar vínculos').click();
  await expect(page.getByRole('status').filter({ hasText: 'La ficha quedó en borrador y se ocultó del catálogo.' })).toBeVisible();
  product = await api(`/products/${product.id}`);
  assert.equal(product.status, 'draft'); assert.equal(product.variants.length, 0);
  assert.equal((await api(`/products/${product.id}/publication`)).status, 'hidden');
  assert.equal(await publicStatus(product), 404);
  const pendingIds = (await api('/inventory-candidates?limit=100')).items.map(item => item.skuId);
  assert.ok(originalSkuIds.every(id => pendingIds.includes(id)));
  assert.ok(product.coverImageId); assert.ok(product.images.length);
  await button('← Volver a productos').click();
  await page.getByRole('navigation', { name: 'Navegación de Studio' }).getByRole('button', { name: /Pendientes/ }).click();
  await page.waitForFunction(() => document.querySelector('.pending-product-list')?.getAttribute('aria-busy') === 'false');
  for (const name of new Set(inventoryBefore.filter(item => originalSkuIds.includes(item.id)).map(item => item.name))) {
    const group = page.locator('.pending-product').filter({ has: page.getByText(name, { exact: true }) });
    await expect(group).toBeVisible();
    await group.locator('.pending-product-toggle').click();
  }
  const checkboxes = await page.locator('.pending-variant input').count();
  assert.ok(checkboxes >= originalSkuIds.length, 'Released SKUs appear in the pending UI');
  console.log('PASS UI: unlinking every SKU saves a draft, hides the catalog entry, preserves photos and returns SKUs to Pending on mobile');

  // Re-link and re-publish, then exercise deletion with a cover and public photos.
  product = (await api(`/products/${product.id}/sku-links`, 'PUT', { operationId: randomUUID(), expectedRevision: product.revision, skuLinks: allLinks })).result;
  const hidden = await api(`/products/${product.id}/publication`);
  await api(`/products/${product.id}/publication`, 'PUT', { operationId: randomUUID(), expectedRevision: hidden.revision,
    expectedProductRevision: product.revision, status: 'published', reason: 'Isolated deletion test' });
  product = await api(`/products/${product.id}`);
  await page.goto(`${fixture.url}#/products/${product.id}`);
  await expect(button('Eliminar ficha')).toBeEnabled();
  await button('Eliminar ficha').click();
  const confirmation = page.getByRole('dialog', { name: /¿Eliminar la ficha/ });
  await confirmation.getByRole('button', { name: 'No, cancelar', exact: true }).click();
  assert.equal((await api(`/products/${product.id}`)).revision, product.revision, 'Cancel must preserve the ficha');
  const output = path.resolve('.fullmatch-runtime/delete-unlink'); await fs.mkdir(output, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `delete-${width}.png`), fullPage: true });
  }
  const deletion = page.waitForRequest(request => request.method() === 'DELETE' && request.url().endsWith(`/products/${product.id}`));
  await button('Eliminar ficha').click();
  await confirmation.getByRole('button', { name: 'Sí, eliminar ficha', exact: true }).click();
  const deleteCommand = (await deletion).postDataJSON();
  await page.waitForURL(/#\/products$/);
  await expect(page.getByRole('heading', { name: /^(Productos comerciales|Pendientes de catalogar)/ })).toBeVisible();
  const receipt = await api(`/products/${product.id}`, 'DELETE', deleteCommand);
  assert.deepEqual(receipt.result, { id: product.id, deleted: true, releasedSkuIds: originalSkuIds });
  assert.deepEqual(await api(`/operations/${deleteCommand.operationId}`), receipt);
  await api(`/products/${product.id}`, 'GET', undefined, 404);
  await api(`/products/${product.id}`, 'DELETE', { operationId: randomUUID(), expectedRevision: product.revision }, 404);
  await api(`/products/${product.id}`, 'DELETE', { ...deleteCommand, expectedRevision: product.revision + 1 }, 409);
  assert.equal(await publicStatus(product), 404);
  for (const table of ['commercial_product_skus', 'commercial_product_images', 'commercial_publications']) {
    assert.equal((await sql.query(`SELECT count(*)::int AS count FROM ${table} WHERE owner_phone=$1 AND commercial_product_id=$2`, [fixture.owner, product.id])).rows[0].count, 0);
  }
  const releasedIds = (await api('/inventory-candidates?limit=100')).items.map(item => item.skuId);
  assert.ok(originalSkuIds.every(id => releasedIds.includes(id)));
  assert.ok(!(await api('/products')).items.some(item => item.id === product.id));
  // Archived fichas also release their links when deleted, without being restored first.
  let archived = (await api('/products', 'POST', { operationId: randomUUID(), product: { title: 'Archived deletion test' }, skuLinks: allLinks }, 201)).result;
  archived = (await api(`/products/${archived.id}/status`, 'POST', { operationId: randomUUID(), expectedRevision: archived.revision, status: 'archived', reason: 'Isolated archive test' })).result;
  assert.equal((await api(`/products/${archived.id}`, 'DELETE', { operationId: randomUUID(), expectedRevision: archived.revision })).result.deleted, true);
  const afterArchivedDelete = (await api('/inventory-candidates?limit=100')).items.map(item => item.skuId);
  assert.ok(originalSkuIds.every(id => afterArchivedDelete.includes(id)));
  assert.deepEqual((await sql.query('SELECT * FROM products ORDER BY id')).rows, inventoryBefore);
  assert.deepEqual(errors, []);
  console.log('PASS UI/API: cancel/delete published ficha with photos; retry/recovery is idempotent, removed from collection/catalog, all SKUs pending, inventory unchanged');
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
