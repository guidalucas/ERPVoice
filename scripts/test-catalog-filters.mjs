import assert from 'node:assert/strict';
import { Client } from 'pg';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
let browser;
const base = '/api/catalog/v1/fullmatch-demo/products';
const read = async query => {
  const response = await fetch(fixture.apiUrl + base + (query ? '?' + new URLSearchParams(query) : ''));
  assert.equal(response.status, 200); return response.json();
};
try {
  await sql.connect();
  const names = ['Camiseta Barcelona titular 2025 versión jugador', 'Camiseta Selección Argentina titular 2026 versión hincha', 'Camiseta Real Madrid titular 2025 versión jugador'];
  for (const [index, product] of fixture.products.entries()) {
    await sql.query('UPDATE commercial_products SET team_key=NULL,team_name=NULL,team_kind=NULL,version_key=NULL WHERE owner_phone=$1 AND id=$2', [fixture.owner, product.id]);
    await sql.query('UPDATE products SET name=$3 WHERE owner_phone=$1 AND id=ANY($2::text[])', [fixture.owner, product.skuIds, names[index]]);
  }
  const snapshot = async () => (await sql.query('SELECT * FROM products ORDER BY id')).rows;
  const beforeReads = await snapshot();
  const pageOne = await read({ limit: '1' });
  assert.equal(pageOne.items.length, 1); assert.ok(pageOne.nextCursor);
  assert.deepEqual(pageOne.facets.teams.map(team => team.key), ['argentina', 'barcelona', 'real-madrid']);
  assert.deepEqual(pageOne.facets.versions, ['fan', 'player']);
  const searched = await read({ q: 'no matches', limit: '1' });
  assert.equal(searched.items.length, 0); assert.deepEqual(searched.facets, pageOne.facets);
  for (const team of pageOne.facets.teams) {
    const result = await read({ team: team.key, category: 'Camiseta', variant: 'M' });
    assert.equal(result.items.length, 1, team.name);
    assert.equal(result.items[0].teamKey, team.key);
    const detail = await fetch(fixture.apiUrl + base + '/' + result.items[0].slug).then(response => response.json());
    assert.equal(detail.product.teamKey, team.key); assert.equal(detail.product.versionKey, result.items[0].versionKey);
  }
  const fan = await read({ version: 'fan' }); assert.equal(fan.items.length, 1); assert.equal(fan.items[0].teamKey, 'argentina');
  assert.equal((await read({ team: 'argentina', version: 'player' })).items.length, 0);
  assert.equal((await read({ team: 'does-not-exist' })).items.length, 0);
  assert.deepEqual(await snapshot(), beforeReads);
  console.log('PASS all catalog teams/versions survive search and pagination; combined filters and detail agree without writing inventory');

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(fixture.apiUrl + '/c/fullmatch-demo');
    await page.locator('.catalog-filter-options summary').click();
    assert.equal(await page.locator('select[name=team] option').count(), 4);
    await page.locator('select[name=team]').selectOption('argentina');
    await page.locator('select[name=version]').selectOption('fan');
    await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
    await page.waitForURL(/team=argentina.*version=fan/);
    await page.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));
    assert.equal(await page.locator('.catalog-card').count(), 1);
    assert.equal(await page.locator('select[name=team]').inputValue(), 'argentina');
    await page.getByRole('link', { name: 'Limpiar filtros', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 3);
    assert.equal(await page.locator('select[name=team] option').count(), 4);
    await page.close();
  }
  // A name edit changes both available options and filtering immediately.
  const target = fixture.products[1];
  await sql.query('UPDATE products SET name=$3,product_type=NULL WHERE owner_phone=$1 AND id=ANY($2::text[])', [fixture.owner, target.skuIds, 'Camiseta de River titular versión jugador']);
  const updated = await read({ team: 'river', category: 'Camiseta' });
  assert.equal(updated.items.length, 1); assert.equal(updated.items[0].teamName, 'River Plate');
  assert.ok(!updated.facets.teams.some(team => team.key === 'argentina'));
  assert.equal((await read({ team: 'argentina' })).items.length, 0);
  await sql.query("UPDATE commercial_products SET team_key='reviewed',team_name='Equipo revisado',version_key='fan' WHERE owner_phone=$1 AND id=$2", [fixture.owner, target.id]);
  const explicit = await read({ team: 'reviewed', version: 'fan' });
  assert.equal(explicit.items.length, 1); assert.equal(explicit.items[0].teamName, 'Equipo revisado');
  assert.equal((await read({ team: 'river' })).items.length, 0);
  await sql.query("UPDATE commercial_publications SET status='hidden' WHERE owner_phone=$1 AND commercial_product_id=$2", [fixture.owner, target.id]);
  const hidden = await read();
  assert.ok(!hidden.facets.teams.some(team => team.key === 'reviewed'));
  assert.equal((await read({ team: 'reviewed' })).items.length, 0);
  console.log('PASS desktop/mobile filter submission and clearing; live renamed products and missing inventory categories');
  console.log('PASS explicit sports metadata takes precedence and hidden publications never supply filter options');
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
