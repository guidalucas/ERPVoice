import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrateCommerce } from '../server/commerce/migration.js';
import { inspectCommerceSchema } from '../server/commerce/schemaInspection.js';
import { inspectStockyFoundation } from '../server/dbRuntime.js';

/** Called ONLY by the existing temporary embedded-PostgreSQL harness. */
export async function runCommerceFoundationChecks({ db, sql, check }) {
  const owner = '59899100001', other = '59899100002';
  const createInput = { name: 'FullMatch fixture camiseta', size: 'M', stockAvailable: 3, stockReserved: 1, price: 65000 };
  const beforeProduct = await db.createProductRecord(createInput, owner, { operationId: 'commerce-historical-create' });
  const otherProduct = await db.createProductRecord({ ...createInput, size: 'L' }, other, { operationId: 'commerce-other-create' });
  await check('commerce migration is explicit, additive, repeatable and preserves real inventory/history rows', async () => {
    assert.equal((await inspectCommerceSchema(sql)).ready, false);
    const before = (await sql.query('SELECT to_jsonb(p) AS row FROM products p ORDER BY id')).rows;
    assert.deepEqual(await migrateCommerce(sql), { changed: true, ready: true, inventoryUnchanged: true });
    assert.deepEqual(await migrateCommerce(sql), { changed: false, ready: true, inventoryUnchanged: true });
    assert.deepEqual((await sql.query('SELECT to_jsonb(p) AS row FROM products p ORDER BY id')).rows, before);
    assert.equal((await sql.query('SELECT count(*)::int AS n FROM commerce_profiles')).rows[0].n, 0);
    assert.equal((await sql.query('SELECT count(*)::int AS n FROM inventory_money_policies')).rows[0].n, 0);
  });
  await check('commercial tables have RLS and no anonymous/authenticated access', async () => {
    for (const role of ['anon', 'authenticated']) {
      await sql.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await migrateCommerce(sql);
    const schema = await inspectCommerceSchema(sql);
    assert.equal(schema.ready, true); assert.equal(schema.rlsEnabled, true); assert.equal(schema.apiRolesRevoked, true);
  });
  const p1 = randomUUID(), p2 = randomUUID();
  await check('scoped FK/unique constraints prevent cross-business SKU/photo links and double ownership', async () => {
    for (const business of [owner, other]) await sql.query(`INSERT INTO commerce_profiles(owner_phone,id,brand_name,enabled,created_by)
      VALUES($1,$2,'Fixture FullMatch',true,$1)`, [business, randomUUID()]);
    for (const id of [p1, p2]) await sql.query(`INSERT INTO commercial_products(owner_phone,id,title,slug,created_by,updated_by)
      VALUES($1,$2,'Fixture camiseta',$3,$1,$1)`, [owner, id, `fixture-${id}`]);
    const link = (id, skuId) => sql.query(`INSERT INTO commercial_product_skus(owner_phone,commercial_product_id,sku_id,identity_fingerprint_at_link,linked_by)
      VALUES($1,$2,$3,'fixture-fingerprint',$1)`, [owner, id, skuId]);
    await assert.rejects(() => link(p1, otherProduct.id), { code: '23503' });
    await link(p1, beforeProduct.id);
    await assert.rejects(() => link(p2, beforeProduct.id), { code: '23505' });
    const image = randomUUID();
    await sql.query(`INSERT INTO commercial_product_images(owner_phone,id,commercial_product_id,source_sha256,source_size_bytes,upload_expires_at,created_by)
      VALUES($1,$2,$3,$4,10,NOW()+interval '30 minutes',$1)`, [owner, image, p1, 'a'.repeat(64)]);
    await assert.rejects(() => sql.query('UPDATE commercial_products SET cover_image_id=$1 WHERE owner_phone=$2 AND id=$3', [image, owner, p2]), { code: '23503' });
    await assert.rejects(() => sql.query(`UPDATE commercial_product_images SET status='ready',master_key='fixture',thumbnail_key='fixture-thumb',
      master_sha256=$1,mime_type='image/jpeg',height=100,stored_size_bytes=10 WHERE owner_phone=$2 AND id=$3`, ['b'.repeat(64), owner, image]), { code: '23514' });
    await sql.query('BEGIN');
    try {
      await sql.query('ALTER TABLE commercial_products DROP CONSTRAINT commercial_product_cover_fk');
      assert.equal((await inspectCommerceSchema(sql)).ready, false);
    } finally { await sql.query('ROLLBACK'); }
  });
  await check('confirmed money policy rejects NEW ambiguous prices, preserves historical replay and other businesses', async () => {
    await sql.query(`INSERT INTO inventory_money_policies(owner_phone,currency,storage_unit,fraction_digits,confirmed_by,confirmed_at)
      VALUES($1,'ARS','major_integer',2,$1,NOW())`, [owner]);
    const replay = await db.createProductRecord(createInput, owner, { operationId: 'commerce-historical-create' });
    assert.equal(replay.id, beforeProduct.id); assert.equal(replay.priceCurrency, 'XXX');
    await assert.rejects(() => db.createProductRecord({ ...createInput, name: 'New ambiguous' }, owner, { operationId: 'commerce-new-ambiguous' }), { code: 'MONEY_UNCONFIRMED' });
    const fixed = await db.updateProductRecord(beforeProduct.id, { priceCurrency: 'ARS' }, owner,
      { operationId: 'commerce-reviewed-currency', expectedRevision: beforeProduct.revision, reason: 'Fixture-only confirmed money meaning', actorId: owner });
    assert.equal(fixed.price, beforeProduct.price); assert.equal(fixed.stockAvailable, 3); assert.equal(fixed.stockReserved, 1);
    await assert.rejects(() => db.updateProductRecord(beforeProduct.id, { priceCurrency: 'USD' }, owner,
      { operationId: 'commerce-wrong-currency', expectedRevision: fixed.revision, reason: 'Fixture rejection', actorId: owner }), { code: 'MONEY_UNCONFIRMED' });
    const unaffected = await db.createProductRecord({ ...createInput, name: 'Other unconfigured business' }, other, { operationId: 'commerce-other-unconfigured' });
    assert.equal(unaffected.priceCurrency, 'XXX');
    const original = await db.createProductRecord(createInput, owner, { operationId: 'commerce-historical-create' });
    assert.equal(original.priceCurrency, 'XXX'); // Original receipt, not a rewritten historical value.
  });
  await check('production readiness inspects existing schema without DDL or business normalization', async () => {
    const statements = [];
    const inspected = await inspectStockyFoundation({ query: async (...args) => { statements.push(args[0]); return sql.query(...args); } });
    assert.equal(inspected.ready, true); assert.ok(statements.every(statement => /^SELECT/i.test(statement.trim())));
    await sql.query('BEGIN');
    try {
      await sql.query('ALTER TABLE auth_wa_challenges RENAME COLUMN login_token TO missing_login_token');
      await assert.rejects(() => inspectStockyFoundation(sql), { code: 'STOCKY_SCHEMA_NOT_READY' });
    } finally { await sql.query('ROLLBACK'); }
    await db.closeDatabase();
    const previous = process.env.STOCKY_SCHEMA_MODE;
    process.env.STOCKY_SCHEMA_MODE = 'verify';
    try { assert.equal((await db.getStateSnapshotStrict(owner)).products[0].id, beforeProduct.id); }
    finally { await db.closeDatabase(); if (previous === undefined) delete process.env.STOCKY_SCHEMA_MODE; else process.env.STOCKY_SCHEMA_MODE = previous; }
  });
}
