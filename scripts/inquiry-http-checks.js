import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function runInquiryHttpChecks({ sql, check, req, request, product, sku, owner }) {
  let count = 0, first;
  const shop = 'http-fullmatch-fixture', route = `/api/catalog/v1/${shop}/inquiry-preview`, item = { productSlug: product.slug, size: 'S', quantity: 2 };
  const quote = body => request(route, { method: 'POST', auth: false, body });
  const run = async (name, callback) => { await check(`inquiry HTTP: ${name}`, callback); count++; };
  const protectedState = async () => {
    const values = {};
    for (const table of ['products', 'pedidos', 'transactions', 'inventory_operations', 'inventory_movements', 'commercial_operations']) values[table] = (await sql.query(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS hash FROM ${table} t WHERE owner_phone=$1`, [owner])).rows[0];
    return values;
  };
  await run('public inquiry is an exact read-only calculation and does not subtract reservations twice', async () => {
    const before = await protectedState(), response = await quote({ items: [item] }); assert.equal(response.status, 200, response.text); first = response.json;
    assert.equal(first.canContact, true); assert.equal(first.total.amountMinor, '6200000'); assert.equal(first.total.currency, 'ARS');
    assert.equal(first.lines[0].quantity, 2); assert.equal(first.lines[0].unitPrice.amountMinor, '3100000');
    assert.equal(new URL(first.contactUrl).hostname, 'wa.me'); assert.ok(decodeURIComponent(first.contactUrl).includes('no reserva stock'));
    assert.equal((await quote({ items: [item], previousFingerprint: first.fingerprint })).json.changed, false);
    assert.deepEqual(await protectedState(), before);
    for (const field of ['owner_phone', 'skuId', 'stockAvailable', 'stockReserved', 'revision', 'orderId', 'paymentId']) assert.ok(!response.text.includes(`"${field}"`));
  });
  await run('manipulated prices, quantities, duplicates and owner authority are rejected', async () => {
    assert.equal((await quote({ items: [{ ...item, price: 1 }] })).status, 400);
    assert.equal((await quote({ items: [item], ownerPhone: '59899000999' })).status, 400);
    assert.equal((await quote({ items: [item, { ...item, size: 's' }] })).status, 400);
    for (const quantity of [0, -1, 1.5, 11, '2']) assert.equal((await quote({ items: [{ ...item, quantity }] })).status, 400);
    assert.equal((await quote({ items: [] })).status, 400); assert.equal((await quote({ items: Array.from({ length: 21 }, () => item) })).status, 400);
    assert.equal((await quote({ items: [item], previousFingerprint: 'not-a-hash' })).status, 400);
    const unknown = await quote({ items: [{ ...item, productSlug: 'private-or-other-business' }] }); assert.equal(unknown.status, 200); assert.equal(unknown.json.canContact, false); assert.equal(unknown.json.lines[0].title, 'Producto o talle no disponible');
  });
  await run('current prices and stock override the old summary before any contact handoff', async () => {
    await sql.query('UPDATE products SET price=40000 WHERE owner_phone=$1 AND id=$2', [owner, sku.id]);
    const changed = await quote({ items: [item], previousFingerprint: first.fingerprint }); assert.equal(changed.status, 200); assert.equal(changed.json.changed, true); assert.equal(changed.json.total.amountMinor, '8000000');
    await sql.query('UPDATE products SET price=31000,stock_available=0 WHERE owner_phone=$1 AND id=$2', [owner, sku.id]);
    const sold = await quote({ items: [item], previousFingerprint: changed.json.fingerprint }); assert.equal(sold.json.canContact, false); assert.equal(sold.json.contactUrl, null); assert.equal(sold.json.total, null);
    await sql.query('UPDATE products SET stock_available=2 WHERE owner_phone=$1 AND id=$2', [owner, sku.id]);
    assert.equal((await quote({ items: [{ ...item, quantity: 3 }] })).json.canContact, false);
  });
  await run('hidden products lose inquiry eligibility; SSR consultation remains a local nonpayment flow', async () => {
    const publication = (await req(`/products/${product.id}/publication`)).json;
    const body = { operationId: randomUUID(), expectedRevision: publication.revision, expectedProductRevision: product.revision, status: 'hidden', reason: 'Fixture inquiry revoke' };
    const hidden = await req(`/products/${product.id}/publication`, { method: 'PUT', body }); assert.equal(hidden.status, 200, hidden.text);
    assert.equal((await quote({ items: [item] })).json.canContact, false);
    const restored = await req(`/products/${product.id}/publication`, { method: 'PUT', body: { ...body, operationId: randomUUID(), expectedRevision: hidden.json.result.revision, status: 'published' } }); assert.equal(restored.status, 200, restored.text);
    const page = await request(`/c/${shop}/consulta`, { method: 'GET', auth: false }); assert.equal(page.status, 200); assert.ok(page.text.includes('Mi consulta')); assert.ok(page.text.includes('no crea un pedido ni reserva unidades'));
    assert.ok(page.headers['content-security-policy'].includes("connect-src 'self'")); assert.ok(!page.text.includes('/api/state'));
    assert.equal((await request('/catalog-assets/cart.js', { method: 'GET', auth: false })).status, 200);
  });
  return count;
}
