import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspectCommerceSchema } from './schemaInspection.js';
const tables = ['commerce_catalogs', 'commercial_publications'];
export async function inspectCatalogSchema(client) {
  const rows = (await client.query(`SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [tables])).rows;
  const ledger = (await client.query("SELECT to_regclass('public.commerce_schema_migrations') AS name")).rows[0].name;
  const version = ledger && (await client.query('SELECT 1 FROM commerce_schema_migrations WHERE version=2')).rowCount > 0;
  const grants = (await client.query(`SELECT r.rolname,c.relname FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND r.rolname=ANY($2::text[])
    AND (has_table_privilege(r.oid,c.oid,'SELECT') OR has_table_privilege(r.oid,c.oid,'INSERT') OR has_table_privilege(r.oid,c.oid,'UPDATE')
      OR has_table_privilege(r.oid,c.oid,'DELETE') OR has_table_privilege(r.oid,c.oid,'TRUNCATE') OR has_table_privilege(r.oid,c.oid,'REFERENCES') OR has_table_privilege(r.oid,c.oid,'TRIGGER'))`, [tables, ['anon', 'authenticated']])).rows;
  const references = (await client.query(`SELECT c.relname,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k
    JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND k.contype='f'`, [tables])).rows;
  const normalize = value => value.replace(/[\s"]/g, '').replaceAll('public.', '');
  const scoped = references.some(row => row.relname === 'commercial_publications' && normalize(row.definition) === normalize('FOREIGN KEY (owner_phone, commercial_product_id) REFERENCES commercial_products(owner_phone, id)'))
    && references.some(row => row.relname === 'commerce_catalogs' && normalize(row.definition) === normalize('FOREIGN KEY (owner_phone) REFERENCES commerce_profiles(owner_phone)'));
  return { ready: Boolean(version && scoped && rows.length === 2 && rows.every(row => row.relrowsecurity) && !grants.length),
    missing: tables.filter(table => !rows.some(row => row.relname === table)), apiRolesRevoked: !grants.length, scopedReferences: scoped };
}
export async function migrateCatalog(client) {
  const sql = await fs.readFile(new URL('../migrations/commerce/002_catalog.sql', import.meta.url), 'utf8'), checksum = createHash('sha256').update(sql).digest('hex');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL search_path=public,pg_catalog; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stocky:commerce:migration'))");
    if (!(await inspectCommerceSchema(client)).ready) throw new Error('COMMERCE_FOUNDATION_REQUIRED');
    const previous = (await client.query('SELECT checksum FROM commerce_schema_migrations WHERE version=2')).rows[0];
    if (previous && previous.checksum !== checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
    if (!previous) { await client.query(sql); await client.query('INSERT INTO commerce_schema_migrations(version,checksum) VALUES(2,$1)', [checksum]); }
    const roles = (await client.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])", [['anon', 'authenticated']])).rows;
    for (const table of tables) {
      await client.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY; REVOKE ALL ON TABLE public.${table} FROM PUBLIC`);
      for (const { rolname } of roles) await client.query(`REVOKE ALL ON TABLE public.${table} FROM ${rolname}`);
    }
    if (!(await inspectCatalogSchema(client)).ready) throw new Error('CATALOG_SCHEMA_NOT_READY');
    await client.query('COMMIT'); return { ready: true, changed: !previous, version: 2 };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
