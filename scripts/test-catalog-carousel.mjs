import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const fixture = await startCommerceFixture(), sql = new Client({ connectionString: fixture.connection });
const output = path.resolve('.fullmatch-runtime/carousel'), shop = 'fullmatch-demo';
let browser, activePage;
try {
  await sql.connect(); await fs.mkdir(output, { recursive: true });
  const source = fixture.products[0], epoch = Date.now() + 60000;
  const clone = async (index, kind = 'valid') => {
    const id = randomUUID(), sku = `carousel-${randomUUID()}`, slug = `ingreso-${index}`, title = `Ingreso ${index}`;
    await sql.query(`INSERT INTO products SELECT (jsonb_populate_record(NULL::products,to_jsonb(p)||jsonb_build_object('id',$3::text,'name',$4::text,'price',$5::numeric,'inventory_status',$6::text))).*
      FROM products p WHERE owner_phone=$1 AND id=$2`, [fixture.owner, source.skuIds[0], sku, title, kind === 'invalid' ? 0 : 65000, kind === 'inactive' ? 'inactive' : 'active']);
    await sql.query(`INSERT INTO commercial_products SELECT (jsonb_populate_record(NULL::commercial_products,to_jsonb(p)||jsonb_build_object(
      'id',$3::text,'slug',$4::text,'title',$5::text,'title_source','custom','identity_key',md5($3::text)||md5($3::text),'cover_image_id',NULL,'created_at',$6::text))).*
      FROM commercial_products p WHERE owner_phone=$1 AND id=$2`, [fixture.owner, source.id, id, slug, title, new Date(epoch + index * 60000).toISOString()]);
    await sql.query(`INSERT INTO commercial_product_skus(owner_phone,commercial_product_id,sku_id,identity_fingerprint_at_link,linked_by)
      SELECT owner_phone,$3,$4,identity_fingerprint_at_link,linked_by FROM commercial_product_skus WHERE owner_phone=$1 AND commercial_product_id=$2 AND sku_id=$5`, [fixture.owner, source.id, id, sku, source.skuIds[0]]);
    if (kind !== 'no-photo') await sql.query(`INSERT INTO commercial_product_images SELECT (jsonb_populate_record(NULL::commercial_product_images,to_jsonb(image)||jsonb_build_object('id',$3::text,'commercial_product_id',$4::text))).*
      FROM commercial_product_images image WHERE owner_phone=$1 AND commercial_product_id=$2 AND status='ready' LIMIT 1`, [fixture.owner, source.id, randomUUID(), id]);
    await sql.query(`INSERT INTO commercial_publications(owner_phone,commercial_product_id,status,updated_by,reason,published_at) VALUES($1,$2,$3,$1,'Isolated carousel fixture',NOW())`, [fixture.owner, id, kind === 'hidden' ? 'hidden' : 'published']);
  };
  for (let index = 0; index < 12; index++) await clone(index);
  for (let index = 12; index < 20; index++) await clone(index, 'invalid');
  await clone(20, 'inactive'); await clone(21, 'no-photo'); await clone(22, 'hidden');
  await sql.query(`UPDATE commerce_profiles SET appearance=appearance||$2::jsonb WHERE owner_phone=$1`, [fixture.owner, JSON.stringify({ preset: 'editorial', heroContentVisible: false })]);
  const list = await fetch(fixture.apiUrl + `/api/catalog/v1/${shop}/products`).then(response => response.json());
  assert.deepEqual(list.collections.newest.map(product => product.title), Array.from({ length: 8 }, (_, index) => `Ingreso ${11 - index}`));
  assert.ok(list.collections.newest.every(product => product.photos.length > 0));
  assert.equal((await fetch(fixture.apiUrl + `/api/catalog/v1/${shop}/products?q=Ingreso%2021`).then(response => response.json())).items.length, 1);
  console.log('PASS eight newest valid photographed products refill across invalid batches; hidden/inactive excluded and photo-less products stay in catalog');

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  for (const width of [320, 390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, isMobile: width < 781, hasTouch: width < 781 });
    activePage = page;
    page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.apiUrl + `/c/${shop}`);
    const shelf = page.getByRole('region', { name: 'Novedades', exact: true }), track = shelf.locator('[data-carousel-track]');
    const previous = shelf.getByRole('button', { name: 'Productos anteriores de Novedades', exact: true });
    const next = shelf.getByRole('button', { name: 'Productos siguientes de Novedades', exact: true });
    assert.equal(await shelf.locator('.discovery-product').count(), 8);
    await next.waitFor(); assert.equal(await previous.isDisabled(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const dimensions = await page.evaluate(() => {
      const card = document.querySelector('[data-carousel-track] .discovery-product').getBoundingClientRect();
      const catalog = document.querySelector('.catalog-browser').getBoundingClientRect();
      const photo = document.querySelector('[data-carousel-track] .catalog-card-photo').getBoundingClientRect();
      return { left: card.left, catalogLeft: catalog.left, ratio: photo.width / photo.height };
    });
    assert.ok(Math.abs(dimensions.left - dimensions.catalogLeft) <= 5, JSON.stringify(dimensions));
    assert.ok(Math.abs(dimensions.ratio - .75) < .02);
    await page.waitForTimeout(650); assert.equal(await track.evaluate(node => node.scrollLeft), 0);
    await next.click(); await page.waitForFunction(() => document.querySelector('[data-carousel-track]').scrollLeft > 20);
    await track.focus(); await track.press('End');
    await page.waitForFunction(() => document.querySelector('[data-carousel-step="1"]').disabled);
    assert.match(await shelf.locator('[data-carousel-status]').innerText(), /8 de 8$/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await track.press('Home'); await page.waitForFunction(() => document.querySelector('[data-carousel-track]').scrollLeft <= 2);
    await track.press('ArrowRight'); await page.waitForFunction(() => document.querySelector('[data-carousel-track]').scrollLeft > 20);
    await track.press('Home'); await page.waitForFunction(() => document.querySelector('[data-carousel-track]').scrollLeft <= 2);
    if (width < 521) {
      const peek = await track.evaluate(node => { const view = node.getBoundingClientRect(), second = node.children[1].getBoundingClientRect(); return second.left < view.right && second.right > view.right; });
      assert.equal(peek, true);
      await track.scrollIntoViewIfNeeded(); const rect = await track.boundingBox();
      const session = await page.context().newCDPSession(page), y = rect.y + Math.min(rect.height / 2, 140);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x + rect.width - 30, y }] });
      for (let step = 1; step <= 8; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: rect.x + rect.width - 30 - (rect.width - 60) * step / 8, y }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction(() => document.querySelector('[data-carousel-track]').scrollLeft > 20);
      await session.detach();
      // Let native touch inertia and scroll snapping settle before keyboard input.
      await page.waitForFunction(() => {
        const position = document.querySelector('[data-carousel-track]').scrollLeft;
        const state = window.carouselSwipeState ??= { position, at: performance.now() };
        if (position !== state.position) { state.position = position; state.at = performance.now(); }
        return performance.now() - state.at > 200;
      });
    }
    await track.focus(); await track.press('Home'); await page.waitForFunction(() => document.querySelector('[data-carousel-track]').scrollLeft <= 2);
    await page.waitForFunction(() => /^1(?:–| de)/.test(document.querySelector('[data-carousel-status]').textContent));
    await track.evaluate(node => node.blur());
    await shelf.screenshot({ path: path.join(output, `editorial-${width}.png`) });
    if (width === 1440) {
      await shelf.locator('.discovery-product > a').first().click();
      await page.locator('.public-product-heading').waitFor();
      await page.locator('a.back').click(); await shelf.waitFor();
      await page.waitForFunction(() => !document.documentElement.hasAttribute('aria-busy'));
      await next.click(); await page.waitForFunction(() => document.querySelector('[data-carousel-track]').scrollLeft > 20);
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS editorial width alignment, portrait photos, responsive peeking cards, arrows/Home/End/keyboard, touch swipes, soft navigation and no autoplay');
  const noJs = await browser.newContext({ javaScriptEnabled: false }), plain = await noJs.newPage();
  await plain.goto(fixture.apiUrl + `/c/${shop}`);
  assert.equal(await plain.locator('[data-carousel-track] .discovery-product a').count(), 8);
  assert.equal(await plain.locator('[data-carousel-controls]').isVisible(), false);
  assert.ok(await plain.locator('[data-carousel-track]').evaluate(node => node.scrollWidth > node.clientWidth));
  await noJs.close();
  await sql.query("UPDATE commercial_publications SET status='hidden' WHERE owner_phone=$1 AND commercial_product_id<>$2", [fixture.owner, source.id]);
  const single = await browser.newPage(); await single.goto(fixture.apiUrl + `/c/${shop}`);
  assert.equal(await single.locator('[data-carousel-track] .discovery-product').count(), 1);
  assert.equal(await single.locator('[data-carousel-controls]').isVisible(), false);
  await single.close();
  console.log('PASS native horizontal scrolling without JavaScript and controls hidden when one product fits');
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    console.error('Carousel failure', await activePage.evaluate(() => ({ width: innerWidth, position: document.querySelector('[data-carousel-track]')?.scrollLeft, focus: document.activeElement?.outerHTML.slice(0, 200) })));
    await activePage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  }
  throw error;
} finally { await browser?.close(); await sql.end().catch(() => {}); await fixture.stop(); }
