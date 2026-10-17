import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Real built frontend, real Edge; only the API transport is replaced.
const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const originalIds = ['sku-s', 'sku-m'];
async function fixture(mode = '') {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const products = ['S', 'M'].map((size, index) => ({ id: originalIds[index], name: `Camiseta Argentina ${size}`, productType: 'Camiseta', productModel: 'Argentina', size, revision: 4, stockAvailable: 8 + index, stockReserved: index, price: 65000, priceCurrency: 'ARS' }));
  const previews = [];
  const confirms = [];
  const selections = new Map();
  let writes = 0;
  let failRefresh = false;
  await page.addInitScript(() => {
    localStorage.setItem('erpvoice.auth.token', 'local-ui-test');
    localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000');
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/me') return json({ phoneNumber: '5491100000000', tenantPhone: '5491100000000', role: 'owner', businessName: 'Prueba', businessCategory: 'indumentaria', needsOnboarding: false, pendingInvite: null, hasOwnBusiness: true });
    if (path === '/api/state') {
      if (failRefresh) { failRefresh = false; return json({ error: 'Falló la actualización del inventario.' }, 503); }
      return json({ products, clients: [], proveedores: [], pedidos: [], transactions: [] });
    }
    if (path === '/api/inventory/selections' && request.method() === 'POST') {
      const input = request.postDataJSON();
      previews.push(input);
      if (previews.length === 1) products.push({ ...products[0], id: 'new-sku-l', name: 'Camiseta Argentina L', size: 'L' });
      if (!selections.has(input.requestId)) selections.set(input.requestId, {
        selectionId: `selection-${selections.size + 1}`, digest: `digest-${selections.size + 1}`,
        expiresAt: '2099-10-16T12:00:00.000Z', status: 'pending', mutation: input.mutation,
        members: products.filter((product) => input.selector.skuIds.includes(product.id)).map(({ id, ...product }) => ({ ...product, skuId: id })),
      });
      if (mode === 'preview503' && previews.length === 1) return json({ error: 'Vista previa temporalmente no disponible.' }, 503);
      const preview = structuredClone(selections.get(input.requestId));
      if (mode === 'bad-members') preview.members.push({ ...preview.members[0], skuId: 'unexpected-sku' });
      if (mode === 'bad-digest') preview.digest = '';
      if (mode === 'extra-mutation') preview.mutation.changes.price = 0;
      return json(preview, 201);
    }
    if (path === '/api/products/model' && request.method() === 'PUT') {
      const input = request.postDataJSON();
      confirms.push(input);
      assert.deepEqual(Object.keys(input).sort(), ['digest', 'selectionId']);
      const preview = [...selections.values()].find((item) => item.selectionId === input.selectionId);
      assert.equal(input.digest, preview.digest);
      if (mode === 'stale409' && confirms.length === 1) return json({ error: 'La selección cambió.' }, 409);
      if (!preview.applied) {
        preview.applied = true;
        writes += 1;
        products.filter((product) => preview.members.some((member) => member.skuId === product.id)).forEach((product) => Object.assign(product, preview.mutation.changes));
      }
      if (mode === 'confirm503' && confirms.length === 1) return json({ error: 'Resultado incierto. Reintentá.' }, 503);
      if (mode === 'refresh503' && confirms.length === 1) failRefresh = true;
      return json(products.filter((product) => preview.members.some((member) => member.skuId === product.id)));
    }
    return json({});
  });
  await page.route('http://127.0.0.1:5173/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/')) return route.fallback();
    const file = resolve('dist', `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(resolve('dist'))) return route.abort();
    try { return route.fulfill({ body: await readFile(file), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://127.0.0.1:5173');
  await page.getByRole('navigation', { name: 'Navegación del panel' }).getByRole('button', { name: 'Inventario' }).click();
  await page.getByRole('button', { name: 'Ver talles de Camiseta Argentina' }).click();
  await page.getByRole('button', { name: 'Editar modelo Camiseta Argentina' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar modelo Camiseta Argentina' });
  await dialog.getByLabel('Modelo', { exact: true }).fill('Argentina Selección');
  await dialog.getByLabel('Motivo del cambio').fill('Corrección de catálogo');
  const review = async () => {
    await dialog.getByRole('button', { name: 'Revisar cambios', exact: true }).click();
    await dialog.getByRole('region', { name: 'Vista previa de cambios' }).waitFor();
  };
  return { page, dialog, review, previews, confirms, products, writes: () => writes };
}

try {
  {
    const f = await fixture();
    await f.review();
    assert.equal(f.confirms.length, 0);
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.previews[0].selector, { kind: 'ids', skuIds: originalIds });
    assert.match(f.previews[0].requestId, /^[\da-f-]{36}$/i);
    const region = f.dialog.getByRole('region', { name: 'Vista previa de cambios' });
    await region.getByText('2 SKU seleccionados · Nuevo nombre: Camiseta Argentina Selección', { exact: true }).waitFor();
    await region.getByText('Camiseta Argentina S', { exact: true }).waitFor();
    await region.getByText(/Disponible: 8 · Reservado: 0/).waitFor();
    assert.equal(await region.getByText(/new-sku-l/).count(), 0);
    await f.dialog.getByRole('button', { name: 'Cancelar' }).click();
    assert.equal(f.writes(), 0);
    await f.page.close();
  }
  for (const mode of ['preview503', 'confirm503', 'refresh503']) {
    const f = await fixture(mode);
    if (mode === 'preview503') {
      await f.dialog.getByRole('button', { name: 'Revisar cambios', exact: true }).click();
      await f.dialog.getByRole('alert').waitFor();
      assert.equal(f.confirms.length, 0);
      await f.review();
      assert.deepEqual(f.previews[0], f.previews[1]);
    } else await f.review();
    await f.dialog.getByRole('button', { name: 'Confirmar cambios' }).click();
    if (mode !== 'preview503') {
      await f.dialog.getByRole('alert').waitFor();
      assert.equal(await f.dialog.getByRole('region', { name: 'Vista previa de cambios' }).isVisible(), true);
      await f.dialog.getByRole('button', { name: 'Confirmar cambios' }).click();
      assert.deepEqual(f.confirms[0], f.confirms[1]);
    }
    await f.dialog.waitFor({ state: 'hidden' });
    assert.equal(f.writes(), 1);
    assert.equal(f.products.find((product) => product.id === 'new-sku-l').productModel, 'Argentina');
    await f.page.close();
  }
  {
    const f = await fixture('stale409');
    await f.review();
    await f.dialog.getByRole('button', { name: 'Confirmar cambios' }).click();
    await f.dialog.getByRole('alert').getByText(/Tu borrador y vista previa se conservan/).waitFor();
    assert.equal(f.previews.length, 1);
    assert.equal(f.writes(), 0);
    assert.equal(await f.dialog.getByLabel('Modelo', { exact: true }).inputValue(), 'Argentina Selección');
    assert.equal(await f.dialog.getByRole('button', { name: 'Confirmar cambios' }).count(), 0);
    await f.dialog.getByRole('button', { name: 'Revisar selección actualizada' }).click();
    await f.dialog.getByRole('button', { name: 'Confirmar cambios' }).waitFor();
    assert.equal(f.previews.length, 2);
    assert.notEqual(f.previews[0].requestId, f.previews[1].requestId);
    assert.deepEqual(f.previews[1].selector.skuIds, originalIds);
    assert.equal(f.confirms.length, 1);
    await f.dialog.getByRole('button', { name: 'Confirmar cambios' }).click();
    await f.dialog.waitFor({ state: 'hidden' });
    assert.notEqual(f.confirms[0].selectionId, f.confirms[1].selectionId);
    await f.page.close();
  }
  {
    const f = await fixture();
    await f.review();
    await f.dialog.getByLabel('Motivo del cambio').fill('Otro motivo');
    assert.equal(await f.dialog.getByRole('button', { name: 'Confirmar cambios' }).count(), 0);
    await f.review();
    assert.notEqual(f.previews[0].requestId, f.previews[1].requestId);
    await f.dialog.getByLabel('Modelo', { exact: true }).fill('Argentina Final');
    assert.equal(await f.dialog.getByRole('region', { name: 'Vista previa de cambios' }).count(), 0);
    await f.review();
    assert.notEqual(f.previews[1].requestId, f.previews[2].requestId);
    assert.equal(f.confirms.length, 0);
    await f.page.close();
  }
  for (const mode of ['bad-members', 'bad-digest', 'extra-mutation']) {
    const f = await fixture(mode);
    await f.dialog.getByRole('button', { name: 'Revisar cambios', exact: true }).click();
    await f.dialog.getByRole('alert').getByText(/no coincide/).waitFor();
    assert.equal(await f.dialog.getByRole('button', { name: 'Confirmar cambios' }).count(), 0);
    assert.equal(f.confirms.length, 0);
    await f.page.close();
  }
  console.log('Inventory selection UI: preview, frozen membership, cancel, retries, stale review, draft invalidation and response validation passed.');
} finally { await browser.close(); }
