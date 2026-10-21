import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspectCatalogSchema } from './catalogMigration.js';
export async function inspectContentSchema(client) {
  const table = (await client.query("SELECT to_regclass('public.commerce_schema_migrations') AS name")).rows[0].name;
  const version = table && (await client.query('SELECT 1 FROM commerce_schema_migrations WHERE version=3')).rowCount > 0;
  const index = (await client.query(`SELECT i.indisvalid,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i
    WHERE i.indexrelid=to_regclass('public.idx_commercial_operations_library')`)).rows[0];
  return { ready: Boolean(version && index?.indisvalid && /\(owner_phone, operation_type, created_at DESC, operation_id DESC\)/.test(index.definition)) };
}
export async function migrateContent(client) {
  const sql = await fs.readFile(new URL('../migrations/commerce/003_content_library.sql', import.meta.url), 'utf8'), checksum = createHash('sha256').update(sql).digest('hex');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL search_path=public,pg_catalog; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stocky:commerce:migration'))");
    if (!(await inspectCatalogSchema(client)).ready) throw new Error('CATALOG_FOUNDATION_REQUIRED');
    const previous = (await client.query('SELECT checksum FROM commerce_schema_migrations WHERE version=3')).rows[0];
    if (previous && previous.checksum !== checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
    if (!previous) { await client.query(sql); await client.query('INSERT INTO commerce_schema_migrations(version,checksum) VALUES(3,$1)', [checksum]); }
    if (!(await inspectContentSchema(client)).ready) throw new Error('CONTENT_SCHEMA_NOT_READY');
    await client.query('COMMIT'); return { ready: true, changed: !previous, version: 3 };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
