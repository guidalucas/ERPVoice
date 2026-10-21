import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createCommerceProductService } from '../server/commerce/productService.js';
import { createCommerceMediaService } from '../server/commerce/mediaService.js';
import { createMediaStorage } from '../server/commerce/mediaStorage.js';
import { sha256 } from '../server/commerce/imageProcessor.js';
import { maintainCommercialMedia } from '../server/commerce/mediaMaintenance.js';

/** Real PostgreSQL and local bytes, with failure injected only after the actual COMMIT. */
export async function runCommerceMediaFaultChecks({ db, sql, check, owner }) {
  const tempParent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(tempParent, 'fullmatch-media-fault-'));
  const context = { businessId: owner, actorId: owner, role: 'owner' }, runtime = db.stockyDatabaseRuntime;
  const storage = createMediaStorage({ NODE_ENV: 'test', COMMERCE_MEDIA_ADAPTER: 'local', COMMERCE_MEDIA_DIRECTORY: directory });
  const products = createCommerceProductService(runtime), real = createCommerceMediaService(runtime, storage);
  const bytes = await sharp({ create: { width: 40, height: 60, channels: 3, background: '#001a4d' } }).png().toBuffer();
  const create = async () => {
    const product = (await products.create(context, { operationId: randomUUID(), product: { title: 'Media fault fixture' }, skuLinks: [] })).result;
    return (await real.initialize(context, product.id, { operationId: randomUUID(), expectedRevision: product.revision,
      sourceSha256: sha256(bytes), sourceSizeBytes: bytes.length, altText: 'Fault fixture' })).result;
  };
  try {
    await check('commerce media: lost COMMIT acknowledgement preserves files referenced by ready metadata', async () => {
      const initialized = await create(); let calls = 0;
      const flakyRuntime = { withClient: runtime.withClient, transaction: async (...args) => {
        const result = await runtime.transaction(...args);
        if (++calls === 2) throw new Error('SIMULATED_LOST_COMMIT_ACK');
        return result;
      } };
      await assert.rejects(() => createCommerceMediaService(flakyRuntime, storage).upload(context, initialized.product.id, initialized.imageId, bytes), /SIMULATED_LOST_COMMIT_ACK/);
      const row = (await sql.query('SELECT status,master_key FROM commercial_product_images WHERE owner_phone=$1 AND id=$2', [owner, initialized.imageId])).rows[0];
      assert.equal(row.status, 'ready'); assert.ok((await storage.get(row.master_key)).length > 0);
      const recovered = await real.upload(context, initialized.product.id, initialized.imageId, bytes);
      assert.equal(recovered.images[0].status, 'ready');
      assert.ok((await real.content(context, initialized.product.id, initialized.imageId)).length > 0);
      const original = await storage.get(row.master_key), file = path.join(directory, ...row.master_key.split('/'));
      await fs.writeFile(file, Buffer.from('tampered storage bytes'));
      await assert.rejects(() => real.content(context, initialized.product.id, initialized.imageId), { code: 'MEDIA_INTEGRITY_ERROR' });
      await fs.writeFile(file, original);
    });
    await check('commerce media: expired processing lease recovers, live lease blocks duplicate work', async () => {
      const initialized = await create(), attempt = randomUUID();
      await sql.query("UPDATE commercial_product_images SET status='processing',attempt_id=$3,processing_started_at=NOW() WHERE owner_phone=$1 AND id=$2", [owner, initialized.imageId, attempt]);
      await assert.rejects(() => real.upload(context, initialized.product.id, initialized.imageId, bytes), { code: 'IMAGE_PROCESSING' });
      await sql.query("UPDATE commercial_product_images SET processing_started_at=NOW()-INTERVAL '3 minutes' WHERE owner_phone=$1 AND id=$2", [owner, initialized.imageId]);
      const recovered = await real.upload(context, initialized.product.id, initialized.imageId, bytes);
      assert.equal(recovered.images[0].status, 'ready');
      assert.notEqual((await sql.query('SELECT attempt_id FROM commercial_product_images WHERE owner_phone=$1 AND id=$2', [owner, initialized.imageId])).rows[0].attempt_id, attempt);
    });
    await check('commerce media: retirement while storing cannot resurrect the photo and cleans its attempt files', async () => {
      const initialized = await create(); let release, entered;
      const barrier = new Promise(resolve => { release = resolve; }), storing = new Promise(resolve => { entered = resolve; });
      let storedKey;
      const gated = { ...storage, put: async (key, data) => { await storage.put(key, data); if (key.endsWith('/master.jpg')) { storedKey = key; entered(); await barrier; } } };
      const upload = createCommerceMediaService(runtime, gated).upload(context, initialized.product.id, initialized.imageId, bytes);
      const rejection = assert.rejects(upload, { code: 'RESOURCE_NOT_FOUND' });
      await storing;
      const image = (await products.detail(context, initialized.product.id)).images[0];
      try { await real.update(context, initialized.product.id, initialized.imageId, { operationId: randomUUID(), expectedRevision: initialized.product.revision,
        expectedImageRevision: image.revision, altText: image.altText, focalX: 0.5, focalY: 0.5, retire: true }); } finally { release(); }
      await rejection;
      assert.equal((await products.detail(context, initialized.product.id)).images.length, 0);
      await assert.rejects(() => storage.get(storedKey), { code: 'ENOENT' });
    });
    await check('commerce media: maintenance inspects first and purges only old retired/unreferenced scoped files', async () => {
      const initialized = await create(), ready = await real.upload(context, initialized.product.id, initialized.imageId, bytes), image = ready.images[0];
      const row = (await sql.query('SELECT master_key FROM commercial_product_images WHERE owner_phone=$1 AND id=$2', [owner, image.id])).rows[0];
      await real.update(context, ready.id, image.id, { operationId: randomUUID(), expectedRevision: ready.revision, expectedImageRevision: image.revision,
        altText: image.altText, focalX: 0.5, focalY: 0.5, retire: true });
      await sql.query("UPDATE commercial_product_images SET deleted_at=NOW()-INTERVAL '2 days' WHERE owner_phone=$1 AND id=$2", [owner, image.id]);
      const pending = await create(); await sql.query("UPDATE commercial_product_images SET upload_expires_at=NOW()-INTERVAL '1 minute' WHERE owner_phone=$1 AND id=$2", [owner, pending.imageId]);
      const prefix = sha256(Buffer.from(owner)).slice(0, 32), orphan = `${prefix}/${randomUUID()}/${randomUUID()}/master.jpg`;
      const recent = `${prefix}/${randomUUID()}/${randomUUID()}/master.jpg`, foreign = `${'f'.repeat(32)}/${randomUUID()}/${randomUUID()}/master.jpg`;
      for (const key of [orphan, recent, foreign]) await storage.put(key, Buffer.from('fixture orphan bytes'));
      const old = new Date(Date.now() - 2 * 86_400_000);
      for (const key of [orphan, foreign]) await fs.utimes(path.join(directory, ...key.split('/')), old, old);
      const inspected = await maintainCommercialMedia(runtime, storage, { businessId: owner });
      assert.equal(inspected.mode, 'inspect'); assert.equal(inspected.expiredUploads, 1); assert.equal(inspected.retiredEligible, 1); assert.equal(inspected.orphanCandidates, 1);
      assert.ok((await storage.get(row.master_key)).length > 0);
      assert.equal((await sql.query('SELECT status FROM commercial_product_images WHERE owner_phone=$1 AND id=$2', [owner, pending.imageId])).rows[0].status, 'pending');
      const applied = await maintainCommercialMedia(runtime, storage, { businessId: owner, apply: true, purge: true });
      assert.equal(applied.expiredMarked, 1); assert.equal(applied.retiredPurged, 1); assert.equal(applied.orphansPurged, 1);
      await assert.rejects(() => storage.get(row.master_key), { code: 'ENOENT' }); await assert.rejects(() => storage.get(orphan), { code: 'ENOENT' });
      assert.ok((await storage.get(recent)).length > 0); assert.ok((await storage.get(foreign)).length > 0);
      const repeated = await maintainCommercialMedia(runtime, storage, { businessId: owner, apply: true, purge: true });
      assert.equal(repeated.retiredPurged, 0); assert.equal(repeated.orphansPurged, 0); assert.equal(repeated.expiredMarked, 0);
    });
  } finally {
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), tempParent.toLowerCase()); assert.ok(path.basename(resolved).startsWith('fullmatch-media-fault-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
