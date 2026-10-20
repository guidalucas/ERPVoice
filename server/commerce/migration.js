import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { commerceTables, inspectCommerceSchema } from './schemaInspection.js';

const protectedTables = ['products', 'clients', 'proveedores', 'pedidos', 'transactions', 'inventory_operations', 'inventory_movements'];
async function fingerprints(client) {
  const result = {};
  for (const table of protectedTables) {
    const exists = (await client.query('SELECT to_regclass($1) AS relation', [`public.${table}`])).rows[0].relation;
    if (!exists) continue;
    result[table] = (await client.query(`SELECT count(*)::text AS count,
      md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS hash FROM public.${table} t`)).rows[0];
  }
  return result;
}

/** Caller explicitly chooses the database; no env, bootstrap, money changes or fixture insertion. */
export async function migrateCommerce(client) {
  const sql = await fs.readFile(new URL('../migrations/commerce/001_foundation.sql', import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL search_path=public,pg_catalog; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stocky:commerce:migration'))");
    const before = await fingerprints(client);
    if (!before.products) throw Object.assign(new Error('Inventory foundation required.'), { code: 'INVENTORY_FOUNDATION_REQUIRED' });
    await client.query(`CREATE TABLE IF NOT EXISTS commerce_schema_migrations(version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const previous = (await client.query('SELECT checksum FROM commerce_schema_migrations WHERE version=1')).rows[0];
    if (previous && previous.checksum !== checksum) throw Object.assign(new Error('Migration checksum differs.'), { code: 'MIGRATION_CHECKSUM_MISMATCH' });
    if (!previous) {
      await client.query(sql);
      await client.query('INSERT INTO commerce_schema_migrations(version,checksum) VALUES(1,$1)', [checksum]);
    }
    const roles = (await client.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])", [['anon', 'authenticated']])).rows;
    for (const table of [...commerceTables, 'commerce_schema_migrations']) {
      await client.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY; REVOKE ALL ON TABLE public.${table} FROM PUBLIC`);
      for (const { rolname } of roles) await client.query(`REVOKE ALL ON TABLE public.${table} FROM ${rolname}`);
    }
    const after = await inspectCommerceSchema(client);
    if (!after.ready) throw Object.assign(new Error('Commercial schema incomplete.'), { code: 'COMMERCE_SCHEMA_NOT_READY' });
    if (JSON.stringify(before) !== JSON.stringify(await fingerprints(client))) throw Object.assign(new Error('Inventory data changed.'), { code: 'MIGRATION_DATA_MISMATCH' });
    await client.query('COMMIT'); return { changed: !previous, ready: true, inventoryUnchanged: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
