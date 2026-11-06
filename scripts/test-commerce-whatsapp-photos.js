import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import sharp from 'sharp';
import { createDatabaseRuntime } from '../server/dbRuntime.js';
import { createCommerceMediaService } from '../server/commerce/mediaService.js';
import { createCommerceProductService } from '../server/commerce/productService.js';
import { downloadWhatsAppPhoto } from '../server/commerce/whatsappPhotoDownload.js';
import { inspectWhatsAppPhotoSchema, migrateWhatsAppPhotos } from '../server/commerce/whatsappPhotoMigration.js';
import { createWhatsAppPhotoService } from '../server/commerce/whatsappPhotoService.js';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

test('Meta photo download uses authenticated, bounded downloads from Meta', async () => {
  const env = { META_ACCESS_TOKEN: 'test-token', META_GRAPH_API_VERSION: 'v21.0' };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url.href);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    if (calls.length === 1) return Response.json({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/', mime_type: 'image/png' });
    return new Response(new Uint8Array([1, 2, 3]));
  };
  assert.deepEqual(await downloadWhatsAppPhoto('123', '456', { env, fetcher }), Buffer.from([1, 2, 3]));
  assert.equal(calls[0], 'https://graph.facebook.com/v21.0/123?phone_number_id=456');
  await assert.rejects(downloadWhatsAppPhoto('123', null, { env, fetcher: async () => Response.json({ url: 'https://outside.example/image' }) }), { code: 'IMAGE_META_URL_INVALID' });
  await assert.rejects(downloadWhatsAppPhoto('123', null, { env, fetcher: async () => Response.json({
    url: 'https://lookaside.fbsbx.com/image', file_size: 13 * 1024 * 1024,
  }) }), { code: 'IMAGE_SIZE_INVALID' });
});

