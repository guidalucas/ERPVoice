import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { chromium, expect } from 'playwright/test';
import { readProductDetail } from '../server/commerce/productRepository.js';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const fixture = await startCommerceFixture({ studioBuild: true });
let browser;
const sql = new Client({ connectionString: fixture.connection });
const get = (route, token = fixture.token) => fetch(fixture.apiUrl + '/api/commerce/v1' + route, {
  headers: { Authorization: `Bearer ${token}` },
});
const read = async route => {
  const response = await get(route);
  assert.equal(response.status, 200, route);
  return response.json();
};

try {
  await sql.connect();
  const session = await fetch(fixture.apiUrl + '/api/auth/me', { headers: { Authorization: `Bearer ${fixture.token}` } });
  assert.equal(session.status, 200);
  assert.match(session.headers.get('server-timing'), /auth;dur=[\d.]+.*auth_profile;dur=[\d.]+/);
  await session.arrayBuffer();
  for (const route of ['/setup', '/products', '/summary']) {
    const response = await get(route);
    assert.equal(response.status, 200);
    const timing = response.headers.get('server-timing');
    for (const phase of ['total', 'auth', 'pool', 'db', 'db_setup', 'db_finalize']) {
      assert.match(timing, new RegExp(`(?:^|, )${phase};dur=[\\d.]+`));
    }
    assert.ok(!timing.includes(fixture.owner));
    await response.arrayBuffer();
  }
  console.log('PASS Studio: startup timings expose aggregate auth, pool and query durations');
  const { items } = await read('/products');
  assert.equal(items.length, fixture.products.length);
  for (const { publication, readAt, ...product } of items) {
    const { readAt: _, ...reference } = await readProductDetail(sql, fixture.owner, product.id);
    assert.deepEqual(product, reference);
    const { readAt: detailReadAt, ...detail } = await read(`/products/${product.id}`);
    assert.deepEqual(detail, reference);
    assert.ok(Number.isFinite(Date.parse(detailReadAt)));
    assert.equal(publication.status, 'published');
    assert.ok(Number.isFinite(Date.parse(readAt)));
  }
  console.log('PASS Studio: batched private product list preserves detail, readiness and publication');

  const { id: productId, coverImageId: imageId } = items[0];
  const dates = ['2026-01-01T12:00:00.123456Z', '2026-01-01T12:00:00.123455Z', '2026-01-01T12:00:00.123455Z'];
  const snapshots = [];
  for (const at of dates) {
    const id = randomUUID();
    const result = { snapshotId: id, content: { productId, imageId, title: 'Prueba', imageAlt: 'Prueba', settings: { templateId: 'arrival' } },
      createdAt: at, expiresAt: '2026-01-02T00:00:00.000Z' };
    await sql.query(`INSERT INTO commercial_operations(owner_phone,operation_id,actor_id,operation_type,entity_id,request_hash,request_json,result_json,created_at)
      VALUES($1,$2,$1,'story.prepare',$3,repeat('0',64),'{}',$4,$5)`, [fixture.owner, id, productId, JSON.stringify({ result }), at]);
    snapshots.push(id);
  }
  const seen = [];
  let cursor = null;
  for (let i = 0; i < snapshots.length; i++) {
    const result = await read(`/content-library?limit=1${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    assert.equal(result.items.length, 1);
    seen.push(result.items[0].snapshotId);
    cursor = result.nextCursor;
    assert.equal(Boolean(cursor), i < snapshots.length - 1);
  }
  assert.equal(seen[0], snapshots[0]);
  assert.deepEqual(new Set(seen), new Set(snapshots));
  console.log('PASS Studio: Library pagination preserves tied and sub-millisecond timestamps');

  const thumbnail = `/products/${productId}/images/${imageId}/content?variant=thumbnail`;
  const first = await get(thumbnail);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
  const bytes = Buffer.from(await first.arrayBuffer());
  const warm = await get(thumbnail);
  assert.equal(warm.status, 200);
  assert.deepEqual(Buffer.from(await warm.arrayBuffer()), bytes);
  const forbidden = await get(thumbnail, fixture.member.token);
  assert.equal(forbidden.status, 403);
  await forbidden.arrayBuffer();
  await sql.query('UPDATE commerce_profiles SET enabled=false WHERE owner_phone=$1', [fixture.owner]);
  const disabled = await get(thumbnail);
  assert.equal(disabled.status, 403);
  await disabled.arrayBuffer();
  await sql.query('UPDATE commerce_profiles SET enabled=true WHERE owner_phone=$1', [fixture.owner]);
  await sql.query("UPDATE commercial_product_images SET status='deleted',deleted_at=NOW() WHERE owner_phone=$1 AND id=$2", [fixture.owner, imageId]);
  const retired = await get(thumbnail);
  assert.equal(retired.status, 404);
  await retired.arrayBuffer();
  console.log('PASS Studio: cached thumbnail respects membership, disabled profiles, retirement and private cache headers');

  await sql.query(`INSERT INTO commercial_products(owner_phone,id,title,slug,created_by,updated_by)
    SELECT $1,gen_random_uuid(),'Navegación prueba '||n,'navigation-test-'||n,$1,$1 FROM generate_series(1,30) n`, [fixture.owner]);
  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge', headless: true } : { headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(({ token, owner }) => {
    localStorage.setItem('erpvoice.auth.token', token);
    localStorage.setItem('erpvoice.auth.phoneNumber', owner);
  }, { token: fixture.token, owner: fixture.owner });
  const page = await context.newPage();
  await page.goto(fixture.url);
  await expect(page.locator('.product-card')).toHaveCount(24);
  const search = page.getByRole('textbox', { name: 'Buscar productos' });
  await search.fill('Navegación prueba');
  await page.getByRole('combobox', { name: 'Filtrar estado' }).selectOption('draft');
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(page.locator('.product-card').first()).toContainText('Navegación prueba');
  await page.getByRole('button', { name: 'Ver más productos ↓' }).click();
  await expect(page.locator('.product-card')).toHaveCount(30);
  const card = page.locator('.product-card').nth(24);
  await card.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  assert.ok(scroll > 100);
  await card.click();
  await expect(page.getByLabel('Título comercial')).toBeVisible();

  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let started = false;
  let catalogRequests = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/commerce/v1/catalog') catalogRequests++;
  });
  await page.route('**/api/commerce/v1/products?*', async route => {
    started = true;
    await waiting;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '← Volver a productos' }).click();
    await expect(search).toHaveValue('Navegación prueba');
    await expect(page.getByRole('combobox', { name: 'Filtrar estado' })).toHaveValue('draft');
    await expect(page.locator('.product-card:visible')).toHaveCount(30);
    await expect.poll(() => page.evaluate(top => Math.abs(window.scrollY - top), scroll)).toBeLessThan(10);
    await expect.poll(() => started).toBe(true);
    const refreshedPage = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/commerce/v1/products' && url.searchParams.has('cursor') && response.ok();
    });
    release();
    await refreshedPage;
    await expect(page.locator('.product-card:visible')).toHaveCount(30);
    assert.equal(catalogRequests, 0);
  } finally { release(); }
  console.log('PASS Studio: returning from a product retains search, filters, scroll and loaded pages while revalidating');

  await sql.query("UPDATE commercial_publications SET status='hidden' WHERE owner_phone=$1 AND commercial_product_id<>$2", [fixture.owner, productId]);
  await page.reload();
  const publishAll = page.getByRole('button', { name: 'Publicar todas las fichas aptas' });
  await expect(publishAll).toBeEnabled();
  let releasePublication;
  const publishing = new Promise(resolve => { releasePublication = resolve; });
  let writes = 0;
  await page.route('**/api/commerce/v1/products/*/publication', async route => {
    if (route.request().method() === 'PUT') {
      writes++;
      await publishing;
    }
    await route.continue();
  });
  try {
    await publishAll.click();
    await expect(page.getByRole('dialog')).toContainText('¿Publicar 2 fichas en el catálogo?');
    await page.getByRole('button', { name: 'Sí, publicar', exact: true }).click();
    await expect.poll(() => writes).toBe(1);
    await page.getByRole('button', { name: /02.*Pendientes/ }).click();
    await expect(page.getByRole('heading', { name: 'Pendientes de catalogar' })).toBeVisible();
    const firstWrite = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/publication'));
    await page.getByRole('button', { name: /01.*Productos/ }).click();
    releasePublication();
    assert.ok((await firstWrite).ok());
    await expect(publishAll).toBeEnabled();
    assert.equal(writes, 1);
  } finally { releasePublication(); }
  console.log('PASS Studio: leaving Products stops the remaining bulk publication writes');
} finally {
  await browser?.close();
  await sql.end();
  await fixture.stop();
}
