import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { issueJwt } from '../server/auth.js';
import { migrateContent, inspectContentSchema } from '../server/commerce/contentMigration.js';

export async function runContentHttpChecks({ sql, check, req, request, product, sku, owner, other, prepare }) {
  let count = 0, snapshot;
  const run = async (name, callback) => { await check(`content HTTP: ${name}`, callback); count++; };
  const promotion = { percentage: 15, startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3_600_000).toISOString(), timeZone: 'UTC', label: 'PROMO FULLMATCH' };
  await run('explicit library migration adds a valid private index without duplicating snapshots', async () => {
    const before = (await sql.query('SELECT count(*)::int AS n FROM commercial_operations')).rows[0].n;
    assert.equal((await migrateContent(sql)).changed, true); assert.equal((await migrateContent(sql)).changed, false); assert.equal((await inspectContentSchema(sql)).ready, true);
    assert.equal((await sql.query('SELECT count(*)::int AS n FROM commercial_operations')).rows[0].n, before);
  });
  await run('promotions derive exact prices and validity from Stocky without changing its prices', async () => {
    const response = await prepare({ templateId: 'promo', promotion }); assert.equal(response.status, 201, response.text); snapshot = response.json.result;
    assert.equal(snapshot.content.price.minAmountMinor, '3100000'); assert.equal(snapshot.content.promotion.minAmountMinor, '2635000');
    assert.ok(Date.parse(snapshot.expiresAt) <= Date.parse(promotion.endsAt));
    assert.equal((await sql.query('SELECT price FROM products WHERE owner_phone=$1 AND id=$2', [owner, sku.id])).rows[0].price, '31000');
    assert.equal((await prepare({ templateId: 'promo', promotion: { ...promotion, percentage: 91 } })).status, 400);
    const expired = { ...promotion, startsAt: new Date(Date.now() - 120_000).toISOString(), endsAt: new Date(Date.now() - 60_000).toISOString() };
    assert.equal((await prepare({ templateId: 'promo', promotion: expired })).status, 422);
    await sql.query('UPDATE products SET price=32000 WHERE owner_phone=$1 AND id=$2', [owner, sku.id]);
    assert.equal((await req(`/story-snapshots/${snapshot.snapshotId}/validate`, { method: 'POST', body: {} })).json.valid, false);
    await sql.query('UPDATE products SET price=31000 WHERE owner_phone=$1 AND id=$2', [owner, sku.id]);
    assert.equal((await prepare({ templateId: 'matchday' })).status, 201);
  });
  await run('client-reported export events are scoped, idempotent and do not assert delivery/publication', async () => {
    const route = `/story-snapshots/${snapshot.snapshotId}/export-events`, body = { operationId: randomUUID(), kind: 'download_requested', filename: 'fixture-story.png', mimeType: 'image/png', sizeBytes: 1024, sha256: 'a'.repeat(64) };
    const one = await req(route, { method: 'POST', body }); assert.equal(one.status, 201, one.text);
    assert.deepEqual((await req(route, { method: 'POST', body })).json, one.json); assert.equal(one.json.result.source, 'client_reported'); assert.equal(one.json.result.kind, 'download_requested');
    assert.equal((await req(route, { method: 'POST', body: { ...body, filename: 'other.png' } })).status, 409);
    assert.equal((await request(`/api/commerce/v1${route}`, { method: 'POST', auth: false, body })).status, 401);
    assert.equal((await req(route, { method: 'POST', headers: { Authorization: `Bearer ${issueJwt({ phoneNumber: other })}` }, body })).status, 404);
    assert.equal((await req(route, { method: 'POST', body: { ...body, operationId: randomUUID(), filename: '../unsafe.png' } })).status, 400);
    assert.equal((await req(route, { method: 'POST', body: { ...body, operationId: randomUUID(), ownerPhone: other } })).status, 400);
  });
  await run('library is paginated, private and distinguishes preparation from export requests', async () => {
    const all = await req('/content-library'); assert.equal(all.status, 200, all.text);
    const item = all.json.items.find(item => item.snapshotId === snapshot.snapshotId); assert.ok(item); assert.equal(item.productId, product.id); assert.equal(item.lastExport.kind, 'download_requested');
    assert.equal(item.expired, false); assert.ok(!Object.hasOwn(item, 'published')); assert.ok(all.json.items.some(item => item.lastExport === null));
    const page = await req('/content-library?limit=1'); assert.equal(page.json.items.length, 1); assert.ok(page.json.nextCursor);
    const next = await req(`/content-library?limit=1&cursor=${encodeURIComponent(page.json.nextCursor)}`); assert.equal(next.status, 200, next.text); assert.notEqual(next.json.items[0].snapshotId, page.json.items[0].snapshotId);
    const foreign = await req('/content-library', { headers: { Authorization: `Bearer ${issueJwt({ phoneNumber: other })}` } }); assert.equal(foreign.status, 200); assert.equal(foreign.json.items.length, 0);
    assert.equal((await req('/content-library?limit=51')).status, 400); assert.equal((await req('/content-library?cursor=invalid')).status, 400);
  });
  return count;
}
