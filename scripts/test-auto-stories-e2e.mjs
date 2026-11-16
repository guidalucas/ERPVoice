import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import express from 'express';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';
import { createDatabaseRuntime } from '../server/dbRuntime.js';
import { createAutoStoryRoutes } from '../server/commerce/autoStoryRoutes.js';
import { createInstagramStoryPublisher } from '../server/commerce/instagramStoryPublisher.js';
import { digest, requestMessage, signature } from '../server/commerce/autoStorySecurity.js';
import { createRunnerClient, renderWithPlaywright } from './instagram-auto-story.mjs';

const owner = '59899000088', workerKey = randomBytes(32), mediaKey = randomBytes(32), encryptionKey = randomBytes(32);
const browserOptions = process.platform === 'win32' ? { channel: 'msedge' } : {};
const config = { owner, workerKey, mediaKey, encryptionKey, origin: 'https://stocky.invalid',
  token: 'mock-instagram-token', expiresAt: Date.now() + 25 * 86_400_000, liveReady: true };
const configureApi = async ({ connection }) => {
  const migration = fileURLToPath(new URL('./migrate-commerce-auto-stories.js', import.meta.url));
  const run = async (...args) => {
    const { stdout } = await promisify(execFile)(process.execPath, [migration, ...args], {
      env: { ...process.env, COMMERCE_DATABASE_URL: connection }, windowsHide: true,
    });
    return JSON.parse(stdout);
  };
  assert.equal((await run()).ready, false);
  assert.equal((await run('--apply')).changed, true);
  assert.equal((await run('--apply')).changed, false);
  assert.equal((await run()).ready, true);
  return { AUTO_STORY_OWNER: owner, AUTO_STORY_RUNNER_KEY: workerKey.toString('hex'), AUTO_STORY_MEDIA_KEY: '',
    AUTO_STORY_META_TOKEN: '', AUTO_STORY_TOKEN_KEY: '' };
};

