export const commerceTables = ['inventory_money_policies', 'commerce_profiles', 'commercial_products',
  'commercial_product_skus', 'commercial_product_images', 'commercial_operations'];

export async function inspectCommerceSchema(client) {
  const tables = (await client.query(`SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[])`, [commerceTables])).rows;
  const missing = commerceTables.filter(table => !tables.some(row => row.relname === table));
  const roleGrants = (await client.query(`SELECT DISTINCT r.rolname,c.relname FROM pg_roles r CROSS JOIN pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])
    AND r.rolname=ANY($2::text[]) AND (has_table_privilege(r.oid,c.oid,'SELECT') OR has_table_privilege(r.oid,c.oid,'INSERT')
    OR has_table_privilege(r.oid,c.oid,'UPDATE') OR has_table_privilege(r.oid,c.oid,'DELETE')
    OR has_table_privilege(r.oid,c.oid,'TRUNCATE') OR has_table_privilege(r.oid,c.oid,'REFERENCES')
    OR has_table_privilege(r.oid,c.oid,'TRIGGER'))`,
  [commerceTables, ['anon', 'authenticated']])).rows;
  const rlsEnabled = !missing.length && tables.every(row => row.relrowsecurity);
  const versionTable = (await client.query("SELECT to_regclass('public.commerce_schema_migrations') AS table_name")).rows[0].table_name;
  const versions = versionTable ? (await client.query('SELECT version,checksum FROM commerce_schema_migrations ORDER BY version')).rows : [];
  const constraints = (await client.query(`SELECT rel.relname AS table_name,pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class rel ON rel.oid=c.conrelid JOIN pg_namespace n ON n.oid=rel.relnamespace
    WHERE n.nspname='public' AND rel.relname=ANY($1::text[]) AND c.contype='f'`, [commerceTables])).rows;
  const expectedReferences = [
    ['commercial_products', 'FOREIGN KEY (owner_phone) REFERENCES commerce_profiles(owner_phone)'],
    ['commercial_products', 'FOREIGN KEY (owner_phone, id, cover_image_id) REFERENCES commercial_product_images(owner_phone, commercial_product_id, id)'],
    ['commercial_product_skus', 'FOREIGN KEY (owner_phone, commercial_product_id) REFERENCES commercial_products(owner_phone, id)'],
    ['commercial_product_skus', 'FOREIGN KEY (owner_phone, sku_id) REFERENCES products(owner_phone, id)'],
    ['commercial_product_images', 'FOREIGN KEY (owner_phone, commercial_product_id) REFERENCES commercial_products(owner_phone, id)'],
    ['commercial_operations', 'FOREIGN KEY (owner_phone) REFERENCES commerce_profiles(owner_phone)'],
  ];
  const normalized = value => value.replace(/\s|"/g, '').replaceAll('public.', '');
  const missingReferences = expectedReferences.filter(([table, definition]) => !constraints.some(row => row.table_name === table
    && normalized(row.definition).startsWith(normalized(definition)))).map(([table, definition]) => ({ table, definition }));
  return { ready: !missing.length && !missingReferences.length && rlsEnabled && !roleGrants.length && versions.some(row => row.version === 1),
    missing, missingReferences, rlsEnabled, apiRolesRevoked: !roleGrants.length, versions };
}
