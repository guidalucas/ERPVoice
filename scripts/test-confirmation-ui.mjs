import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 700 }]) {
    const page = await browser.newPage({ viewport });
    const writes = [], errors = [];
    const owner = '5491100000000', member = '5491100000001';
    const team = { role: 'owner', tenantPhone: owner, businessName: 'Prueba de confirmaciones', members: [{ phoneNumber: owner, role: 'owner' }, { phoneNumber: member, role: 'member' }], invites: [] };
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { errors.push('Unexpected native dialog: ' + dialog.message()); await dialog.dismiss(); });
    await page.addInitScript(owner => {
      localStorage.setItem('erpvoice.auth.token', 'confirmation-ui');
      localStorage.setItem('erpvoice.auth.phoneNumber', owner);
    }, owner);
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() });
      if (path === '/api/auth/me') return json({ phoneNumber: owner, tenantPhone: owner, role: 'owner', businessName: team.businessName, businessCategory: 'general', needsOnboarding: false, hasOwnBusiness: true });
      if (path === '/api/state') return json({ products: [], clients: [], proveedores: [], pedidos: [], transactions: [] });
      if (path === '/api/team') return json(team);
      if (path.endsWith('/role')) { team.members[1].role = request.postDataJSON().role; return json(team.members[1]); }
      if (path === '/api/commerce/v1/setup') return json({ enabled: true, needsSetup: false, profile: { brandName: 'Prueba', salesWhatsapp: null, brandPreset: 'general', revision: 1, moneyPolicy: { currency: 'ARS', storageUnit: 'major_integer', fractionDigits: 0, revision: 1 } } });
      if (path === '/api/commerce/v1/products') return json({ items: [], nextCursor: null });
      if (path === '/api/commerce/v1/summary') return json({ products: [], unlinkedSkus: 0, withoutPhotos: 0 });
      if (path === '/api/commerce/v1/catalog') return json(null);
      return json({});
    });
    await page.route('http://127.0.0.1:5173/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/')) return route.fallback();
      const root = resolve('dist'), file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
      if (!file.startsWith(root + sep)) return route.abort();
      try { return route.fulfill({ body: await readFile(file), contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' }); }
      catch { return route.fulfill({ status: 404, body: '' }); }
    });
    const checkPosition = async dialog => {
      await dialog.waitFor();
      const box = await dialog.boundingBox();
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
      assert.ok(Math.abs(box.y + box.height / 2 - viewport.height / 2) < 2);
      assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
    };
    await page.goto('http://127.0.0.1:5173');
    await page.getByRole('navigation', { name: 'Navegación del panel' }).waitFor();
    await page.locator('.dashboard-main').evaluate(element => { element.style.paddingTop = '1500px'; });
    const opener = page.getByRole('button', { name: 'Equipo', exact: true }).first();
    await opener.click();
    const parent = page.getByRole('dialog', { name: team.businessName });
    await checkPosition(parent);
    const role = parent.getByRole('combobox', { name: /Rol de/ });
    await role.selectOption('admin');
    const confirmation = page.getByRole('dialog', { name: /¿Cambiar el rol/ });
    await checkPosition(confirmation);
    if (process.env.CONFIRMATION_SCREENSHOT_DIR) await page.screenshot({ path: resolve(process.env.CONFIRMATION_SCREENSHOT_DIR, 'confirmation-team-' + viewport.width + '.png') });
    assert.equal(await confirmation.getByRole('textbox').count(), 0);
    assert.equal(writes.length, 0);
    await page.keyboard.press('Enter'); // The default action is No.
    await confirmation.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 0);
    assert.equal(await role.inputValue(), 'member');
    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden', 'Closing a nested popup must keep its parent locked');
    await role.selectOption('admin');
    await confirmation.getByRole('button', { name: 'Sí, cambiar rol', exact: true }).dblclick();
    await parent.getByText(/ahora es administrador/).waitFor();
    assert.equal(writes.length, 1, 'Double click must apply only once');
    await parent.getByRole('button', { name: 'Sacar', exact: true }).click();
    const remove = page.getByRole('dialog', { name: /¿Quitar a/ });
    await checkPosition(remove);
    await page.keyboard.press('Escape');
    await remove.waitFor({ state: 'hidden' });
    assert.equal(writes.length, 1);
    await parent.getByRole('button', { name: 'Cerrar', exact: true }).click();
    assert.equal(await page.evaluate(() => document.body.style.overflow), '');

    // Studio uses the same dialog without depending on Tailwind styles.
    await page.goto('http://127.0.0.1:5173/studio.html');
    await page.getByRole('button', { name: '＋ Nueva ficha comercial', exact: true }).click();
    await page.getByLabel('Título comercial', { exact: true }).fill('Borrador conservado');
    await page.getByRole('button', { name: '← Volver a productos', exact: true }).click();
    const discard = page.getByRole('dialog', { name: '¿Volver a productos sin guardar?' });
    await checkPosition(discard);
    if (process.env.CONFIRMATION_SCREENSHOT_DIR) await page.screenshot({ path: resolve(process.env.CONFIRMATION_SCREENSHOT_DIR, 'confirmation-studio-' + viewport.width + '.png') });
    await discard.getByRole('button', { name: 'No, cancelar', exact: true }).click();
    assert.equal(await page.getByLabel('Título comercial', { exact: true }).inputValue(), 'Borrador conservado');
    await page.getByRole('button', { name: '← Volver a productos', exact: true }).click();
    await discard.getByRole('button', { name: 'Sí, volver', exact: true }).click();
    await page.getByRole('heading', { name: /Productos comerciales/ }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(await page.evaluate(() => document.body.style.overflow), '');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Shared confirmations passed: desktop/mobile bounds, nested popups, No/Enter/Escape, no writes on cancel, one write on Yes, scroll restoration and Studio draft preservation.');
} finally { await browser.close(); }