test('Studio, the signed runner, PostgreSQL and the Instagram publisher work together', { timeout: 180_000 }, async () => {
  const fixture = await startCommerceFixture({ configureApi });
  const runtime = createDatabaseRuntime({ connectionString: fixture.connection });
  const sql = (query, params) => runtime.withClient(client => client.query(query, params));
  const context = { actorId: owner, businessId: owner, role: 'owner' };
  const auth = { Authorization: `Bearer ${fixture.token}` };
  let listener, browser, origin, signedImage, container = 5000, publishCalls = 0, processing = false;
  let publishFailure = false, metaStatus = 'FINISHED', failAuthorization = false;
  const createPath = '/v26.0/123/media';
  const meta = createInstagramStoryPublisher({ fetchImpl: async (url, init) => {
    assert.equal(url.origin, 'https://graph.instagram.com');
    if (failAuthorization) return Response.json({ error: { code: 190, error_subcode: 467 } }, { status: 400 });
    if (url.pathname.endsWith('/me')) return Response.json({ user_id: '123', username: 'fixture', account_type: 'Business' });
    if (url.pathname.endsWith('content_publishing_limit')) return Response.json({ data: [{ quota_usage: 0 }] });
    if (url.pathname === createPath) {
      signedImage = new URL(init.body.get('image_url'));
      assert.equal(signedImage.origin, config.origin);
      assert.equal(init.body.get('media_type'), 'STORIES');
      const download = await fetch(origin + signedImage.pathname);
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), 'image/jpeg');
      const info = await sharp(Buffer.from(await download.arrayBuffer())).metadata();
      assert.deepEqual([info.width, info.height], [1080, 1920]);
      return Response.json({ id: String(++container) });
    }
    if (url.pathname.endsWith('/media_publish')) {
      publishCalls++;
      if (publishFailure) throw new Error('network timeout after send');
      return Response.json({ id: String(9000 + publishCalls) });
    }
    assert.equal(url.pathname, `/v26.0/${container}`);
    return Response.json({ status_code: processing ? 'IN_PROGRESS' : metaStatus });
  } });
  const media = { content: async (tenant, product, photo) => {
    assert.equal(tenant.businessId, owner);
    const response = await fetch(`${fixture.apiUrl}/api/commerce/v1/products/${product}/images/${photo}/content`, { headers: auth });
    assert.equal(response.status, 200);
    return Buffer.from(await response.arrayBuffer());
  } };
  const app = express();
  const routes = createAutoStoryRoutes(runtime, media, config, { meta });
  app.use(routes.runnerPath, routes.runner);
  app.use(routes.mediaPath, routes.signedMedia);
  try {
    listener = app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    origin = `http://127.0.0.1:${listener.address().port}`;
    const worker = createRunnerClient(origin, workerKey);
    const privatePath = '/api/commerce/v1/automatic-stories';
    const privateRequest = (route = '', headers = auth, method = 'GET', body) => fetch(fixture.apiUrl + privatePath + route,
      { headers: { ...headers, 'Content-Type': 'application/json' }, method, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await privateRequest('', { Authorization: `Bearer ${fixture.member.token}` })).status, 403);
    const foreign = fixture.freshOwners[0];
    await sql("INSERT INTO commerce_profiles(owner_phone,id,brand_name,enabled,created_by) VALUES ($1,$2,'Other business',true,$1)", [foreign.owner, randomUUID()]);
    const otherAuth = { Authorization: `Bearer ${foreign.token}` };
    assert.equal((await (await privateRequest('/simulate', otherAuth, 'POST')).json()).code, 'NO_ELIGIBLE_PRODUCT');
    assert.equal((await privateRequest(`/products/${fixture.products[0].id}`, otherAuth)).status, 404);
    assert.equal((await privateRequest('', otherAuth, 'PUT', { enabled: true, verifyBusiness: true })).status, 409);
    await assert.rejects(createRunnerClient(origin, randomBytes(32))('/simulate'), { message: 'AUTO_STORY_UNAUTHENTICATED' });
    const path = routes.runnerPath + '/simulate', time = String(Date.now()), nonce = randomUUID();
    const replay = () => fetch(origin + path, { method: 'POST', headers: { 'x-stocky-time': time, 'x-stocky-nonce': nonce,
      'x-stocky-signature': signature(workerKey, requestMessage('POST', path, time, nonce, digest(Buffer.alloc(0)))) } });
    assert.equal((await replay()).status, 200);
    assert.equal((await replay()).status, 409);
    await assert.rejects(routes.service.configure(context, { enabled: true }), { code: 'META_CONNECTION_REQUIRED' });
    assert.equal((await worker('/claim')).code, 'AUTOMATION_DISABLED');

    const logoBytes = await sharp({ create: { width: 120, height: 120, channels: 3, background: '#2bcc10' } }).png().toBuffer();
    const logoResponse = await fetch(fixture.apiUrl + '/api/commerce/v1/brand-assets/logo', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'image/png' }, body: logoBytes,
    });
    assert.equal(logoResponse.status, 201);
    const { id: logoId } = await logoResponse.json();
    await sql(`UPDATE commerce_profiles SET appearance=appearance || $2::jsonb WHERE owner_phone=$1`,
      [owner, JSON.stringify({ logoId, primaryColor: '#112233', accentColor: '#aa2266' })]);
    const preview = await worker('/simulate');
    assert.equal(preview.snapshot.content.appearance.logoId, logoId);
    assert.equal(preview.snapshot.content.appearance.primaryColor, '#112233');
    const jpeg = await renderWithPlaywright(preview, browserOptions);
    await sharp(jpeg).stats();
    browser = await chromium.launch(browserOptions);
    const page = await browser.newPage();
    await page.addInitScript(({ token, owner }) => {
      localStorage.setItem('erpvoice.auth.token', token);
      localStorage.setItem('erpvoice.auth.phoneNumber', owner);
    }, { token: fixture.token, owner });
    await page.goto(fixture.url);
    await page.getByRole('button', { name: 'Historias automáticas' }).click();
    await page.getByRole('button', { name: 'Simular historia' }).click();
    const previewImage = page.getByRole('img', { name: 'Vista previa de la historia simulada' });
    await previewImage.waitFor();
    assert.equal(await previewImage.evaluate(image => image.naturalWidth || new Promise(resolve => image.onload = () => resolve(image.naturalWidth))), 1080);
    const manual = await page.evaluate(async payload => {
      const { renderStory } = await import('/src/studio/storyRenderer.ts');
      const decoded = new Blob([Uint8Array.from(atob(payload.photo), char => char.charCodeAt(0))], { type: 'image/jpeg' });
      const image = await renderStory(document.createElement('canvas'), payload.snapshot, decoded, 'jpeg');
      return Array.from(new Uint8Array(await image.arrayBuffer()));
    }, preview);
    assert.ok(jpeg.equals(Buffer.from(manual)), 'El render automático y el manual deben producir el mismo JPEG.');
    assert.equal((await sql('SELECT count(*)::int FROM commerce_auto_story_jobs')).rows[0].count, 0);

    await routes.service.configure(context, { enabled: false, verifyBusiness: true });
    await routes.service.configure(context, { enabled: true });
    const pastDay = () => sql(`UPDATE commerce_auto_story_jobs SET business_date=(SELECT min(business_date)-1 FROM commerce_auto_story_jobs),
      published_at=published_at-interval '1 day'
      WHERE status='published' AND (published_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date=(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`);
    const claim = async () => {
      const job = await worker('/claim');
      assert.equal(job.status, 'rendering', JSON.stringify(job));
      return job;
    };
    const upload = async job => {
      const bytes = await renderWithPlaywright(job, browserOptions);
      return worker(`/jobs/${job.id}/jpeg`, 'PUT', bytes);
    };
    const advance = job => worker(`/jobs/${job.id}/advance`);
    const choices = await Promise.all(Array.from({ length: 4 }, () => worker('/claim')));
    const first = choices.find(job => job.status === 'rendering');
    assert.ok(first);
    assert.equal(choices.filter(job => job.status === 'rendering').length, 1);
    assert.equal(choices.filter(job => job.status === 'busy').length, 3);
    assert.equal((await upload(first)).status, 'ready');
    processing = true;
    assert.equal((await advance(first)).status, 'processing');
    assert.equal(publishCalls, 0);
    processing = false;
    const publishes = await Promise.all([advance(first), advance(first)]);
    assert.ok(publishes.some(attempt => attempt.status === 'published'));
    assert.equal(publishCalls, 1);
    assert.equal((await fetch(origin + signedImage.pathname.replace(/\/[a-f0-9]{64}\.jpg$/, '/' + '0'.repeat(64) + '.jpg'))).status, 404);
    for (let i = 0; i < 4; i++) assert.equal((await worker('/claim')).code, 'ALREADY_PUBLISHED');

    const used = new Set([first.snapshot.content.productId]);
    for (let i = 0; i < 2; i++) {
      await pastDay();
      const job = await claim();
      assert.ok(!used.has(job.snapshot.content.productId));
      used.add(job.snapshot.content.productId);
      await upload(job);
      assert.equal((await advance(job)).status, 'published');
    }
    assert.equal(used.size, 3);
    await pastDay();
    const changed = await claim();
    assert.ok(used.has(changed.snapshot.content.productId));
    await upload(changed);
    const sku = changed.snapshot.content.variants[0].skuId;
    await sql('UPDATE products SET price=price+100 WHERE owner_phone=$1 AND id=$2', [owner, sku]);
    assert.equal((await advance(changed)).code, 'COMMERCIAL_CONTENT_CHANGED');
    assert.equal(publishCalls, 3);

    const stockChanged = await claim();
    await worker(`/jobs/${stockChanged.id}/jpeg`, 'PUT', jpeg);
    const stockSku = stockChanged.snapshot.content.variants[0].skuId;
    const stockBefore = stockChanged.snapshot.content.variants[0].stockAvailable;
    await sql('UPDATE products SET stock_available=0 WHERE owner_phone=$1 AND id=$2', [owner, stockSku]);
    assert.match((await advance(stockChanged)).code, /^STORY_(STOCK_CHANGED|PRODUCT_NOT_READY)$/);
    await sql('UPDATE products SET stock_available=$3 WHERE owner_phone=$1 AND id=$2', [owner, stockSku, stockBefore]);

    const photoChanged = await claim();
    await worker(`/jobs/${photoChanged.id}/jpeg`, 'PUT', jpeg);
    const photoId = photoChanged.snapshot.content.imageId;
    await sql("UPDATE commercial_product_images SET status='deleted',deleted_at=now() WHERE owner_phone=$1 AND id=$2", [owner, photoId]);
    assert.match((await advance(photoChanged)).code, /^STORY_(IMAGE_UNAVAILABLE|PRODUCT_NOT_READY)$/);
    await sql("UPDATE commercial_product_images SET status='ready',deleted_at=NULL WHERE owner_phone=$1 AND id=$2", [owner, photoId]);

    const invalid = await claim();
    await assert.rejects(worker(`/jobs/${invalid.id}/jpeg`, 'PUT', Buffer.from('invalid')), { message: 'AUTO_STORY_INVALID_JPEG' });
    assert.equal(publishCalls, 3);
    const abandoned = await claim();
    await sql("UPDATE commerce_auto_story_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [abandoned.id]);
    const replacement = await claim();
    assert.notEqual(replacement.id, abandoned.id);
    await upload(replacement);
    publishFailure = true;
    assert.equal((await advance(replacement)).status, 'unknown');
    assert.equal((await worker('/claim')).status, 'unknown');
    assert.equal(publishCalls, 4);
    metaStatus = 'PUBLISHED';
    assert.equal((await worker('/claim')).status, 'published');
    assert.equal((await worker('/claim')).code, 'ALREADY_PUBLISHED');
    assert.equal(publishCalls, 4);
    await sql("UPDATE commerce_auto_story_jobs SET jpeg_expires_at=now()-interval '1 minute' WHERE id=$1", [replacement.id]);
    await worker('/claim');
    assert.equal((await sql('SELECT jpeg FROM commerce_auto_story_jobs WHERE id=$1', [replacement.id])).rows[0].jpeg, null);
    const foreignStatus = await (await privateRequest('', otherAuth)).json();
    assert.deepEqual(foreignStatus.history, []);

    await pastDay();
    await sql("UPDATE products SET stock_available=0 WHERE owner_phone=$1", [owner]);
    assert.equal((await worker('/claim')).code, 'NO_ELIGIBLE_PRODUCT');
    assert.equal(publishCalls, 4);
    await sql("UPDATE products SET stock_available=1 WHERE owner_phone=$1", [owner]);
    await sql("UPDATE commercial_products SET auto_story_enabled=false WHERE owner_phone=$1", [owner]);
    assert.equal((await worker('/simulate')).code, 'NO_ELIGIBLE_PRODUCT');
    await sql("UPDATE commercial_products SET auto_story_enabled=true WHERE owner_phone=$1", [owner]);
    failAuthorization = true;
    const revoked = await claim();
    await upload(revoked);
    assert.equal((await advance(revoked)).code, 'META_TOKEN_REVOKED');
    assert.equal((await routes.service.status(context)).connection, 'revoked');
    assert.equal(publishCalls, 4);
  } finally {
    await browser?.close();
    if (listener) await new Promise(resolve => listener.close(resolve));
    await runtime.close();
    await fixture.stop();
  }
});
