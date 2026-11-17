import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';
import { validateStoryJpeg, temporaryStoryUrl, validMediaSignature } from '../server/commerce/autoStoryMedia.js';
import { assertSignedRunner, digest, requestMessage, signature, sealToken, unsealToken } from '../server/commerce/autoStorySecurity.js';
import { businessDate, nextStoryAttempt, storyWindow } from '../server/commerce/autoStoryService.js';
import { createInstagramStoryPublisher } from '../server/commerce/instagramStoryPublisher.js';
import { originalClaimTime, waitForApi } from './instagram-auto-story.mjs';

test('commercial day and the four UTC opportunities use Argentina time', () => {
  const at = value => Date.parse(value);
  assert.equal(businessDate(at('2026-11-16T02:55:00Z')), '2026-11-15');
  assert.equal(businessDate(at('2026-11-16T03:00:00Z')), '2026-11-16');
  assert.equal(nextStoryAttempt(at('2026-11-16T16:00:00Z')), '2026-11-16T19:17:00.000Z');
  assert.equal(nextStoryAttempt(at('2026-11-16T23:17:00Z')), '2026-11-17T12:17:00.000Z');
  assert.deepEqual(['12:17', '15:17', '19:17', '23:17'].map(time => storyWindow(at(`2026-11-16T${time}:00Z`))), [1, 2, 3, 4]);
  assert.equal(storyWindow(at('2026-11-17T02:59:59Z')), 4);
  assert.equal(storyWindow(at('2026-11-17T03:00:00Z')), 1);
});

test('a delayed Actions run keeps the original cron window across UTC midnight', () => {
  assert.equal(originalClaimTime('2026-11-17T00:05:00Z', '17 23 * * *'), Date.parse('2026-11-16T23:17:00Z'));
  assert.equal(originalClaimTime('2026-11-16T16:12:00Z', '17 12 * * *'), Date.parse('2026-11-16T12:17:00Z'));
  assert.equal(originalClaimTime('2026-11-16T16:12:00Z'), Date.parse('2026-11-16T16:12:00Z'));
  assert.equal(originalClaimTime('2026-11-17T12:38:00Z', '17,37,57 12 * * *'), Date.parse('2026-11-17T12:17:00Z'));
  assert.equal(originalClaimTime('2026-11-17T00:05:00Z', '17,37,57 23 * * *'), Date.parse('2026-11-16T23:17:00Z'));
});

test('Supabase dispatch preserves the requested window when GitHub accepts a delayed request', () => {
  assert.equal(originalClaimTime('2026-11-17T00:05:00Z', '', '2026-11-16T23:17:00Z'),
    Date.parse('2026-11-16T23:17:00Z'));
  assert.equal(originalClaimTime('2026-11-17T19:40:00Z', '', '2026-11-17T15:17:00Z'),
    Date.parse('2026-11-17T15:17:00Z'));
  for (const value of ['invalid', '2026-02-30T12:17:00Z', '2026-11-17T13:17:00Z',
    '2026-11-17T12:37:00Z', '2026-11-18T12:17:00Z']) {
    assert.throws(() => originalClaimTime('2026-11-17T19:40:00Z', '', value),
      { message: 'RUNNER_CONFIGURATION_INVALID' });
  }
});

test('worker signature binds HTTP verb, path and exact bytes, expires and authenticates the nonce', () => {
  const key = randomBytes(32), now = Date.now(), nonce = randomUUID(), originalUrl = '/jobs/id/jpeg', method = 'PUT';
  const body = Buffer.from('exact bytes'), time = String(now);
  const signed = signature(key, requestMessage(method, originalUrl, time, nonce, digest(body)));
  const headers = { 'x-stocky-time': time, 'x-stocky-nonce': nonce, 'x-stocky-signature': signed };
  const req = { method, originalUrl, body, get: header => headers[header] };
  assert.equal(assertSignedRunner(req, key, now), nonce);
  for (const changed of [{ method: 'POST' }, { originalUrl: '/other' }, { body: Buffer.from('changed') }]) {
    assert.throws(() => assertSignedRunner({ ...req, ...changed }, key, now), { code: 'AUTO_STORY_UNAUTHENTICATED' });
  }
  assert.throws(() => assertSignedRunner(req, key, now + 120_001), { code: 'AUTO_STORY_UNAUTHENTICATED' });
});

