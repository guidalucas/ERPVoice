import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const prepares = [], replies = [], confirms = [], gets = [], errors = [], drafts = new Map();
  let mode = 'ok', writes = 0, release, failRefresh = false, identity = { phoneNumber: '5491100000000', tenantPhone: '5491100000000' };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('erpvoice.auth.token', 'universal-draft-ui'); localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000'); });
  const ready = (draftId, text, version = 1) => ({ draftId, version, text, status: 'awaiting_confirmation', digest: String(version).repeat(64), expiresAt: mode === 'expired' ? '2000-01-01T00:00:00.000Z' : '2099-10-17T12:00:00.000Z',
    plan: { actions: [{ itemId: 'stock' }, { itemId: 'account' }] }, evidence: [{ itemId: 'stock', quote: text }, { itemId: 'account', quote: text }],
    review: [{ itemId: 'stock', title: 'Ingreso de inventario', details: ['SKU Taladro (sku-1)', 'Disponible: 2 → 5', 'Unidad: unit'] }, { itemId: 'account', title: 'Cargo a cuenta', details: ['Cliente Ana (client-1)', 'Saldo: 0 → 7', 'Importe explícito: 7'] }] });
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/me') return json({ ...identity, role: 'owner', businessName: 'Draft UI', businessCategory: 'general', needsOnboarding: false, hasOwnBusiness: true });
    if (path === '/api/state') {
      if (failRefresh) { failRefresh = false; return json({ error: 'Datos desactualizados.' }, 503); }
      return json({ products: [{ id: 'sku-1', name: 'Taladro', stockAvailable: writes ? 5 : 2, stockReserved: 0, price: 99, unit: 'unit' }], clients: [], proveedores: [], pedidos: [], transactions: [] });
    }
    if (path === '/api/operation-drafts' && req.method() === 'POST') {
      const input = req.postDataJSON(); prepares.push(input); assert.deepEqual(Object.keys(input).sort(), ['requestId', 'text']);
      if (mode === 'hold-prepare') await new Promise(resolve => { release = resolve; });
      if (mode === 'prepare503') { mode = 'ok'; return json({ error: 'Interpretación no disponible.', code: 'INTERPRETATION_UNAVAILABLE' }, 503); }
      const draftId = `draft-${drafts.size + 1}`;
      const preview = mode === 'clarification' ? { draftId, text: input.text, version: 1, status: 'awaiting_clarification', question: '¿Cuántas unidades?', digest: 'a'.repeat(64), expiresAt: '2099-10-17T12:00:00.000Z' } : ready(draftId, input.text);
      if (mode === 'incomplete') preview.review.pop();
      drafts.set(draftId, preview); return json(preview);
    }
    const match = /^\/api\/operation-drafts\/([^/]+)(?:\/(confirm|cancel|replies))?$/.exec(path);
    if (match) {
      const [, draftId, action] = match, stored = drafts.get(draftId); assert.ok(stored);
      if (!action) { gets.push(draftId); return json(stored); }
      const input = req.postDataJSON();
      if (action === 'replies') {
        replies.push({ draftId, input }); assert.deepEqual(Object.keys(input).sort(), ['requestId', 'text', 'version']); assert.equal(input.version, stored.version);
        if (mode === 'reply503') { mode = 'ok'; return json({ error: 'Respuesta incierta.' }, 503); }
        const next = ready(draftId, `${stored.text}\n${input.text}`, stored.version + 1); drafts.set(draftId, next); return json(next);
      }
      assert.deepEqual(Object.keys(input).sort(), ['digest', 'version']);
      assert.deepEqual(input, { version: stored.version, digest: stored.digest });
      if (action === 'cancel') { const next = { ...stored, status: 'cancelled' }; drafts.set(draftId, next); return json(next); }
      confirms.push({ draftId, input });
      if (mode === 'hold-confirm') await new Promise(resolve => { release = resolve; });
      if (mode === 'conflict409') return json({ error: 'Revisión obsoleta.', code: 'DRAFT_VERSION_MISMATCH' }, 409);
      if (stored.status !== 'applied') { writes++; drafts.set(draftId, { ...stored, status: 'applied', result: { operationId: `draft-operation:${draftId}`, status: 'applied' } }); }
      if (mode === 'confirm503') { mode = 'ok'; return json({ error: 'Confirmación incierta.' }, 503); }
      if (mode === 'refresh503') { mode = 'ok'; failRefresh = true; }
      return json(drafts.get(draftId));
    }
    return json({});
  });
  await page.route('http://127.0.0.1:5173/**', async route => {
    const path = new URL(route.request().url()).pathname; if (path.startsWith('/api/')) return route.fallback();
    const root = resolve('dist'), file = resolve(root, `.${path === '/' ? '/index.html' : path}`); if (!file.startsWith(`${root}${sep}`)) return route.abort();
    try { return route.fulfill({ body: await readFile(file), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); } catch { return route.fulfill({ status: 404, body: '' }); }
  });
  const open = async () => { await page.getByRole('button', { name: 'Abrir simulador WhatsApp', exact: true }).click(); await page.getByRole('button', { name: 'Revisar operación', exact: true }).click(); await dialog.waitFor(); };
  const dialog = page.getByRole('dialog', { name: 'Revisar operación', exact: true });
  const button = name => dialog.getByRole('button', { name, exact: true });
  const consent = () => dialog.getByRole('checkbox', { name: 'Revisé todos los cambios y autorizo aplicar esta operación.', exact: true });
  const prepare = async () => { await dialog.getByLabel('Solicitud', { exact: true }).fill('Ingresaron tres taladros y cargá siete a Ana.'); await button('Preparar revisión').click(); };
  const waitHold = async () => { const deadline = Date.now() + 5000; while (!release && Date.now() < deadline) await page.waitForTimeout(20); assert.ok(release); };
  await page.goto('http://127.0.0.1:5173'); await open();
  return { page, dialog, button, consent, prepare, open, prepares, replies, confirms, gets, drafts, errors, waitHold, writes: () => writes, setMode: value => { mode = value; }, release: () => { mode = 'ok'; release(); release = undefined; }, setIdentity: value => { identity = value; } };
}
try {
  {
    const f = await fixture(); f.setMode('prepare503'); await f.prepare(); await f.dialog.getByRole('alert').getByText('Interpretación no disponible.', { exact: true }).waitFor();
    await f.button('Reintentar revisión').click(); await f.consent().waitFor(); assert.deepEqual(f.prepares[0], f.prepares[1]); assert.equal(f.writes(), 0);
    for (const detail of ['SKU Taladro (sku-1)', 'Disponible: 2 → 5', 'Unidad: unit', 'Cliente Ana (client-1)', 'Saldo: 0 → 7', 'Importe explícito: 7']) await f.dialog.getByText(detail, { exact: true }).waitFor();
    assert.equal(await f.button('Confirmar operación').isDisabled(), true); await f.consent().check(); f.setMode('hold-confirm');
    await f.button('Confirmar operación').evaluate(button => { button.click(); button.click(); }); await f.waitHold(); assert.equal(f.confirms.length, 1); assert.equal(await f.consent().isDisabled(), true);
    f.release(); await f.dialog.getByText('Operación aplicada correctamente.', { exact: true }).waitFor(); assert.equal(f.writes(), 1); assert.deepEqual(f.errors, []); await f.page.close();
  }
  {
    const f = await fixture(); f.setMode('hold-prepare'); await f.dialog.getByLabel('Solicitud', { exact: true }).fill('Ingresaron tres taladros.');
    await f.button('Preparar revisión').evaluate(button => { button.click(); button.click(); }); await f.waitHold(); assert.equal(f.prepares.length, 1); f.release(); await f.consent().waitFor(); await f.page.close();
  }
  {
    const f = await fixture(); await f.prepare(); await f.consent().check(); f.setMode('confirm503'); await f.button('Confirmar operación').click(); await f.dialog.getByText('Confirmación incierta.', { exact: true }).waitFor();
    assert.equal(f.writes(), 1); await f.page.reload(); await f.open(); await f.dialog.getByText('Operación aplicada correctamente.', { exact: true }).waitFor();
    assert.equal(f.gets.length, 1); assert.equal(f.confirms.length, 1); assert.equal(f.writes(), 1); assert.equal(await f.button('Confirmar operación').count(), 0); assert.deepEqual(f.errors, []); await f.page.close();
  }
  {
    const f = await fixture(); f.setMode('clarification'); await f.prepare(); await f.dialog.getByText('¿Cuántas unidades?', { exact: true }).waitFor();
    await f.dialog.getByLabel('Tu respuesta', { exact: true }).fill('Tres unidades.'); f.setMode('reply503'); await f.button('Enviar respuesta').click(); await f.dialog.getByText('Respuesta incierta.', { exact: true }).waitFor();
    await f.button('Enviar respuesta').click(); await f.consent().waitFor(); assert.deepEqual(f.replies[0], f.replies[1]); assert.equal(f.replies[0].input.version, 1); assert.equal(f.replies[0].input.text, 'Tres unidades.');
    await f.consent().check(); await f.button('Confirmar operación').click(); await f.dialog.getByText('Operación aplicada correctamente.', { exact: true }).waitFor(); assert.equal(f.confirms[0].input.version, 2); assert.equal(f.writes(), 1); await f.page.close();
  }
  {
    const f = await fixture(); await f.prepare(); await f.consent().check(); f.setMode('refresh503'); await f.button('Confirmar operación').click();
    await f.dialog.getByText('Operación aplicada correctamente.', { exact: true }).waitFor(); await f.dialog.getByText(/La operación está aplicada, pero no pudimos actualizar los datos/).waitFor();
    assert.equal(await f.button('Confirmar operación').count(), 0); await f.button('Actualizar datos').click(); await f.dialog.getByText(/La operación está aplicada, pero no pudimos actualizar los datos/).waitFor({ state: 'hidden' }); assert.equal(f.writes(), 1); assert.equal(f.confirms.length, 1); await f.page.close();
  }
  {
    const f = await fixture(); await f.prepare(); await f.consent().check(); f.setMode('conflict409'); await f.button('Confirmar operación').click();
    await f.dialog.getByText('La revisión cambió. Recuperá el estado antes de confirmar nuevamente.', { exact: true }).waitFor(); assert.equal(await f.button('Confirmar operación').isDisabled(), true); assert.equal(await f.consent().isChecked(), false);
    f.setMode('ok'); await f.button('Recuperar estado').click(); await f.dialog.getByText('La revisión cambió. Recuperá el estado antes de confirmar nuevamente.', { exact: true }).waitFor({ state: 'hidden' }); assert.equal(await f.button('Confirmar operación').isDisabled(), true);
    await f.consent().check(); await f.button('Confirmar operación').click(); await f.dialog.getByText('Operación aplicada correctamente.', { exact: true }).waitFor(); assert.equal(f.writes(), 1); await f.page.close();
  }
  for (const mode of ['expired', 'incomplete']) {
    const f = await fixture(); f.setMode(mode); await f.prepare(); await f.consent().waitFor(); assert.equal(await f.consent().isDisabled(), true); assert.equal(await f.button('Confirmar operación').isDisabled(), true); assert.equal(f.confirms.length, 0); assert.equal(f.writes(), 0); await f.page.close();
  }
  for (const changed of [{ phoneNumber: '5491100000001', tenantPhone: '5491100000000' }, { phoneNumber: '5491100000000', tenantPhone: '5491100000001' }]) {
    const f = await fixture(); await f.prepare(); await f.consent().waitFor();
    const original = await f.page.evaluate(() => localStorage.getItem('universal-draft:' + JSON.stringify(['5491100000000', '5491100000000']))); assert.ok(original);
    f.setIdentity(changed); await f.page.reload(); await f.open(); await f.dialog.getByLabel('Solicitud', { exact: true }).waitFor();
    assert.equal(await f.dialog.getByLabel('Solicitud', { exact: true }).inputValue(), ''); assert.equal(f.gets.length, 0); assert.equal(await f.consent().count(), 0);
    assert.equal(await f.page.evaluate(() => localStorage.getItem('universal-draft:' + JSON.stringify(['5491100000000', '5491100000000']))), original); await f.page.close();
  }
  console.log('Universal draft UI passed: complete review and consent, synchronous double-submit locks, stable prepare/reply retries, uncertain confirmation reload recovery, applied state with refresh failure, conflict recovery, expiry, and actor/tenant storage isolation.');
} finally { await browser.close(); }