test('WhatsApp groups, assigns and recovers photos using PostgreSQL and the Studio service', async t => {
  const fixture = await startCommerceFixture();
  const runtime = createDatabaseRuntime({ connectionString: fixture.connection });
  t.after(async () => { await runtime.close(); await fixture.stop(); });
  assert.deepEqual(await runtime.withClient(inspectWhatsAppPhotoSchema), { ready: false });
  assert.deepEqual(await runtime.withClient(migrateWhatsAppPhotos), { ready: true });
  assert.deepEqual(await runtime.withClient(migrateWhatsAppPhotos), { ready: true });

  const context = { businessId: fixture.owner, actorId: fixture.owner, role: 'owner' };
  const files = new Map();
  const storage = { configured: true, put: async (key, bytes) => files.set(key, bytes), get: async key => files.get(key), remove: async key => files.delete(key) };
  const media = createCommerceMediaService(runtime, storage);
  const products = createCommerceProductService(runtime);
  const bytes = await sharp({ create: { width: 32, height: 40, channels: 3, background: 'red' } }).png().toBuffer();
  let now = Date.now(), downloads = 0;
  const download = async id => { downloads++; return id.startsWith('invalid') ? Buffer.from('not an image') : bytes; };
  const service = (mediaService = media, complete) => createWhatsAppPhotoService({ runtime, media: mediaService, download, clock: () => now, complete });
  let bot = service();
  const query = (statement, params) => runtime.withClient(client => client.query(statement, params));
  const create = async title => (await products.create(context, { operationId: randomUUID(), product: { title }, skuLinks: [] })).result;
  const black = await create('Camiséta Negra'), white = await create('Camiseta Blanca');
  const ready = async product => (await products.detail(context, product.id)).images.filter(image => image.status === 'ready').length;
  const receive = async (payload, id = randomUUID(), sender = context) => {
    await query('INSERT INTO meta_message_claims(message_id,owner_phone,sender_phone) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [id, sender.businessId, sender.actorId]);
    return bot.route(sender, { id, timestamp: String(Math.floor(now / 1_000)), ...payload }, '456');
  };
  const image = (id, caption = '', sender) => receive({ type: 'image', image: { id, caption } }, id, sender);
  const say = (body, id) => receive({ type: 'text', text: { body } }, id);
  const advance = async ms => { now += ms; return bot.flushDue(); };
  const replies = async id => (await query('SELECT reply_text FROM meta_reply_outbox WHERE event_id=$1', [id])).rows.map(row => row.reply_text);

  await t.test('three photos with one caption on the last photo save once to the same gallery', async () => {
    assert.equal(await image('group-1'), true);
    assert.equal(await image('group-2'), true);
    assert.equal(await advance(4_000), false);
    assert.equal(await image('group-3', 'camiseta negra'), true);
    assert.equal(await image('group-1'), true);
    bot = service();
    assert.equal(await advance(5_000), true);
    assert.equal(await bot.processJob(), true);
    assert.equal(await ready(black), 3);
    assert.equal(await ready(white), 0);
    assert.deepEqual(await replies('commerce-photo:result:group-1'), ['Agregué 3 fotos a Camiséta Negra.']);
    assert.deepEqual(await replies('commerce-photo:question:group-1'), []);
    const detail = await products.detail(context, black.id);
    assert.equal(detail.coverImageId, detail.images[0].id);
  });

  await t.test('a caption switches a new group even with another active product; a stock question closes the load', async () => {
    assert.equal(await image('switch-1'), true);
    assert.equal(await image('switch-2', 'Camiseta blanca'), true);
    assert.equal(await say('¿Cuánto stock tengo?', 'new-topic'), false);
    assert.equal(await bot.processJob(), true);
    assert.equal(await ready(black), 3);
    assert.equal(await ready(white), 2);
    assert.equal(await image('needs-product'), true);
    assert.equal(await say('¿Cuánto stock tengo?', 'new-topic'), false);
    assert.equal(await advance(5_000), true);
    assert.deepEqual(await replies('commerce-photo:question:needs-product'), ['¿A qué producto va esta foto?']);
    assert.equal(await say('Camiseta blanca'), true);
    assert.equal(await bot.processJob(), true);
    assert.equal(await ready(white), 3);
  });

  await t.test('inactivity expires the active product; ambiguous captions offer an explicit selection', async () => {
    assert.equal(await image('renew'), true);
    assert.equal(await advance(5_000), true);
    assert.equal(await bot.processJob(), true);
    assert.equal(await ready(white), 4);
    await advance(15 * 60_000);
    assert.equal(await image('expired'), true);
    assert.equal(await advance(5_000), true);
    assert.deepEqual(await replies('commerce-photo:question:expired'), ['¿A qué producto va esta foto?']);
    assert.equal(await image('ambiguous', 'Camiseta'), true);
    assert.equal(await advance(5_000), true);
    const [question] = await replies('commerce-photo:question:ambiguous');
    assert.match(question, /1\. Camiseta Blanca/);
    assert.match(question, /2\. Camiséta Negra/);
    assert.equal(await say('ficha 2'), true);
    assert.equal(await bot.processJob(), true);
    assert.equal(await ready(black), 5);
  });

  await t.test('a corrupt photo leaves room; a retry after storing bytes recovers without downloading again', async () => {
    assert.equal(await say('agregar fotos a Camiseta negra'), true);
    assert.equal(await image('invalid-image'), true);
    assert.equal(await advance(5_000), true);
    assert.equal(await bot.processJob(), true);
    const detail = await products.detail(context, black.id);
    assert.equal(detail.images.length, 5);
    assert.match((await replies('commerce-photo:result:invalid-image'))[0], /sin guardar 1 foto/);

    bot = service({ ...media, upload: async (...args) => { await media.upload(...args); throw new Error('simulated lost response'); } });
    assert.equal(await image('retry-save'), true);
    assert.equal(await advance(5_000), true);
    assert.equal(await bot.processJob(), false);
    assert.equal(await ready(black), 6);
    assert.deepEqual(await replies('commerce-photo:result:retry-save'), []);
    const before = downloads;
    await query("UPDATE commerce_whatsapp_photo_jobs SET available_at=NOW() WHERE id='retry-save'");
    bot = service();
    assert.equal(await bot.processJob(), true);
    assert.equal(downloads, before);
    assert.equal(await ready(black), 6);
    assert.deepEqual(await replies('commerce-photo:result:retry-save'), ['Agregué 1 foto a Camiséta Negra.']);
  });

  await t.test('Studio capacity allows partial success and a regular member cannot attach photos', async () => {
    for (const id of ['cap-1', 'cap-2', 'cap-3']) assert.equal(await image(id), true);
    assert.equal(await advance(5_000), true);
    assert.equal(await bot.processJob(), true);
    assert.equal(await ready(black), 8);
    assert.match((await replies('commerce-photo:result:cap-1'))[0], /Agregué 2 fotos.*sin guardar 1 foto/);
    assert.equal(await image('blocked', 'Camiseta blanca', { ...context, actorId: fixture.member.owner, role: 'member' }), true);
    assert.match((await replies('commerce-photo:access:blocked'))[0], /permiso de edición/);
    assert.equal(await ready(white), 4);
  });

  await t.test('the natural name of a camiseta matches its Studio title in captions and replies', async () => {
    const boca = await create('Boca Titular 2026');
    const older = await create('Camiseta de Boca Titular 2025');
    assert.equal(await image('boca-with-caption', 'Camiseta de boca titular 2026'), true);
    assert.equal(await image('boca-without-caption'), true);
    assert.equal(await advance(5_000), true);
    assert.equal(await bot.processJob(), true);
    assert.equal(await ready(boca), 2);
    assert.equal(await ready(older), 0);
    assert.deepEqual(await replies('commerce-photo:result:boca-with-caption'), ['Agregué 2 fotos a Boca Titular 2026.']);

    assert.equal(await say('¿Cuánto stock tengo?'), false);
    assert.equal(await image('boca-pending'), true);
    assert.equal(await advance(5_000), true);
    await query('UPDATE meta_reply_outbox SET provider_message_ids=$1 WHERE event_id=$2',
      [JSON.stringify(['wamid.photo-question']), 'commerce-photo:question:boca-pending']);
    assert.equal(await receive({ type: 'text', text: { body: 'Camiseta de Boca 2030' }, context: { id: 'wamid.photo-question' } }, 'unknown-photo-reply'), true);
    assert.match((await replies('commerce-photo:choose:unknown-photo-reply'))[0], /No encontré esa ficha en Studio/);
    assert.equal(await say('Camiseta de boca titular 2026'), true);
    assert.equal(await bot.processJob(), true);
    assert.equal(await ready(boca), 3);

    const alternate = await create('Camiseta de Boca Titular 2026');
    assert.equal(await image('boca-ambiguous', 'La camiseta de Boca Titular 2026'), true);
    assert.equal(await advance(5_000), true);
    assert.equal(await bot.processJob(), false);
    assert.match((await replies('commerce-photo:question:boca-ambiguous'))[0], /¿Cuál ficha querés usar\?/);
    assert.equal(await ready(alternate), 0);
  });

  await t.test('approximate references use inventory interpretation and collapse sizes to one Studio gallery', async () => {
    const [barcelona, argentina] = fixture.products;
    const seen = [];
    bot = service(media, async request => {
      const { sourceText, catalog } = JSON.parse(request.messages[1].content);
      seen.push(sourceText);
      assert.ok(catalog.products.some(product => product.id === barcelona.skuIds[0]));
      assert.equal(Object.hasOwn(catalog.products[0], 'stockAvailable'), false);
      if (['Decime el stock disponible', '¿Cuánto stock queda?'].includes(sourceText)) {
        return { ok: true, json: { contractVersion: 1, kind: 'other_topic' } };
      }
      const ids = sourceText === 'la titular del año pasado' ? [...barcelona.skuIds, ...argentina.skuIds] : barcelona.skuIds;
      const selector = sourceText === 'todos los productos' ? { kind: 'all' } : { kind: 'ids', ids };
      return { ok: true, json: { contractVersion: 1, kind: 'query', queries: [{ itemId: 'photo', type: 'inventory.query', selector }],
        evidence: [{ itemId: 'photo', quote: sourceText }] } };
    });

    assert.equal(await say('Decime el stock disponible'), false);
    assert.equal(await image('short-name', 'la blaugrana del año pasado'), true);
    assert.equal(await image('short-name-extra'), true);
    assert.equal(await advance(5_000), true);
    assert.equal(await bot.processJob(), true);
    assert.equal(await ready(barcelona), 3);
    assert.equal(await ready(argentina), 1);

    assert.equal(await image('multiple-models', 'la titular del año pasado'), true);
    assert.equal(await advance(5_000), true);
    assert.equal(await bot.processJob(), false);
    assert.match((await replies('commerce-photo:question:multiple-models'))[0], /Barcelona titular 2025/);
    assert.match((await replies('commerce-photo:question:multiple-models'))[0], /Argentina titular 2025/);
    assert.equal(await say('¿Cuánto stock queda?'), false);
    assert.equal(await bot.processJob(), false);

    assert.equal(await image('pending-short-name'), true);
    assert.equal(await advance(5_000), true);
    assert.equal(await say('la del Barça del 25'), true);
    assert.equal(await bot.processJob(), true);
    assert.equal(await ready(barcelona), 4);

    assert.equal(await image('global-model-selection', 'todos los productos'), true);
    assert.equal(await advance(5_000), true);
    assert.equal(await bot.processJob(), false);
    assert.equal(await ready(barcelona), 4);
    assert.ok(seen.includes('la del Barça del 25'));
  });
});

test('signed image webhooks reach the published product gallery through the running server', async t => {
  const secret = 'whatsapp-photo-integration-test-secret';
  const bytes = await sharp({ create: { width: 32, height: 40, channels: 3, background: 'blue' } }).png().toBuffer();
  const fixture = await startCommerceFixture({ configureApi: async ({ connection, directory }) => {
    const runtime = createDatabaseRuntime({ connectionString: connection });
    try { await runtime.withClient(migrateWhatsAppPhotos); } finally { await runtime.close(); }
    const stub = join(directory, 'meta-photo-stub.mjs');
    await writeFile(stub, `const fetchActual = globalThis.fetch;
      globalThis.fetch = (input, options) => {
        const url = new URL(input);
        if (url.hostname === 'graph.facebook.com') {
          if (options.method === 'POST') return Response.json({ messages: [{ id: 'wamid.test-reply' }] });
          return Response.json({ url: 'https://lookaside.fbsbx.com/test-photo', mime_type: 'image/png' });
        }
        if (url.hostname === 'lookaside.fbsbx.com') return new Response(Buffer.from('${bytes.toString('base64')}', 'base64'));
        if (url.hostname === 'photo-model.example') {
          const { sourceText, catalog } = JSON.parse(JSON.parse(options.body).messages[1].content);
          const ids = catalog.products.filter(product => product.name === 'Demo Barcelona 2025').map(product => product.id);
          const result = { contractVersion: 1, kind: 'query', queries: [{ itemId: 'photo', type: 'inventory.query', selector: { kind: 'ids', ids } }],
            evidence: [{ itemId: 'photo', quote: sourceText }] };
          return Response.json({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] });
        }
        return fetchActual(input, options);
      };`);
    return { NODE_OPTIONS: `--import=${pathToFileURL(stub).href}`, META_APP_SECRET: secret,
      META_ACCESS_TOKEN: 'fixture-token', META_PHONE_NUMBER_ID: '456', COMMERCE_WHATSAPP_PHOTOS: 'true',
      LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'fixture-model-token', GEMINI_MODEL_ENDPOINT: 'https://photo-model.example/chat/completions' };
  } });
  const runtime = createDatabaseRuntime({ connectionString: fixture.connection });
  t.after(async () => { await runtime.close(); await fixture.stop(); });
  const product = fixture.products[0];
  const send = async (id, caption) => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
      metadata: { phone_number_id: '456' }, messages: [{ type: 'image', from: fixture.owner, id,
        timestamp: String(Math.floor(Date.now() / 1_000)), image: { id, caption } }],
    } }] }] });
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    const response = await fetch(`${fixture.apiUrl}/api/meta-webhook`, { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${signature}` } });
    assert.equal(response.status, 200);
    await response.text();
  };
  await send('wamid-photo-1');
  await send('wamid-photo-2');
  await send('wamid-photo-3', 'la blaugrana del 25');
  await send('wamid-photo-2');

  const expectedReply = `Agregué 3 fotos a ${product.title}.`;
  let delivered = [];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    delivered = (await runtime.withClient(client => client.query("SELECT reply_text FROM meta_reply_outbox WHERE status='sent'"))).rows;
    if (delivered.length) break;
    await delay(100);
  }
  assert.deepEqual(delivered.map(row => row.reply_text), [expectedReply]);
  const gallery = await fetch(`${fixture.apiUrl}/api/commerce/v1/products/${product.id}`, { headers: { Authorization: `Bearer ${fixture.token}` } });
  assert.equal(gallery.status, 200);
  assert.equal((await gallery.json()).images.filter(photo => photo.status === 'ready').length, 4);
});
