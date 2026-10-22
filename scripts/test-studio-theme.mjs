import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { Client } from 'pg';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
const output = path.resolve('.fullmatch-runtime/studio-theme');
const widths = [[375,812],[390,844],[430,932],[768,1024],[1440,900],[1920,1080]];
let browser;
const checks = [], errors = [];
const themeName = theme => theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
async function theme(page, wanted) {
  if (await page.locator('html').getAttribute('class') !== wanted) await page.getByRole('button', { name: themeName(wanted === 'dark' ? 'light' : 'dark'), exact: true }).click();
  await page.locator(`html.${wanted}`).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('stocky-theme')), wanted);
}
async function snapshot(page, name) {
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true, animations: 'disabled' });
}
function contrast(a, b) {
  const luminance = color => color.match(/[\d.]+/g).slice(0,3).map(Number).map(value => { const x = value / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126,.7152,.0722][index], 0);
  const values = [luminance(a), luminance(b)].sort((a,b) => b-a); return (values[0] + .05) / (values[1] + .05);
}
async function legible(page, selector) {
  const colors = await page.locator(selector).first().evaluate(element => {
    let current = element, background = '';
    while (current) { const value = getComputedStyle(current).backgroundColor; if (!value.endsWith(', 0)') && value !== 'transparent') { background = value; break; } current = current.parentElement; }
    return [getComputedStyle(element).color, background];
  });
  assert.ok(contrast(...colors) >= 4.5, `${selector} ${JSON.stringify(colors)}`);
}
async function contextFor(user = fixture) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, reducedMotion: 'reduce' });
  if (user) await context.addInitScript(({ token, owner, origin }) => { if (location.origin === origin) {
    localStorage.setItem('erpvoice.auth.token', token); localStorage.setItem('erpvoice.auth.phoneNumber', owner);
  } }, { ...user, origin: new URL(fixture.url).origin });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return context;
}
try {
  await sql.connect(); await fs.mkdir(output, { recursive: true });
  const inventory = (await sql.query('SELECT * FROM products ORDER BY id')).rows;
  const before = await (await fetch(fixture.apiUrl + '/api/commerce/v1/profile', { headers: { Authorization: `Bearer ${fixture.token}` } })).json();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await contextFor(), page = await context.newPage();
  await page.goto(fixture.url); await page.locator('.product-card').first().waitFor();
  // Fresh preference follows the same dark default as Stocky.
  await page.locator('html.dark').waitFor();
  for (const mode of ['light','dark']) {
    await theme(page, mode); await page.reload(); await page.locator('.product-card').first().waitFor();
    assert.equal(await page.locator('html').getAttribute('class'), mode);
    const logo = page.locator('.studio-brand-logo'); await logo.evaluate(image => image.decode());
    assert.equal(await logo.getAttribute('src'), mode === 'dark' ? '/stocky-logo.png' : '/stocky-logo-light.png');
    assert.equal(await page.getByRole('link', { name: 'Stocky · ir al inventario', exact: true }).getAttribute('href'), '/');
    await legible(page, '.collection-stats'); await legible(page, '.products-heading .primary'); await legible(page, '.card-body h3');
    for (const [width,height] of widths) {
      await page.setViewportSize({ width,height });
      const actual = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      assert.equal(actual.document, width, JSON.stringify(actual));
      const toggle = page.getByRole('button', { name: themeName(mode), exact: true }), bounds = await toggle.boundingBox();
      assert.ok(bounds.width >= 44 && bounds.height >= 44 && bounds.x + bounds.width <= width);
      await snapshot(page, `products-${mode}-${width}`); checks.push({ surface:'products', mode, ...actual });
    }
  }
  await page.setViewportSize({ width:1440,height:900 });
  // An actual second tab observes the same preference through the storage event.
  const peer = await context.newPage(); await peer.goto(fixture.url); await peer.locator('html.dark').waitFor();
  await theme(page,'light'); await peer.locator('html.light').waitFor();
  await theme(peer,'dark'); await page.locator('html.dark').waitFor(); await peer.close();
  const publicPage = await context.newPage(); await publicPage.goto(fixture.apiUrl + '/c/fullmatch-demo');
  const publicBefore = await publicPage.locator('.catalog-hero').evaluate(element => ({ background:getComputedStyle(element).backgroundColor, color:getComputedStyle(element).color }));
  await page.getByRole('button', { name:/Configuración/ }).click();
  const preview = page.frameLocator('.catalog-preview-shell iframe'); await preview.locator('.catalog-card img').first().waitFor();
  const previewBefore = await preview.locator('.catalog-hero').evaluate(element => getComputedStyle(element).backgroundColor);
  for (const mode of ['dark','light']) {
    await theme(page,mode); await legible(page,'.appearance-controls .field>span');
    assert.equal(await preview.locator('.catalog-hero').evaluate(element => getComputedStyle(element).backgroundColor), previewBefore);
    assert.equal(await preview.locator('html.dark').count(), 0);
    await snapshot(page,`settings-${mode}-desktop`);
  }
  await publicPage.reload(); assert.deepEqual(await publicPage.locator('.catalog-hero').evaluate(element => ({ background:getComputedStyle(element).backgroundColor, color:getComputedStyle(element).color })), publicBefore);
  await publicPage.close();
  await page.getByRole('button', { name:/Productos/ }).first().click(); await page.locator('.product-card').first().click();
  await theme(page,'dark'); await snapshot(page,'editor-dark-desktop');
  await page.getByRole('button',{ name:'03 Fotografías',exact:true }).click(); await snapshot(page,'photos-dark-desktop');
  await legible(page,'.upload-box small');
  await page.getByRole('button',{ name:'Generar historia ↗',exact:true }).click();
  await page.getByRole('button',{ name:'Generar previsualización',exact:true }).click();
  await page.waitForFunction(() => !document.querySelector('.export-actions button')?.disabled);
  const originalPixels = await page.locator('canvas').evaluate(canvas => canvas.toDataURL());
  await snapshot(page,'story-dark-desktop'); await theme(page,'light');
  assert.equal(await page.locator('canvas').evaluate(canvas => canvas.toDataURL()),originalPixels);
  await page.getByRole('button',{ name:'Generar previsualización',exact:true }).click();
  await page.waitForFunction(() => !document.querySelector('.export-actions button')?.disabled);
  assert.equal(await page.locator('canvas').evaluate(canvas => canvas.toDataURL()),originalPixels,'Admin theme must not change exported artwork');
  const pending = page.waitForEvent('download'); await page.getByRole('button',{ name:'Descargar PNG ↓',exact:true }).click();
  const metadata = await sharp(await fs.readFile(await (await pending).path())).metadata(); assert.equal(metadata.width,1080); assert.equal(metadata.height,1920);
  await theme(page,'dark'); await page.setViewportSize({ width:390,height:844 }); await snapshot(page,'story-dark-mobile');
  await page.getByRole('button',{ name:'← Volver a la ficha',exact:true }).click(); await page.getByRole('button',{ name:'← Volver a productos',exact:true }).click();
  for (const label of ['Pendientes','Biblioteca']) { await page.locator('.sidebar nav').getByRole('button',{name:new RegExp(label)}).click(); await snapshot(page,`${label.toLowerCase()}-dark-mobile`); }
  const loginContext = await contextFor(null), login = await loginContext.newPage(); await login.setViewportSize({width:390,height:844}); await login.goto(fixture.url);
  await login.getByRole('heading',{name:'Entrá a Studio'}).waitFor();
  for (const mode of ['dark','light']) { await theme(login,mode); assert.equal(await login.evaluate(()=>document.documentElement.scrollWidth),390); await snapshot(login,`login-${mode}-mobile`); }
  await loginContext.close();
  const setupContext = await contextFor(fixture.freshOwners[0]), setup = await setupContext.newPage(); await setup.setViewportSize({width:390,height:844}); await setup.goto(fixture.url);
  await setup.getByRole('heading',{name:'Configurá tu negocio'}).waitFor();
  for (const mode of ['dark','light']) { await theme(setup,mode); await legible(setup,'.field>span'); assert.equal(await setup.evaluate(()=>document.documentElement.scrollWidth),390); await snapshot(setup,`setup-${mode}-mobile`); }
  await setupContext.close();
  const after = await (await fetch(fixture.apiUrl + '/api/commerce/v1/profile',{headers:{Authorization:`Bearer ${fixture.token}`}})).json();
  assert.deepEqual(after.appearance,before.appearance); assert.deepEqual((await sql.query('SELECT * FROM products ORDER BY id')).rows,inventory); assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'checks.json'),JSON.stringify(checks,null,2));
  console.log('PASS Studio theme: shared dark default and preference, logo variants, six viewports, live tab sync, login/setup/editor/photos/settings/story, contrast, unchanged public branding/artwork, real PNG and unchanged inventory');
} finally { await browser?.close(); await sql.end().catch(()=>{}); await fixture.stop(); }
