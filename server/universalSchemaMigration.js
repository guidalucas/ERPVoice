import {UNIVERSAL_CONVERSATION_SCHEMA_SQL} from './universalConversationPostgres.js';
import {UNIVERSAL_META_SCHEMA_SQL} from './universalMetaPostgres.js';

const tables=['universal_drafts','universal_draft_commands','universal_meta_commands'];
const apiRoles=['anon','authenticated'];
const businessTables=['products','clients','proveedores','pedidos','transactions',
  'inventory_operations','inventory_movements','account_operations','account_movements',
  'party_operations','order_operations','universal_operations'];
const fail=code=>{throw Object.assign(new Error(code),{code});};

/** Catalog inspection only: no bootstrap, tenant normalization or domain writes. */
export async function inspectUniversalSchema(client) {
  const rows=(await client.query(`SELECT relname,relrowsecurity FROM pg_class
    WHERE oid IN (SELECT to_regclass('public.'||name) FROM unnest($1::text[]) name)`,[tables])).rows;
  const missingTables=tables.filter(name=>!rows.some(row=>row.relname===name));
  const constraint=(await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid=to_regclass('public.universal_drafts') AND conname='universal_drafts_status_check'`)).rows;
  const answeredSupported=constraint.some(row=>row.definition.includes("'answered'"));
  const grants=(await client.query(`SELECT DISTINCT r.rolname FROM pg_roles r CROSS JOIN pg_class c
    WHERE r.rolname=ANY($1::text[]) AND c.oid IN
      (SELECT to_regclass('public.'||name) FROM unnest($2::text[]) name)
    AND (has_table_privilege(r.oid,c.oid,'SELECT') OR has_table_privilege(r.oid,c.oid,'INSERT')
      OR has_table_privilege(r.oid,c.oid,'UPDATE') OR has_table_privilege(r.oid,c.oid,'DELETE')
      OR has_table_privilege(r.oid,c.oid,'TRUNCATE') OR has_table_privilege(r.oid,c.oid,'REFERENCES')
      OR has_table_privilege(r.oid,c.oid,'TRIGGER'))`,[apiRoles,tables])).rows;
  const rlsEnabled=!missingTables.length && rows.every(row=>row.relrowsecurity);
  const apiRolesRevoked=grants.length===0;
  return {missingTables,answeredSupported,rlsEnabled,apiRolesRevoked,
    ready:!missingTables.length && answeredSupported && rlsEnabled && apiRolesRevoked};
}

async function businessFingerprint(client,protectedTables) {
  const result={};
  for(const table of protectedTables) {
    const exists=(await client.query('SELECT to_regclass($1) AS relation',[`public.${table}`])).rows[0].relation;
    if(!exists) fail('UNIVERSAL_FOUNDATION_REQUIRED');
    // These fixed table names never come from configuration or request input.
    result[table]=(await client.query(`SELECT COUNT(*)::text AS count,
      md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS digest
      FROM public.${table} t`)).rows[0];
  }
  return result;
}

/** Narrow additive upgrade, atomic with RLS and API grants. Data hashes stay local
 * to the transaction and are never printed or written to an evaluation report. */
export async function migrateUniversalSchema(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await client.query("SET LOCAL search_path=public,pg_catalog; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stocky:universal-conversation-schema'))");
    const before=await inspectUniversalSchema(client);
    const protectedTables=[...businessTables,...tables.filter(table=>!before.missingTables.includes(table))];
    const data=await businessFingerprint(client,protectedTables);
    await client.query(UNIVERSAL_CONVERSATION_SCHEMA_SQL);
    await client.query(UNIVERSAL_META_SCHEMA_SQL);
    for(const table of tables) await client.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY; REVOKE ALL ON TABLE public.${table} FROM PUBLIC`);
    const roles=(await client.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[apiRoles])).rows;
    for(const {rolname} of roles) for(const table of tables)
      await client.query(`REVOKE ALL ON TABLE public.${table} FROM ${rolname}`);
    const after=await inspectUniversalSchema(client);
    if(!after.ready) fail('UNIVERSAL_SCHEMA_INCOMPLETE');
    if(JSON.stringify(await businessFingerprint(client,protectedTables))!==JSON.stringify(data)) fail('MIGRATION_DATA_MISMATCH');
    await client.query('COMMIT');
    return {before,after,changed:!before.ready,dataUnchanged:true};
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
