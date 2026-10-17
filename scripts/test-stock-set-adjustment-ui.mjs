import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const products = ['S', 'M'].map((size, index) => ({ id: `sku-${size}`, name: `Remera ${size}`, size, unit: index ? 'box' : 'unit', revision: 3, stockAvailable: 8 + index, stockReserved: index, price: 20, priceCurrency: 'ARS' }));
  const requests = [], confirms = [], selections = new Map(), pageErrors = [];
  let mode = 'ok', failRefresh = false, writes = 0, release, reads = 0;
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('erpvoice.auth.token', 'stock-set-ui'); localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000'); });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/me') return json({ phoneNumber: '5491100000000', tenantPhone: '5491100000000', role: 'owner', businessName: 'Sets UI', businessCategory: 'general', needsOnboarding: false, hasOwnBusiness: true });
    if (path === '/api/state') {
      reads++; if (failRefresh) { failRefresh = false; return json({ error: 'Falló la actualización del ajuste.' }, 503); }
      return json({ products, clients: [], proveedores: [], pedidos: [], transactions: [] });
    }
    if (path === '/api/inventory/selections' && request.method() === 'POST') {
      const input = request.postDataJSON(); requests.push(input);
      assert.equal(input.mutation.type, 'stock.adjust'); assert.deepEqual(Object.keys(input).sort(), ['mutation', 'requestId', 'selector']);
      if (mode === 'hold-preview') await new Promise(resolve => { release = resolve; });
      if (!selections.has(input.requestId)) {
        const preview = { selectionId: `selection-${selections.size + 1}`, digest: `digest-${selections.size + 1}`, expiresAt: '2099-10-17T12:00:00.000Z', status: 'pending', mutation: input.mutation,
          members: products.filter(product => input.selector.skuIds.includes(product.id)).map(product => ({ skuId: product.id, name: product.name, size: product.size, revision: product.revision, stockAvailable: product.stockAvailable, stockReserved: product.stockReserved, price: product.price, priceCurrency: product.priceCurrency, unit: product.unit, finalAvailable: input.mutation.balances.available ?? product.stockAvailable, finalReserved: input.mutation.balances.reserved ?? product.stockReserved })) };
        selections.set(input.requestId, { input, preview, result: null });
      } else assert.deepEqual(input, selections.get(input.requestId).input);
      if (mode === 'preview503') { mode = 'ok'; return json({ error: 'Vista previa incierta.' }, 503); }
      const preview = structuredClone(selections.get(input.requestId).preview);
      if (mode === 'forge-final') preview.members[0].finalAvailable++;
      if (mode === 'forge-unchanged') preview.members[0].finalReserved++;
      if (mode === 'forge-mutation') preview.mutation.balances.reserved = 99;
      if (mode === 'forge-unit') delete preview.members[0].unit;
      if (mode === 'forge-extra-balance') preview.mutation.balances.price = 1;
      return json(preview, 201);
    }
    if (/^\/api\/inventory\/selections\/[^/]+\/confirm$/.test(path)) {
      const input = request.postDataJSON(); confirms.push({ path, input }); assert.deepEqual(Object.keys(input), ['digest']);
      const stored = [...selections.values()].find(entry => entry.preview.selectionId === path.split('/').at(-2));
      assert.ok(stored); assert.equal(input.digest, stored.preview.digest);
      if (mode === 'hold-confirm') await new Promise(resolve => { release = resolve; });
      if (mode === 'stale409') return json({ error: 'Revisión obsoleta.', code: 'SELECTION_STALE' }, 409);
      if (!stored.result) {
        writes++; for (const member of stored.preview.members) Object.assign(products.find(product => product.id === member.skuId), { stockAvailable: member.finalAvailable, stockReserved: member.finalReserved, revision: member.revision + 1 });
        stored.result = { operationId: stored.preview.selectionId, items: stored.preview.members.map(member => ({ type: 'stock.adjust', skuId: member.skuId, stockAvailable: member.finalAvailable, stockReserved: member.finalReserved })) };
      }
      if (mode === 'confirm503') { mode = 'ok'; return json({ error: 'Ajuste aplicado con respuesta incierta.' }, 503); }
      if (mode === 'refresh503') { mode = 'ok'; failRefresh = true; }
      return json(stored.result);
    }
    return json({});
  });
  await page.route('http://127.0.0.1:5173/**', async route => {
    const path = new URL(route.request().url()).pathname; if (path.startsWith('/api/')) return route.fallback();
    const root = resolve('dist'), file = resolve(root, `.${path === '/' ? '/index.html' : path}`); if (!file.startsWith(`${root}${sep}`)) return route.abort();
    try { return route.fulfill({ body: await readFile(file), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://127.0.0.1:5173'); await page.getByRole('navigation', { name: 'Navegación del panel' }).getByRole('button', { name: 'Inventario', exact: true }).click();
  await page.getByRole('button', { name: 'Ajustar conjunto', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ajustar conjunto', exact: true });
  const available = () => dialog.getByLabel('Disponible absoluto (opcional)', { exact: true });
  const reserved = () => dialog.getByLabel('Reservado absoluto (opcional)', { exact: true });
  const reason = () => dialog.getByLabel('Motivo del ajuste', { exact: true });
  const review = () => dialog.getByRole('button', { name: 'Revisar ajuste', exact: true });
  const confirm = () => dialog.getByRole('button', { name: 'Confirmar ajuste', exact: true });
  const consent = () => dialog.getByRole('checkbox', { name: 'Confirmo los saldos finales de cada SKU revisado.', exact: true });
  const region = () => dialog.getByRole('region', { name: 'Vista previa del ajuste', exact: true });
  const prepare = async () => { for (const product of products) await dialog.getByLabel(`Seleccionar SKU ${product.id}`, { exact: true }).check(); await available().fill('12'); await reason().fill('  Conteo físico revisado  '); };
  const hydrate = async () => { const before = reads, deadline = Date.now() + 12000; while (reads === before && Date.now() < deadline) await page.waitForTimeout(30); assert.ok(reads > before); await page.waitForTimeout(100); };
  const waitHold = async () => { const deadline = Date.now() + 5000; while (!release && Date.now() < deadline) await page.waitForTimeout(20); assert.ok(release); };
  return { page, dialog, products, requests, confirms, pageErrors, prepare, available, reserved, reason, review, confirm, consent, region, hydrate, waitHold, writes: () => writes, setMode: value => { mode = value; }, release: () => { mode = 'ok'; release(); release = undefined; } };
}
try {
  {
    const f = await fixture(); await f.review().click(); await f.dialog.getByText('Seleccioná entre 1 y 100 SKU explícitos.', { exact: true }).waitFor(); assert.equal(f.requests.length, 0);
    await f.prepare(); await f.review().click(); await f.region().waitFor(); assert.equal(f.writes(), 0); assert.equal(f.confirms.length, 0);
    assert.deepEqual(f.requests[0].selector, { kind: 'ids', skuIds: ['sku-S', 'sku-M'] });
    assert.deepEqual(f.requests[0].mutation, { type: 'stock.adjust', balances: { available: 12 }, reason: 'Conteo físico revisado' });
    await f.region().getByText('Disponible: 8 → 12 · Reservado: 0 → 0', { exact: true }).waitFor();
    await f.region().getByText('Disponible: 9 → 12 · Reservado: 1 → 1', { exact: true }).waitFor();
    await f.region().getByText(/Unidad: box/).waitFor(); assert.equal(await f.confirm().isDisabled(), true);
    await f.consent().check(); await f.reserved().fill('0'); await f.region().waitFor({ state: 'hidden' }); assert.equal(await f.confirm().count(), 0);
    await f.review().click(); await f.region().waitFor(); assert.notEqual(f.requests[0].requestId, f.requests[1].requestId); assert.equal(await f.consent().isChecked(), false);
    await f.consent().check(); await f.confirm().click(); await f.dialog.waitFor({ state: 'hidden' }); assert.equal(f.writes(), 1); assert.ok(f.products.every(product => product.stockAvailable === 12 && product.stockReserved === 0)); assert.deepEqual(f.pageErrors, []); await f.page.close();
  }
  {
    const f = await fixture(); await f.prepare(); f.setMode('preview503'); await f.review().click(); await f.dialog.getByText('Vista previa incierta.', { exact: true }).waitFor();
    await f.dialog.getByRole('button', { name: 'Reintentar vista previa', exact: true }).click(); await f.region().waitFor(); assert.deepEqual(f.requests[0], f.requests[1]); assert.equal(f.writes(), 0); await f.page.close();
  }
  for (const failure of ['confirm503', 'refresh503']) {
    const f = await fixture(); await f.prepare(); await f.review().click(); await f.region().waitFor(); await f.consent().check(); f.setMode(failure); await f.confirm().click();
    await f.dialog.getByText(failure === 'confirm503' ? 'Ajuste aplicado con respuesta incierta.' : 'Falló la actualización del ajuste.', { exact: true }).waitFor();
    f.products[0].stockAvailable = 17; f.products[0].revision++; await f.hydrate();
    assert.equal(await f.consent().isChecked(), true); await f.region().getByText('Disponible: 8 → 12 · Reservado: 0 → 0', { exact: true }).waitFor();
    await f.confirm().click(); await f.dialog.waitFor({ state: 'hidden' }); assert.deepEqual(f.confirms[0], f.confirms[1]); assert.equal(f.writes(), 1); assert.equal(f.products[0].stockAvailable, 17); assert.deepEqual(f.pageErrors, []); await f.page.close();
  }
  {
    const f = await fixture(); await f.prepare(); await f.review().click(); await f.region().waitFor(); await f.consent().check(); f.setMode('stale409'); await f.confirm().click();
    await f.dialog.getByText(/El inventario cambió. Revisá una selección actualizada/).waitFor(); assert.equal(await f.confirm().isDisabled(), true); assert.equal(await f.consent().isChecked(), false); assert.equal(f.writes(), 0);
    f.products[0].stockAvailable = 21; f.products[0].revision++; await f.hydrate(); assert.equal(f.requests.length, 1); assert.equal(f.confirms.length, 1);
    f.setMode('ok'); await f.dialog.getByRole('button', { name: 'Revisar selección actualizada', exact: true }).click(); await f.region().getByText('Disponible: 21 → 12 · Reservado: 0 → 0', { exact: true }).waitFor();
    assert.notEqual(f.requests[0].requestId, f.requests[1].requestId); assert.equal(await f.confirm().isDisabled(), true); await f.consent().check(); await f.confirm().click(); await f.dialog.waitFor({ state: 'hidden' }); assert.notEqual(f.confirms[0].path, f.confirms[1].path); await f.page.close();
  }
  for (const forged of ['forge-final', 'forge-unchanged', 'forge-mutation', 'forge-unit', 'forge-extra-balance']) {
    const f = await fixture(); await f.prepare(); f.setMode(forged); await f.review().click(); await f.dialog.getByRole('alert').getByText(/La vista previa no coincide/).waitFor();
    assert.equal(await f.region().count(), 0); assert.equal(await f.confirm().count(), 0); assert.equal(f.writes(), 0); assert.equal(f.confirms.length, 0); assert.deepEqual(f.pageErrors, []); await f.page.close();
  }
  {
    const f = await fixture(); await f.prepare(); f.setMode('hold-preview'); await f.review().evaluate(button => { button.click(); button.click(); }); await f.waitHold();
    assert.equal(f.requests.length, 1); assert.equal(await f.available().isDisabled(), true); assert.equal(await f.dialog.getByLabel('Seleccionar SKU sku-S', { exact: true }).isDisabled(), true); assert.equal(await f.dialog.getByRole('button', { name: 'Cancelar', exact: true }).isDisabled(), true);
    f.release(); await f.region().waitFor(); await f.consent().check(); f.setMode('hold-confirm'); await f.confirm().evaluate(button => { button.click(); button.click(); }); await f.waitHold();
    assert.equal(f.confirms.length, 1); assert.equal(await f.consent().isDisabled(), true); assert.equal(await f.reason().isDisabled(), true); f.release(); await f.dialog.waitFor({ state: 'hidden' }); assert.equal(f.writes(), 1); assert.deepEqual(f.pageErrors, []); await f.page.close();
  }
  console.log('Stock SET adjustment UI passed: explicit IDs, absolute/unchanged balances, read-only per-SKU review, consent, draft reset, stable preview and confirmation retries after hydration/refresh failure, explicit stale re-review, forged planner rejection, and synchronous double-send locks.');
} finally { await browser.close(); }
