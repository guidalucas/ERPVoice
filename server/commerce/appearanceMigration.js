import { readCommerceMigration } from './migrationSource.js';
import { inspectCommerceSchema } from './schemaInspection.js';
export async function inspectAppearanceSchema(client) {
  const ledger = (await client.query("SELECT to_regclass('public.commerce_schema_migrations') AS name")).rows[0].name;
  if (!ledger) return { ready: false };
  const version = (await client.query('SELECT 1 FROM commerce_schema_migrations WHERE version=4')).rowCount > 0;
  const column = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='commerce_profiles' AND column_name='appearance' AND data_type='jsonb'")).rowCount > 0;
  const asset = (await client.query("SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.commerce_brand_assets')")).rows[0];
  const grants = asset ? (await client.query(`SELECT 1 FROM pg_roles r WHERE r.rolname IN ('anon','authenticated')
    AND (has_table_privilege(r.oid,'public.commerce_brand_assets','SELECT') OR has_table_privilege(r.oid,'public.commerce_brand_assets','INSERT')
      OR has_table_privilege(r.oid,'public.commerce_brand_assets','UPDATE') OR has_table_privilege(r.oid,'public.commerce_brand_assets','DELETE'))`)).rowCount : 0;
  return { ready: Boolean(version && column && asset?.relrowsecurity && !grants) };
}
export async function migrateAppearance(client) {
  const { sql, checksum, acceptedChecksums } = await readCommerceMigration(4);
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL search_path=public,pg_catalog; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stocky:commerce:migration'))");
    if (!(await inspectCommerceSchema(client)).ready) throw new Error('COMMERCE_FOUNDATION_REQUIRED');
    const previous = (await client.query('SELECT checksum FROM commerce_schema_migrations WHERE version=4')).rows[0];
    if (previous && !acceptedChecksums.includes(previous.checksum)) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
    if (!previous) { await client.query(sql); await client.query('INSERT INTO commerce_schema_migrations(version,checksum) VALUES(4,$1)', [checksum]); }
    if (!(await inspectAppearanceSchema(client)).ready) throw new Error('APPEARANCE_SCHEMA_NOT_READY');
    await client.query('COMMIT'); return { ready: true, changed: !previous, version: 4 };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
