import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { buildCommerceSqlBundle } from './generate-commerce-sql.js';
import { startCommerceFixture } from './fullmatch/fixtureRuntime.js';
import { inspectCommerceSchema } from '../server/commerce/schemaInspection.js';
import { inspectCatalogSchema, migrateCatalog } from '../server/commerce/catalogMigration.js';
import { inspectContentSchema, migrateContent } from '../server/commerce/contentMigration.js';
import { migrateCommerce } from '../server/commerce/migration.js';
import { migrateAppearance, inspectAppearanceSchema } from '../server/commerce/appearanceMigration.js';
import { readCommerceMigration } from '../server/commerce/migrationSource.js';
import { buildBusinessEnableSql } from './generate-commerce-business-sql.js';
import { buildCurrencyCorrectionSql } from './generate-commerce-currency-sql.js';
import { inventoryProductFingerprint } from '../server/inventoryOperations.js';
import { inventoryRowToProduct } from '../server/inventoryPostgres.js';
import { createCommerceProductService } from '../server/commerce/productService.js';

const bundle = await buildCommerceSqlBundle();
assert.equal((await fs.readFile(new URL('../docs/fullmatch/SUPABASE_COMMERCIAL_SCHEMA.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'), bundle);
const fixture = await startCommerceFixture(), clients = [];
let checks = 0;
const check = async (label, callback) => { await callback(); checks++; console.log(`PASS SQL editor: ${label}`); };
const connect = async connectionString => { const client = new Client({ connectionString }); clients.push(client); await client.connect(); return client; };
const readiness = async client => {
  assert.equal((await inspectCommerceSchema(client)).ready, true);
  assert.equal((await inspectCatalogSchema(client)).ready, true);
  assert.equal((await inspectContentSchema(client)).ready, true);
  assert.equal((await inspectAppearanceSchema(client)).ready, true);
};
const snapshot = async client => (await client.query('SELECT jsonb_agg(to_jsonb(p) ORDER BY id) AS data FROM products p')).rows[0].data;
try {
  const admin = await connect(fixture.connection);
  assert.equal(new URL(fixture.connection).hostname, '127.0.0.1');
  assert.ok(new URL(fixture.connection).pathname.startsWith('/fullmatch_fixture_'));
  const fresh = async (inventory = true) => {
    const name = `fullmatch_sql_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(fixture.connection); url.pathname = `/${name}`;
    const client = await connect(url.href);
    if (inventory) {
      await client.query(`CREATE TABLE products(id TEXT PRIMARY KEY, owner_phone TEXT NOT NULL,
        stock_available INTEGER, stock_reserved INTEGER, price INTEGER, price_currency TEXT);
        INSERT INTO products VALUES('existing-sku','59899000088',7,2,65000,'XXX');`);
    }
    return client;
  };
  await check('fresh schema, all three runtime checks and unchanged inventory', async () => {
    const client = await fresh(), before = await snapshot(client);
    await client.query(bundle); await readiness(client);
    assert.deepEqual(await snapshot(client), before);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM commerce_profiles')).rows[0].n, 0);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM inventory_money_policies')).rows[0].n, 0);
    const ledger = (await client.query('SELECT * FROM commerce_schema_migrations ORDER BY version')).rows;
    await client.query(bundle); await readiness(client);
    assert.deepEqual((await client.query('SELECT * FROM commerce_schema_migrations ORDER BY version')).rows, ledger);
    assert.deepEqual(await snapshot(client), before);
    for (const migrate of [migrateCommerce, migrateCatalog, migrateContent, migrateAppearance]) assert.equal((await migrate(client)).changed, false);
  });
  await check('existing populated Studio survives SQL rerun unchanged', async () => {
    const before = await snapshot(admin);
    const profiles = (await admin.query('SELECT * FROM commerce_profiles ORDER BY owner_phone')).rows;
    const products = (await admin.query('SELECT * FROM commercial_products ORDER BY id')).rows;
    await admin.query(bundle); await readiness(admin);
    assert.deepEqual(await snapshot(admin), before);
    assert.deepEqual((await admin.query('SELECT * FROM commerce_profiles ORDER BY owner_phone')).rows, profiles);
    assert.deepEqual((await admin.query('SELECT * FROM commercial_products ORDER BY id')).rows, products);
  });
  await check('partial CLI installation completes through SQL Editor', async () => {
    const client = await fresh(), before = await snapshot(client);
    await migrateCommerce(client); await client.query(bundle); await readiness(client);
    assert.deepEqual(await snapshot(client), before);
  });
  await check('legacy CRLF checksums stay valid for both SQL and CLI', async () => {
    const client = await fresh(); await client.query(bundle);
    for (const version of [1, 2, 3, 4]) {
      const source = await readCommerceMigration(version);
      await client.query('UPDATE commerce_schema_migrations SET checksum=$2 WHERE version=$1', [version, source.acceptedChecksums.at(-1)]);
    }
    const ledger = (await client.query('SELECT * FROM commerce_schema_migrations ORDER BY version')).rows;
    await client.query(bundle);
    for (const migrate of [migrateCommerce, migrateCatalog, migrateContent, migrateAppearance]) assert.equal((await migrate(client)).changed, false);
    assert.deepEqual((await client.query('SELECT * FROM commerce_schema_migrations ORDER BY version')).rows, ledger);
  });
  await check('unknown checksum rolls back earlier migration steps', async () => {
    const client = await fresh(); await migrateCommerce(client);
    await client.query("INSERT INTO commerce_schema_migrations(version,checksum) VALUES(3,'unknown-source')");
    const before = await snapshot(client);
    await assert.rejects(client.query(bundle), /MIGRATION_CHECKSUM_MISMATCH/);
    await client.query('ROLLBACK');
    assert.equal((await client.query("SELECT to_regclass('public.commerce_catalogs') AS relation")).rows[0].relation, null);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM commerce_schema_migrations WHERE version=2')).rows[0].n, 0);
    assert.deepEqual(await snapshot(client), before);
  });
  await check('API grants revoked only for commercial tables', async () => {
    for (const role of ['anon', 'authenticated']) {
      if (!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) await admin.query(`CREATE ROLE ${role}`);
    }
    const client = await fresh(); await client.query(bundle);
    await client.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated');
    await client.query(bundle); await readiness(client);
    assert.equal((await client.query("SELECT has_table_privilege('anon','public.products','SELECT') AS allowed")).rows[0].allowed, true);
    assert.equal((await client.query("SELECT has_table_privilege('anon','public.commerce_profiles','SELECT') AS allowed")).rows[0].allowed, false);
  });
  await check('missing inventory refuses installation without leaving tables', async () => {
    const client = await fresh(false);
    await assert.rejects(client.query(bundle), /INVENTORY_FOUNDATION_REQUIRED/);
    await client.query('ROLLBACK');
    assert.equal((await client.query("SELECT to_regclass('public.commerce_schema_migrations') AS relation")).rows[0].relation, null);
  });
  await check('damaged existing scoped reference is detected', async () => {
    const client = await fresh(); await client.query(bundle);
    await client.query('ALTER TABLE commercial_products DROP CONSTRAINT commercial_product_cover_fk');
    await assert.rejects(client.query(bundle), /COMMERCE_SCHEMA_NOT_READY/);
    await client.query('ROLLBACK');
  });
  await check('business enablement preserves prices, contacts, stock and revisions on replay', async () => {
    const before = await snapshot(admin);
    const contact = (await admin.query('SELECT sales_whatsapp FROM commerce_profiles WHERE owner_phone=$1', [fixture.owner])).rows[0].sales_whatsapp;
    const sql = buildBusinessEnableSql({ owner: fixture.owner, currency: 'ARS', confirmedMajorInteger: true });
    await admin.query('UPDATE commerce_profiles SET enabled=false WHERE owner_phone=$1', [fixture.owner]);
    await admin.query(sql);
    const profile = (await admin.query('SELECT * FROM commerce_profiles WHERE owner_phone=$1', [fixture.owner])).rows[0];
    assert.equal(profile.enabled, true); assert.equal(profile.sales_whatsapp, contact);
    await admin.query(sql);
    assert.deepEqual((await admin.query('SELECT * FROM commerce_profiles WHERE owner_phone=$1', [fixture.owner])).rows[0], profile);
    assert.deepEqual(await snapshot(admin), before);
  });
  await check('business enablement rejects unknown owners, conflicting currency and unconfirmed scale', async () => {
    const options = { owner: fixture.owner, currency: 'ARS', confirmedMajorInteger: true };
    assert.throws(() => buildBusinessEnableSql({ ...options, confirmedMajorInteger: false }), /PRICE_SCALE_CONFIRMATION_REQUIRED/);
    await assert.rejects(admin.query(buildBusinessEnableSql({ ...options, owner: '59899000887' })), /OWNER_NOT_FOUND/);
    await admin.query('ROLLBACK');
    await assert.rejects(admin.query(buildBusinessEnableSql({ ...options, currency: 'USD' })), /MONEY_POLICY_CONFLICT/);
    await admin.query('ROLLBACK');
    assert.equal((await admin.query('SELECT currency FROM inventory_money_policies WHERE owner_phone=$1', [fixture.owner])).rows[0].currency, 'ARS');
  });
  await check('confirmed XXX correction is scoped, audited, repeatable and preserves linked SKU identity', async () => {
    const skuId = fixture.products[0].skuIds[0];
    await admin.query("UPDATE products SET price_currency='XXX' WHERE owner_phone=$1 AND id=$2", [fixture.owner, skuId]);
    await admin.query(`INSERT INTO products(id,owner_phone,name,price,price_currency,stock_available,stock_reserved)
      SELECT 'currency-xxx-' || n, $1, 'Currency correction fixture ' || n, 65000, 'XXX', 4, 1 FROM generate_series(1,49) n`, [fixture.owner]);
    await admin.query("INSERT INTO products(id,owner_phone,name,price,price_currency) VALUES('currency-other','59899000886','Other business',65000,'XXX')");
    const before = await snapshot(admin);
    const oldSku = (await admin.query('SELECT * FROM products WHERE id=$1', [skuId])).rows[0];
    const runtime = { withClient: callback => callback(admin), transaction: callback => callback(admin) };
    const service = createCommerceProductService(runtime), context = { businessId: fixture.owner, actorId: fixture.owner, role: 'owner' };
    assert.ok((await service.detail(context, fixture.products[0].id)).readiness.blockers.includes('MONEY_UNCONFIRMED'));
    const sql = buildCurrencyCorrectionSql({ owner: fixture.owner, currency: 'ARS', expectedUnknownCount: 50, confirmedMajorInteger: true });
    await admin.query(sql);
    const after = await snapshot(admin);
    for (const oldRow of before) {
      const newRow = after.find(row => row.id === oldRow.id);
      if (oldRow.owner_phone === fixture.owner && oldRow.price_currency === 'XXX') {
        assert.deepEqual(newRow, { ...oldRow, price_currency: 'ARS', inventory_revision: oldRow.inventory_revision + 1 });
      } else assert.deepEqual(newRow, oldRow);
    }
    const newSku = (await admin.query('SELECT * FROM products WHERE id=$1', [skuId])).rows[0];
    assert.equal(inventoryProductFingerprint(inventoryRowToProduct(newSku)), inventoryProductFingerprint(inventoryRowToProduct(oldSku)));
    const detail = await service.detail(context, fixture.products[0].id);
    assert.equal(detail.readiness.canPrepare, true);
    assert.equal(detail.readiness.blockers.includes('SKU_IDENTITY_CHANGED'), false);
    const receipts = (await admin.query("SELECT * FROM commercial_operations WHERE operation_type='maintenance.currency_confirmed'")).rows;
    assert.equal(receipts.length, 1); assert.equal(receipts[0].result_json.result.changed, 50);
    await admin.query(sql);
    assert.deepEqual(await snapshot(admin), after);
    assert.deepEqual((await admin.query("SELECT * FROM commercial_operations WHERE operation_type='maintenance.currency_confirmed'")).rows, receipts);
  });
  await check('currency correction refuses changed counts and unconfirmed scale without updating rows', async () => {
    const options = { owner: fixture.owner, currency: 'ARS', expectedUnknownCount: 50, confirmedMajorInteger: true };
    const before = await snapshot(admin);
    await assert.rejects(admin.query(buildCurrencyCorrectionSql(options)), /UNKNOWN_CURRENCY_COUNT_CHANGED/);
    await admin.query('ROLLBACK');
    assert.deepEqual(await snapshot(admin), before);
    assert.throws(() => buildCurrencyCorrectionSql({ ...options, confirmedMajorInteger: false }), /CONFIRMED_MONEY_POLICY_REQUIRED/);
  });
  console.log(`${checks} SQL Editor checks passed; no production database used.`);
} finally {
  for (const client of clients.reverse()) await client.end().catch(() => {});
  await fixture.stop();
}
