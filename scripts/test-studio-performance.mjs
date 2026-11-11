import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { readProductDetail } from '../server/commerce/productRepository.js';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';

const fixture = await startCommerceFixture();
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
} finally {
  await sql.end();
  await fixture.stop();
}
