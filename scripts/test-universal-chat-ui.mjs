import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
async function fixture() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const prepares = [], replies = [], confirms = [], gets = [], errors = [], forbidden = [], transcriptions = [], external = [], drafts = new Map();
  let mode = 'ok', writes = 0, release, failRefresh = false, identity = { phoneNumber: '5491100000000', tenantPhone: '5491100000000' };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:5173' && !['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) external.push(request.url());
  });
  await page.addInitScript(() => { localStorage.setItem('erpvoice.auth.token', 'universal-draft-ui'); localStorage.setItem('erpvoice.auth.phoneNumber', '5491100000000'); });
  await page.addInitScript(() => {
    window.audioTracksStopped = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: () => { window.audioTracksStopped++; } }] }),
    } });
    window.MediaRecorder = class {
      state = 'inactive'; mimeType = 'audio/webm';
      constructor(stream) { this.stream = stream; }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['private-audio-fixture'], { type: this.mimeType }) });
        this.onstop?.();
      }
    };
  });
  const ready = (draftId, text, version = 1) => ({ draftId, version, text, status: 'awaiting_confirmation', digest: String(version).repeat(64), expiresAt: mode === 'expired' ? '2000-01-01T00:00:00.000Z' : '2099-10-17T12:00:00.000Z',
    plan: { actions: [{ itemId: 'stock' }, { itemId: 'account' }] }, evidence: [{ itemId: 'stock', quote: text }, { itemId: 'account', quote: text }],
    review: [{ itemId: 'stock', title: 'Ingreso de inventario', details: ['SKU Taladro (sku-1)', 'Disponible: 2 → 5', 'Unidad: unit'] }, { itemId: 'account', title: 'Cargo a cuenta', details: ['Cliente Ana (client-1)', 'Saldo: 0 → 7', 'Importe explícito: 7'] }] });
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (/parse|state\/apply/.test(path)) forbidden.push(path);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/voice/transcribe') {
      transcriptions.push({ url: req.url(), headers: req.headers(), body: req.postData(), method: req.method() });
      assert.equal(req.headers().authorization, 'Bearer universal-draft-ui');
      assert.equal(req.headers()['content-type'], 'audio/webm');
      assert.equal(req.method(), 'POST'); assert.equal(req.postData(), 'private-audio-fixture');
      if (mode === 'hold-transcription') await new Promise(resolve => { release = resolve; });
      if (mode === 'transcription503') { mode = 'ok'; return json({ error: 'Transcripción no disponible.', code: 'TRANSCRIPTION_UNAVAILABLE' }, 503); }
      return json({ text: '  Ingresaron tres taladros y cargá siete a Ana.  ' });
    }
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
      const preview = mode === 'query' ? { draftId, text: input.text, version: 1, status: 'answered', digest: 'a'.repeat(64), expiresAt: '2099-10-17T12:00:00.000Z', answer: { text: 'Taladro: 2 disponibles.\nPrecio: $99.\nNo hay reservas.', items: [{ productName: 'Taladro', stockAvailable: 2, price: 99 }] } } : mode === 'clarification' ? { draftId, text: input.text, version: 1, status: 'awaiting_clarification', question: '¿Cuántas unidades?', digest: 'a'.repeat(64), expiresAt: '2099-10-17T12:00:00.000Z' } : ready(draftId, input.text);
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
        if (mode === 'correction422') { mode = 'ok'; return json({ error: 'Corrección inválida.', code: 'INTERPRETATION_INVALID' }, 422); }
        if (mode === 'correction-unpersisted503') { mode = 'ok'; return json({ error: 'Corrección no guardada.', code: 'INTERPRETATION_UNAVAILABLE' }, 503); }
        const next = ready(draftId, `${stored.text}\n${input.text}`, stored.version + 1);
        if (input.text === 'Ahora son cuatro.') {
          next.review[0].details[1] = 'Disponible: 2 → 6';
          assert.deepEqual(next.plan.actions.map(({ itemId }) => itemId), stored.plan.actions.map(({ itemId }) => itemId));
          assert.deepEqual(next.review[1], stored.review[1]);
        }
        drafts.set(draftId, next);
        if (mode === 'correction503') { mode = 'ok'; return json({ error: 'Corrección guardada con respuesta incierta.' }, 503); }
        return json(next);
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
  await page.goto('http://127.0.0.1:5173'); await page.getByRole('button', { name: 'Abrir simulador WhatsApp', exact: true }).click();
  return { page, dialog, button, consent, prepare, open, forbidden, prepares, replies, confirms, gets, drafts, errors, transcriptions, external, waitHold, writes: () => writes, setMode: value => { mode = value; }, release: () => { mode = 'ok'; release(); release = undefined; }, setIdentity: value => { identity = value; } };
}
const send = async (f, text) => {
  await f.page.getByPlaceholder('Escribí un mensaje...').fill(text);
  await f.page.getByRole('button', { name: 'Enviar mensaje', exact: true }).click();
  await f.dialog.waitFor();
};
try {
  {
    const f = await fixture();
    f.setMode('hold-transcription');
    await f.page.getByRole('button', { name: 'Grabar audio', exact: true }).click();
    await f.page.getByRole('button', { name: 'Detener grabación', exact: true }).click();
    await f.waitHold();
    await f.page.getByRole('status').getByText('Recibí tu audio. Lo estoy procesando…', { exact: true }).waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Grabar audio', exact: true }).isDisabled(), true);
    f.release();
    await f.dialog.waitFor();
    assert.equal(await f.page.getByText('Recibí tu audio. Lo estoy procesando…', { exact: true }).count(), 0);
    const transcript = 'Ingresaron tres taladros y cargá siete a Ana.';
    assert.equal(await f.dialog.getByLabel('Solicitud', { exact: true }).inputValue(), transcript);
    assert.equal(f.transcriptions.length, 1); assert.equal(f.prepares.length, 0); assert.equal(f.writes(), 0);
    assert.equal(await f.page.evaluate(() => window.audioTracksStopped), 1);
    const stored = await f.page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('universal-chat-input:')));
    assert.ok(stored.some(([, value]) => value.includes(transcript)));
    assert.ok(stored.every(([, value]) => !value.includes('private-audio-fixture')));
    await f.page.reload(); await f.open();
    assert.equal(await f.dialog.getByLabel('Solicitud', { exact: true }).inputValue(), transcript);
    await f.button('Preparar revisión').click(); await f.consent().waitFor();
    assert.equal(f.prepares.length, 1); assert.equal(f.writes(), 0);
    assert.deepEqual(f.forbidden, []); assert.deepEqual(f.external, []); assert.deepEqual(f.errors, []);
    await f.page.close();
  }
  {
    const f = await fixture(); const input = f.page.getByPlaceholder('Escribí un mensaje...');
    await input.fill('Texto que no debe perderse'); f.setMode('transcription503');
    await f.page.getByRole('button', { name: 'Grabar audio', exact: true }).click();
    await f.page.getByRole('button', { name: 'Detener grabación', exact: true }).click();
    await f.page.getByText('Transcripción no disponible.', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), 'Texto que no debe perderse');
    assert.equal(f.prepares.length, 0); assert.equal(f.writes(), 0); assert.equal(await f.dialog.count(), 0);
    await f.page.getByRole('button', { name: 'Grabar audio', exact: true }).click();
    await f.page.getByRole('button', { name: 'Detener grabación', exact: true }).click();
    await f.dialog.waitFor(); assert.equal(f.transcriptions.length, 2); assert.equal(f.prepares.length, 0);
    const storage = await f.page.evaluate(() => JSON.stringify(localStorage));
    assert.ok(!storage.includes('private-audio-fixture'));
    assert.deepEqual(f.forbidden, []); assert.deepEqual(f.external, []); assert.deepEqual(f.errors, []);
    await f.page.close();
  }
  {
    const f = await fixture(); f.setMode('query');
    await send(f, '¿Cuánto stock y precio tiene el taladro?');
    assert.equal(await f.dialog.getByLabel('Solicitud', { exact: true }).inputValue(), '¿Cuánto stock y precio tiene el taladro?');
    await f.button('Preparar revisión').click();
    const answer = 'Taladro: 2 disponibles.\nPrecio: $99.\nNo hay reservas.';
    await f.dialog.getByText(answer, { exact: true }).waitFor();
    assert.equal(await f.button('Confirmar operación').count(), 0);
    assert.equal(await f.button('Cancelar operación').count(), 0);
    assert.equal(f.writes(), 0); assert.deepEqual(f.forbidden, []);
    assert.equal(f.prepares.length, 1);
    await f.page.reload(); await f.open();
    await f.dialog.getByText(answer, { exact: true }).waitFor();
    assert.equal(f.prepares.length, 1); assert.equal(f.gets.length, 1);
    assert.deepEqual(f.errors, []); await f.page.close();
  }
  {
    const f = await fixture(); await send(f, 'Ingresaron tres taladros y cargá siete a Ana.');
    f.setMode('prepare503'); await f.button('Preparar revisión').click();
    await f.dialog.getByText('Interpretación no disponible.', { exact: true }).waitFor();
    await f.button('Reintentar revisión').click(); await f.consent().waitFor();
    assert.deepEqual(f.prepares[0], f.prepares[1]);
    assert.equal(f.writes(), 0); assert.equal(await f.button('Confirmar operación').isDisabled(), true);
    await f.dialog.getByText('Disponible: 2 → 5', { exact: true }).waitFor();
    await f.dialog.getByText('Saldo: 0 → 7', { exact: true }).waitFor();
    await f.consent().check(); await f.button('Confirmar operación').click();
    await f.dialog.getByText('Operación aplicada correctamente.', { exact: true }).waitFor();
    assert.equal(await f.dialog.locator('details').getAttribute('open'), null);
    assert.equal(await f.dialog.locator('details p').filter({ hasText: 'Disponible: 2 → 5' }).isVisible(), false);
    await f.dialog.getByText('Ver detalle de los 2 cambios guardados', { exact: true }).click();
    await f.dialog.locator('details p').filter({ hasText: 'Disponible: 2 → 5' }).waitFor();
    assert.equal(f.writes(), 1); assert.equal(f.confirms.length, 1);
    assert.deepEqual(f.confirms[0].input, { version: 1, digest: '1'.repeat(64) });
    assert.deepEqual(f.forbidden, []); assert.deepEqual(f.errors, []); await f.page.close();
  }
  {
    const f = await fixture(); await send(f, 'Ingresaron tres taladros y cargá siete a Ana.');
    await f.button('Preparar revisión').click(); await f.consent().waitFor();
    const original = await f.page.evaluate(() => localStorage.getItem('universal-draft:' + JSON.stringify(['5491100000000', '5491100000000'])));
    await f.button('Cerrar revisión').click(); await send(f, '¿Qué pedidos tengo pendientes?');
    await f.consent().waitFor();
    assert.equal(await f.page.evaluate(() => localStorage.getItem('universal-draft:' + JSON.stringify(['5491100000000', '5491100000000']))), original);
    assert.equal(f.prepares.length, 1);
    await f.page.reload(); await f.page.getByRole('button', { name: 'Abrir simulador WhatsApp', exact: true }).click();
    assert.equal(await f.page.getByPlaceholder('Escribí un mensaje...').inputValue(), '¿Qué pedidos tengo pendientes?');
    await f.page.getByRole('button', { name: 'Revisar operación', exact: true }).click(); await f.consent().waitFor();
    assert.equal(f.prepares.length, 1); assert.equal(f.writes(), 0);
    assert.deepEqual(f.forbidden, []); assert.deepEqual(f.errors, []); await f.page.close();
  }
  {
    const f = await fixture();
    await f.page.evaluate(() => {
      window.restoreInputSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('universal-chat-input:')) throw new DOMException('Quota', 'QuotaExceededError');
        return window.restoreInputSet.call(this, key, value);
      };
    });
    const input = f.page.getByPlaceholder('Escribí un mensaje...');
    await input.fill('Mensaje recuperable en pantalla');
    await f.page.getByRole('alert').getByText(/No pudimos guardar tu mensaje/).waitFor();
    assert.equal(await input.inputValue(), 'Mensaje recuperable en pantalla');
    await f.page.getByRole('button', { name: 'Enviar mensaje', exact: true }).click();
    assert.equal(await f.dialog.count(), 0); assert.equal(f.prepares.length, 0); assert.deepEqual(f.errors, []);
    await f.page.evaluate(() => { Storage.prototype.setItem = window.restoreInputSet; });
    await f.page.getByRole('button', { name: 'Enviar mensaje', exact: true }).click(); await f.dialog.waitFor();
    assert.equal(await f.dialog.getByLabel('Solicitud', { exact: true }).inputValue(), 'Mensaje recuperable en pantalla');
    await f.page.close();
  }
  {
    const f = await fixture(); const input = f.page.getByPlaceholder('Escribí un mensaje...');
    await input.fill('Mensaje privado del actor original');
    f.setIdentity({ phoneNumber: '5491100000001', tenantPhone: '5491100000000' });
    await f.page.reload(); await f.page.getByRole('button', { name: 'Abrir simulador WhatsApp', exact: true }).click();
    assert.equal(await input.inputValue(), ''); await input.fill('Mensaje del segundo actor');
    f.setIdentity({ phoneNumber: '5491100000000', tenantPhone: '5491100000000' });
    await f.page.reload(); await f.page.getByRole('button', { name: 'Abrir simulador WhatsApp', exact: true }).click();
    assert.equal(await input.inputValue(), 'Mensaje privado del actor original');
    await f.page.addInitScript(() => {
      const originalGet = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (key.startsWith('universal-chat-input:')) throw new DOMException('Blocked', 'SecurityError');
        return originalGet.call(this, key);
      };
    });
    await f.page.reload(); await f.page.getByRole('button', { name: 'Abrir simulador WhatsApp', exact: true }).click();
    await f.page.getByRole('alert').getByText(/No pudimos recuperar tu mensaje guardado/).waitFor();
    assert.deepEqual(f.errors, []); assert.equal(f.prepares.length, 0); await f.page.close();
  }
  console.log('Universal ordinary chat UI passed: authenticated audio transcription and retry, durable transcript review, shared draft entry, durable answered recovery, explicit write consent, and stable retry IDs.');
} finally { await browser.close(); }
