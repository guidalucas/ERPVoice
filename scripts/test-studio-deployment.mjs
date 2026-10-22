import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

// Exercise the actual production output with a disposable API and no network access.
const origin = 'http://127.0.0.1:5173', root = resolve('dist');
const owner = '59899000088', token = 'isolated-deployment-test';
const browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
try {
  for (const scenario of [
    { role: 'owner', mobile: false },
    { role: 'owner', mobile: true },
    { role: 'member', mobile: false },
    { role: 'member', mobile: true },
  ]) {
    const context = await browser.newContext({ viewport: scenario.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1050 } });
    const page = await context.newPage(), commerceRequests = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(({ token, owner }) => {
      localStorage.setItem('erpvoice.auth.token', token);
      localStorage.setItem('erpvoice.auth.phoneNumber', owner);
      if (!localStorage.getItem('stocky-theme')) localStorage.setItem('stocky-theme', 'light');
    }, { token, owner });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path.startsWith('/api/')) {
        assert.equal(request.headers().authorization, `Bearer ${token}`);
        assert.equal(request.method(), 'GET', 'Navigation must not mutate business data');
        if (path === '/api/auth/me') return json({ phoneNumber: owner, tenantPhone: owner, role: scenario.role,
          businessName: 'FullMatch prueba', businessCategory: 'indumentaria', needsOnboarding: false, pendingInvite: null, hasOwnBusiness: true });
        if (path === '/api/state') return json({ products: [], clients: [], proveedores: [], pedidos: [], transactions: [] });
        if (path.startsWith('/api/commerce/v1/')) commerceRequests.push(path);
        if (path === '/api/commerce/v1/setup') return json({ enabled: true, needsSetup: false, profile: { brandName: 'FullMatch prueba', revision: 1, moneyPolicy: { currency: 'ARS', storageUnit: 'major_integer', fractionDigits: 2, revision: 1 } } });
        if (path === '/api/commerce/v1/profile') return json({ brandName: 'FullMatch prueba', moneyPolicy: null, revision: 1 });
        if (path === '/api/commerce/v1/products') return json({ items: [], nextCursor: null });
        if (path === '/api/commerce/v1/summary') return json({ products: [], unlinkedSkus: 0 });
        return json({});
      }
      if (url.origin !== origin) return route.abort();
      const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
      if (!file.startsWith(`${root}${sep}`)) return route.abort();
      try {
        await route.fulfill({ status: 200, body: await readFile(file),
          contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.png') ? 'image/png' : 'text/html' });
      } catch { await route.fulfill({ status: 404, body: 'Missing deployment asset' }); }
    });
    const response = await page.goto(origin);
    assert.equal(response.status(), 200);
    await page.getByRole('button', { name: 'Inventario', exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Cambiar a modo oscuro', exact: true }).first().click();
    await page.locator('html.dark').waitFor();
    if (scenario.mobile) await page.getByRole('button', { name: 'Más', exact: true }).click();
    const link = page.getByRole('link', { name: 'Stocky Studio', exact: true });
    if (scenario.role === 'owner') {
      const visibleLink = scenario.mobile ? page.getByRole('menu', { name: 'Más secciones' }).getByRole('link', { name: 'Stocky Studio' }) : link;
      assert.equal(await visibleLink.getAttribute('href'), '/studio.html');
      const navigation = page.waitForNavigation();
      await visibleLink.click();
      assert.equal((await navigation).status(), 200);
      await page.getByRole('heading', { name: 'Productos comerciales' }).waitFor();
      await page.locator('html.dark').waitFor();
      await page.locator('.studio-brand-logo').evaluate(image => image.decode());
      assert.equal(await page.locator('.studio-brand-logo').getAttribute('src'), '/stocky-logo.png');
      assert.equal(page.url(), `${origin}/studio.html`);
      assert.equal(await page.getByRole('button', { name: 'Ingresar con WhatsApp ↗' }).count(), 0);
      assert.ok(commerceRequests.includes('/api/commerce/v1/setup'));
      assert.ok(commerceRequests.includes('/api/commerce/v1/products'));
      await page.reload();
      await page.getByRole('heading', { name: 'Productos comerciales' }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: 'Cambiar a modo claro', exact: true }).click();
      await page.locator('html.light').waitFor();
      await page.getByRole('link', { name: 'Stocky · ir al inventario', exact: true }).click();
      await page.getByRole('button', { name: 'Inventario', exact: true }).first().waitFor();
      await page.locator('html.light').waitFor();
    } else {
      assert.equal(await link.count(), 0);
      assert.equal(commerceRequests.length, 0);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS deployment: ${scenario.role} ${scenario.mobile ? 'mobile' : 'desktop'} navigation/session`);
    await context.close();
  }
} finally { await browser.close(); }