test('JPEG validation uses actual decoded bytes, and media signatures expire and identify one file', async () => {
  const input = dimensions => sharp({ create: { ...dimensions, channels: 3, background: 'red' } });
  const jpeg = await input({ width: 1080, height: 1920 }).jpeg().toBuffer();
  await validateStoryJpeg(jpeg);
  for (const bytes of [Buffer.from('not a JPEG'), await input({ width: 1080, height: 1920 }).png().toBuffer(),
    await input({ width: 1080, height: 1500 }).jpeg().toBuffer(), Buffer.concat([jpeg.subarray(0, 600), jpeg.subarray(-2)]),
    Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    await assert.rejects(validateStoryJpeg(bytes), { code: 'AUTO_STORY_INVALID_JPEG' });
  }
  const config = { mediaKey: randomBytes(32), origin: 'https://stocky.invalid' }, id = randomUUID(), expiry = Date.now() + 1000;
  const parts = new URL(temporaryStoryUrl(config, id, expiry)).pathname.split('/');
  const [mediaId, expires, file] = parts.slice(-3);
  assert.ok(validMediaSignature(config.mediaKey, mediaId, expires, file.slice(0, -4), expiry - 1));
  assert.ok(!validMediaSignature(config.mediaKey, randomUUID(), expires, file.slice(0, -4), expiry - 1));
  assert.ok(!validMediaSignature(config.mediaKey, id, expires, file.slice(0, -4), expiry));
});

test('refreshed Meta tokens are encrypted and bound to their tenant', () => {
  const key = randomBytes(32), token = 'fixture-example-token', sealed = sealToken(key, 'fixture-owner', token);
  assert.ok(!sealed.includes(token));
  assert.notEqual(sealToken(key, 'fixture-owner', token), sealed);
  assert.equal(unsealToken(key, 'fixture-owner', sealed), token);
  assert.throws(() => unsealToken(key, 'other-owner', sealed));
});

test('runner waits for a sleeping host and stops after bounded failures', async () => {
  let calls = 0;
  await waitForApi('https://stocky.invalid', { pause: async () => {}, fetchImpl: async () => {
    calls++;
    if (calls === 1) throw new Error('timeout');
    return new Response(null, { status: calls === 2 ? 503 : 204 });
  } });
  assert.equal(calls, 3);
  await assert.rejects(waitForApi('https://stocky.invalid', { attempts: 2, pause: async () => {},
    fetchImpl: async () => new Response(null, { status: 503 }) }), { message: 'STOCKY_UNREACHABLE' });
});

test('Instagram requests only use the official host and expose normalized errors', async () => {
  const publisher = createInstagramStoryPublisher({ fetchImpl: async (url, init) => {
    assert.equal(url.origin, 'https://graph.instagram.com');
    assert.equal(init.headers.Authorization, 'Bearer fixture-token');
    if (url.pathname.endsWith('/media')) {
      assert.equal(init.body.get('media_type'), 'STORIES');
      assert.equal(init.body.get('image_url'), 'https://stocky.invalid/story.jpg');
      return Response.json({ id: '321' });
    }
    if (url.pathname.endsWith('/media_publish')) {
      assert.equal(init.body.get('creation_id'), '321');
      return Response.json({ error: { code: 190, error_subcode: 463, message: 'must not surface' } }, { status: 400 });
    }
    return Response.json({ status_code: 'PUBLISHED' });
  } });
  assert.equal(await publisher.create('fixture-token', '123', 'https://stocky.invalid/story.jpg'), '321');
  assert.equal(await publisher.status('fixture-token', '321'), 'PUBLISHED');
  await assert.rejects(publisher.publish('fixture-token', '123', '321'), { message: 'META_TOKEN_EXPIRED' });
});
