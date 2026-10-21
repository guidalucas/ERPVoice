import { normalizePhone } from '../phone.js';
import { sha256 } from './imageProcessor.js';

/** Explicit maintenance only. No bootstrap, inventory writes or implicit scheduling. */
export async function maintainCommercialMedia(runtime, storage, { businessId, apply = false, purge = false, now = Date.now() }) {
  if (!businessId || normalizePhone(businessId) !== businessId) throw new Error('EXPLICIT_CANONICAL_BUSINESS_REQUIRED');
  if (purge && !apply) throw new Error('PURGE_REQUIRES_EXPLICIT_APPLY');
  const graceBefore = new Date(now - 86_400_000), leaseBefore = new Date(now - 5 * 60_000), at = new Date(now);
  const report = await runtime.transaction(async client => {
    const rows = (await client.query(`SELECT status,count(*)::int AS count FROM commercial_product_images WHERE owner_phone=$1 GROUP BY status`, [businessId])).rows;
    const expired = (await client.query(`SELECT count(*)::int AS count FROM commercial_product_images WHERE owner_phone=$1 AND
      ((status='pending' AND upload_expires_at<$2) OR (status='processing' AND processing_started_at<$3))`, [businessId, at, leaseBefore])).rows[0].count;
    const retired = (await client.query("SELECT count(*)::int AS count FROM commercial_product_images WHERE owner_phone=$1 AND status='deleted' AND deleted_at<$2 AND purged_at IS NULL", [businessId, graceBefore])).rows[0].count;
    return { mode: apply ? 'apply' : 'inspect', states: rows, expiredUploads: expired, retiredEligible: retired, expiredMarked: 0, retiredPurged: 0, orphanCandidates: 0, orphansPurged: 0 };
  }, { readOnly: true });
  if (apply) report.expiredMarked = await runtime.transaction(async client => (await client.query(`UPDATE commercial_product_images SET status='failed',
    error_code='IMAGE_UPLOAD_EXPIRED',revision=revision+1,updated_at=$2 WHERE owner_phone=$1 AND
    ((status='pending' AND upload_expires_at<$2) OR (status='processing' AND processing_started_at<$3))`, [businessId, at, leaseBefore])).rowCount);
  if (!storage.configured || typeof storage.list !== 'function') {
    if (purge) throw new Error('PRIVATE_STORAGE_REQUIRED_FOR_PURGE'); return report;
  }
  const objects = await storage.list(sha256(Buffer.from(businessId)).slice(0, 32));
  const referenced = await runtime.withClient(async client => new Set((await client.query('SELECT master_key,thumbnail_key FROM commercial_product_images WHERE owner_phone=$1', [businessId])).rows.flatMap(row => [row.master_key, row.thumbnail_key]).filter(Boolean)));
  const orphans = objects.filter(object => Date.parse(object.createdAt) < graceBefore.getTime() && !referenced.has(object.key));
  report.orphanCandidates = orphans.length;
  if (!purge) return report;
  const retired = await runtime.withClient(async client => (await client.query("SELECT id FROM commercial_product_images WHERE owner_phone=$1 AND status='deleted' AND deleted_at<$2 AND purged_at IS NULL ORDER BY id LIMIT 50", [businessId, graceBefore])).rows);
  for (const image of retired) await runtime.transaction(async client => {
    const row = (await client.query("SELECT * FROM commercial_product_images WHERE owner_phone=$1 AND id=$2 AND status='deleted' AND deleted_at<$3 AND purged_at IS NULL FOR UPDATE", [businessId, image.id, graceBefore])).rows[0];
    if (!row || (await client.query('SELECT 1 FROM commercial_products WHERE owner_phone=$1 AND cover_image_id=$2', [businessId, image.id])).rowCount) return;
    for (const key of [row.master_key, row.thumbnail_key].filter(Boolean)) await storage.remove(key);
    await client.query('UPDATE commercial_product_images SET purged_at=$3 WHERE owner_phone=$1 AND id=$2', [businessId, image.id, at]); report.retiredPurged++;
  });
  for (const object of orphans.slice(0, 100)) await runtime.transaction(async client => {
    const [, imageId, attemptId] = object.key.split('/');
    const image = (await client.query('SELECT status,attempt_id FROM commercial_product_images WHERE owner_phone=$1 AND id=$2 FOR UPDATE', [businessId, imageId])).rows[0];
    if (image?.status === 'processing' && image.attempt_id === attemptId) return;
    const linked = await client.query('SELECT 1 FROM commercial_product_images WHERE owner_phone=$1 AND (master_key=$2 OR thumbnail_key=$2)', [businessId, object.key]);
    if (!linked.rowCount) { await storage.remove(object.key); report.orphansPurged++; }
  });
  return report;
}
