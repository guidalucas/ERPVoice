import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Real built frontend, real Edge; only the API transport is replaced.
const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
const originalIds = ['sku-s', 'sku-m'];
async function fixture(mode = '', single = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const products = ['S', 'M'].map((size, index) => ({ id: originalIds[index], name: `Camiseta Argentina ${size}`, productType: 'Camiseta', productModel: 'Argentina', size, revision: 4, stockAvailable: 8 + index, stockReserved: 0, price: 65000, priceCurrency: 'ARS' }));
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
      return json({ products: products.filter((product) => !product.inactive), clients: [], proveedores: [], pedidos: [], transactions: [] });
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
      if (mode === 'reserved') return json({ error: 'SKU_HAS_RESERVATIONS: No se puede desactivar un SKU con reservas.' }, 409);
      if (mode === 'preview503' && previews.length === 1) return json({ error: 'Vista previa temporalmente no disponible.' }, 503);
      const preview = structuredClone(selections.get(input.requestId));
      if (mode === 'bad-members') preview.members.pop();
      if (mode === 'bad-digest') preview.digest = '';
      if (mode === 'extra-mutation') preview.mutation.changes = {};
      return json(preview, 201);
    }
    if (path.startsWith('/api/products/') && request.method() === 'DELETE') {
      const input = request.postDataJSON();
      confirms.push(input);
      assert.deepEqual(Object.keys(input).sort(), ['digest', 'selectionId']);
      const preview = [...selections.values()].find((item) => item.selectionId === input.selectionId);
      assert.equal(input.digest, preview.digest);
      assert.equal(path, single ? '/api/products/sku-s' : '/api/products/batch');
      if (single) assert.deepEqual(preview.members.map((member) => member.skuId), ['sku-s']);
      if (mode === 'stale409' && confirms.length === 1) return json({ error: 'La selección cambió.' }, 409);
      if (!preview.applied) {
        preview.applied = true;
        writes += 1;
        products.filter((product) => preview.members.some((member) => member.skuId === product.id)).forEach((product) => Object.assign(product, { inactive: true }));
      }
      if (mode === 'confirm503' && confirms.length === 1) return json({ error: 'Resultado incierto. Reintentá.' }, 503);
      if (mode === 'refresh503' && confirms.length === 1) failRefresh = true;
      return json({ deleted: preview.members.length, operationResult: { replayed: confirms.length > 1 } });
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
  if (single) await page.getByRole('button', { name: 'Desactivar talle S de Camiseta Argentina', exact: true }).click();
  else {
    await page.getByRole('checkbox', { name: 'Seleccionar modelo Camiseta Argentina', exact: true }).check();
    await page.getByRole('button', { name: 'Desactivar seleccionados' }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'Desactivar productos' });
  await dialog.getByLabel('Motivo de la desactivación').fill('Fin de temporada');
  const review = async () => {
    await dialog.getByRole('button', { name: 'Revisar desactivación', exact: true }).click();
    await dialog.getByRole('region', { name: 'Vista previa de desactivación' }).waitFor();
  };
  return { page, dialog, review, previews, confirms, products, writes: () => writes };
}

try {
  for (const single of [true, false]) {
    const f = await fixture('', single);
    await f.review();
    assert.equal(f.confirms.length, 0);
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.previews[0].selector, { kind: 'ids', skuIds: single ? ['sku-s'] : originalIds });
    assert.deepEqual(f.previews[0].mutation, { type: 'sku.deactivate', reason: 'Fin de temporada' });
    await f.dialog.getByText('Se desactivarán y saldrán del inventario activo; se conservan stock e historial.').waitFor();
    await f.dialog.getByRole('region').getByText(/Disponible: 8 · Reservado: 0/).waitFor();
    await f.dialog.getByRole('button', { name: 'Cancelar' }).click();
    assert.equal(f.writes(), 0);
    await f.page.close();
  }
  for (const single of [true, false]) for (const mode of ['preview503', 'confirm503', 'refresh503']) {
    const f = await fixture(mode, single);
    if (mode === 'preview503') {
      await f.dialog.getByRole('button', { name: 'Revisar desactivación', exact: true }).click();
      await f.dialog.getByRole('alert').waitFor();
      await f.review();
      assert.deepEqual(f.previews[0], f.previews[1]);
    } else await f.review();
    await f.dialog.getByRole('button', { name: 'Confirmar desactivación' }).click();
    if (mode !== 'preview503') {
      await f.dialog.getByRole('alert').waitFor();
      await f.dialog.getByRole('region').waitFor();
      await f.dialog.getByRole('button', { name: 'Confirmar desactivación' }).click();
      assert.deepEqual(f.confirms[0], f.confirms[1]);
    }
    await f.dialog.waitFor({ state: 'hidden' });
    assert.equal(f.writes(), 1);
    assert.equal(await f.page.getByRole('checkbox', { name: 'Seleccionar talle S de Camiseta Argentina', exact: true }).count(), 0);
    assert.equal(f.products.find((product) => product.id === 'sku-s').stockAvailable, 8);
    assert.equal(f.products.find((product) => product.id === 'new-sku-l').inactive, undefined);
    await f.page.close();
  }
  {
    const f = await fixture('stale409');
    await f.review();
    await f.dialog.getByRole('button', { name: 'Confirmar desactivación' }).click();
    await f.dialog.getByRole('alert').getByText(/Tu motivo y vista previa se conservan/).waitFor();
    assert.equal(await f.dialog.getByLabel('Motivo de la desactivación').inputValue(), 'Fin de temporada');
    await f.dialog.getByRole('region').waitFor();
    assert.equal(f.writes(), 0);
    assert.equal(await f.dialog.getByRole('button', { name: 'Confirmar desactivación' }).count(), 0);
    await f.dialog.getByRole('button', { name: 'Revisar selección actualizada' }).click();
    await f.dialog.getByRole('button', { name: 'Confirmar desactivación' }).waitFor();
    assert.notEqual(f.previews[0].requestId, f.previews[1].requestId);
    assert.deepEqual(f.previews[1].selector.skuIds, originalIds);
    await f.dialog.getByRole('button', { name: 'Confirmar desactivación' }).click();
    await f.dialog.waitFor({ state: 'hidden' });
    assert.equal(f.writes(), 1);
    await f.page.close();
  }
  {
    const f = await fixture();
    await f.review();
    await f.dialog.getByLabel('Motivo de la desactivación').fill('Otro motivo');
    assert.equal(await f.dialog.getByRole('region').count(), 0);
    await f.review();
    assert.notEqual(f.previews[0].requestId, f.previews[1].requestId);
    assert.equal(f.confirms.length, 0);
    await f.page.close();
  }
  for (const mode of ['bad-members', 'bad-digest', 'extra-mutation', 'reserved']) {
    const f = await fixture(mode);
    await f.dialog.getByRole('button', { name: 'Revisar desactivación', exact: true }).click();
    await f.dialog.getByRole('alert').getByText(mode === 'reserved' ? /SKU_HAS_RESERVATIONS/ : /no coincide/).waitFor();
    assert.equal(await f.dialog.getByRole('button', { name: 'Confirmar desactivación' }).count(), 0);
    assert.equal(f.confirms.length, 0);
    assert.equal(f.writes(), 0);
    await f.page.close();
  }
  console.log('Inventory deactivation UI: single/bulk review, cancel, fixed membership, stable retries, stale review, validation, reservations and active refresh passed.');
} finally { await browser.close(); }
