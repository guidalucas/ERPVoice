import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from 'playwright/test';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';
import { createDatabaseRuntime } from '../server/dbRuntime.js';

const fixture = await startCommerceFixture();
const runtime = createDatabaseRuntime({ connectionString: fixture.connection });
let browser;

const api = async (path, method = 'GET', body) => {
  const response = await fetch(`${fixture.apiUrl}/api/commerce/v1${path}`, {
    method, headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify({ ...body, operationId: randomUUID() }) } : {}),
  });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
};
const publication = id => api(`/products/${id}/publication`);
const hide = async id => {
  const product = await api(`/products/${id}`);
  return api(`/products/${id}/publication`, 'PUT', { expectedRevision: (await publication(id)).revision,
    expectedProductRevision: product.revision, status: 'hidden', reason: 'Isolated fixture' });
};
const publicProduct = product => fetch(`${fixture.apiUrl}/api/catalog/v1/fullmatch-demo/products/${product.slug}`);

try {
  const [first, beyondPage, other] = await Promise.all(fixture.products.map(({ id }) => api(`/products/${id}`)));
  const sku = (await api('/inventory-candidates')).items.find(item => item.name.includes('Boca'));
  assert.ok(sku);
  const draft = (await api('/products', 'POST', { product: { title: 'Ficha sin foto' },
    skuLinks: [{ skuId: sku.skuId, expectedRevision: sku.revision, expectedFingerprint: sku.identityFingerprint }] })).result;
  await hide(first.id);
  await hide(beyondPage.id);

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(({ token, owner }) => {
    localStorage.setItem('erpvoice.auth.token', token);
    localStorage.setItem('erpvoice.auth.phoneNumber', owner);
  }, { token: fixture.token, owner: fixture.owner });
  const select = product => page.getByRole('checkbox', { name: `Seleccionar ${product.title}`, exact: true });
  const publishAll = page.getByRole('button', { name: 'Publicar todas las fichas aptas', exact: true });
  const confirm = page.getByRole('button', { name: 'Sí, publicar', exact: true });
  const dialog = page.getByRole('dialog');
  await page.goto(fixture.url);
  await select(first).check();
  await select(draft).check();
  await select(other).check();
  const publishSelected = page.getByRole('button', { name: 'Publicar seleccionadas (2)', exact: true });
  await expect(page.getByRole('button', { name: 'Generar historias por lote (2) ↗', exact: true })).toBeEnabled();
  await publishSelected.click();
  await expect(dialog).toContainText('¿Publicar 2 fichas en el catálogo?');
  await page.getByRole('button', { name: 'No, cancelar', exact: true }).click();
  assert.equal((await publication(draft.id)).status, 'hidden');
  const otherRevision = (await publication(other.id)).revision;
  await publishSelected.click();
  await confirm.click();
  await expect(page.getByText('2 fichas publicadas.', { exact: true })).toBeVisible();
  assert.equal((await publicProduct(first)).status, 200);
  const draftPublic = await publicProduct(draft);
  assert.equal(draftPublic.status, 200);
  assert.deepEqual((await draftPublic.json()).product.photos, []);
  assert.equal((await publication(other.id)).revision, otherRevision);
  assert.equal((await publication(beyondPage.id)).status, 'hidden');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await hide(draft.id);
  await hide(other.id);
  await runtime.withClient(async client => {
    await client.query(`UPDATE commercial_products SET updated_at='2000-01-01T00:00:00.000001Z' WHERE owner_phone=$1 AND id=$2`, [fixture.owner, beyondPage.id]);
    await client.query(`INSERT INTO commercial_products(owner_phone,id,slug,title,created_by,updated_by,updated_at)
      SELECT $1,gen_random_uuid(),'test-blocked-'||n,'Bloqueada titular 2025 '||n,$1,$1,
        '2000-01-01T00:00:00.000001Z'::timestamptz + n * interval '1 microsecond' FROM generate_series(1,51) n`, [fixture.owner]);
  });
  await page.getByRole('textbox', { name: 'Buscar productos' }).fill('titular 2025');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.getByRole('button', { name: /Ver más productos/ })).toBeVisible();
  await expect(select(beyondPage)).toHaveCount(0);
  await publishAll.click();
  await expect(dialog).toContainText('¿Publicar 2 fichas en el catálogo?');
  await expect(dialog).toContainText('resultados filtrados');
  await hide(beyondPage.id); // Make the confirmed publication revision stale.
  await confirm.click();
  await expect(page.getByText('1 ficha publicada. No se pudo confirmar 1 publicación.', { exact: true })).toBeVisible();
  await expect(page.getByText(`${beyondPage.title} · La publicación cambió.`, { exact: false })).toBeVisible();
  assert.equal((await publicProduct(other)).status, 200);
  assert.equal((await publicProduct(beyondPage)).status, 404);
  await publishAll.click();
  await expect(dialog).toContainText('¿Publicar 1 ficha en el catálogo?');
  await confirm.click();
  await expect(page.getByText('1 ficha publicada.', { exact: true })).toBeVisible();
  assert.equal((await publicProduct(beyondPage)).status, 200);
  assert.equal((await publicProduct(draft)).status, 404);
  console.log('PASS: publish selected and filtered batches across pages, skip ineligible products, report conflicts and retry');
} finally {
  await browser?.close();
  await runtime.close();
  await fixture.stop();
}
