import { readCommerceMigration } from './migrationSource.js';
import { inspectCommerceSchema } from './schemaInspection.js';
export async function migrateUniversalCommerce(client) {
  const { sql, checksum, acceptedChecksums } = await readCommerceMigration(5);
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL search_path=public,pg_catalog; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stocky:commerce:migration'))");
    if (!(await inspectCommerceSchema(client)).ready) throw new Error('COMMERCE_FOUNDATION_REQUIRED');
    const previous = (await client.query('SELECT checksum FROM commerce_schema_migrations WHERE version=5')).rows[0];
    if (previous && !acceptedChecksums.includes(previous.checksum)) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
    if (!previous) { await client.query(sql); await client.query('INSERT INTO commerce_schema_migrations(version,checksum) VALUES(5,$1)', [checksum]); }
    await client.query('COMMIT'); return { ready: true, changed: !previous, version: 5 };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
