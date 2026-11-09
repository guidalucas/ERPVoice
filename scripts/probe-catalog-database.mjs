// Explicitly read-only diagnostic; never imports the schema/bootstrap application.
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { readPublicProducts } from '../server/commerce/publicProductRepository.js';

const envFile = process.argv.find(value => value.startsWith('--env-file='))?.slice('--env-file='.length);
if (!envFile) throw new Error('An explicit local env file is required.');
const env = dotenv.parse(await fs.readFile(path.resolve(envFile)));
const connection = env.COMMERCE_DATABASE_URL || env.SUPABASE_DATABASE_URL || env.DATABASE_URL;
if (!connection) throw new Error('No database configured in the selected file.');
const client = new Client({ connectionString: connection, ssl: true, connectionTimeoutMillis: 8000, application_name: 'stocky-catalog-read-only-audit' });
const result = { measuredAt: new Date().toISOString(), vantagePoint: 'Developer workstation, not the Render service', readOnly: true, roundTripsMs: [], plans: [] };
let owner;
try {
  let start = performance.now(); await client.connect(); result.connectMs = performance.now() - start;
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='5s'"); await client.query("SET LOCAL lock_timeout='1s'");
  result.transactionReadOnly = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
  // Verify the intended public catalog without writing or persisting owner identifiers.
  const row = (await client.query(`SELECT c.owner_phone FROM commerce_catalogs c JOIN commerce_profiles p ON p.owner_phone=c.owner_phone
    WHERE c.slug=$1 AND c.public_enabled AND p.enabled`, ['fullmatch-casacas'])).rows[0];
  if (!row) throw Object.assign(new Error('EXPECTED_PUBLIC_CATALOG_NOT_FOUND'), { code: 'EXPECTED_PUBLIC_CATALOG_NOT_FOUND' });
  owner = row.owner_phone;
  for (let index = 0; index < 5; index++) { start = performance.now(); await client.query('SELECT 1'); result.roundTripsMs.push(performance.now() - start); }
  result.connections = (await client.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE state='active')::int AS active,
    count(*) FILTER(WHERE wait_event_type='Lock')::int AS waiting_on_lock FROM pg_stat_activity WHERE datname=current_database()`)).rows[0];
  result.maxConnections = (await client.query('SHOW max_connections')).rows[0].max_connections;
  const listSql = `SELECT p.* FROM commercial_products p JOIN commercial_publications s ON s.owner_phone=p.owner_phone AND s.commercial_product_id=p.id
    WHERE p.owner_phone=$1 AND p.status='ready' AND s.status='published' ORDER BY p.slug LIMIT 25`;
  const explain = async (label, text, values) => {
    start = performance.now(); const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, values)).rows[0]['QUERY PLAN'];
    result.plans.push({ label, clientMs: performance.now() - start, plan });
  };
  await explain('published-page', listSql, [owner]);
  const products = (await client.query(listSql, [owner])).rows.slice(0, 24);
  const capture = { query: async (text, values) => { await explain('sku-image-policy-batch', text, values); return client.query(text, values); } };
  await readPublicProducts(capture, owner, products);
  await explain('facets', `SELECT DISTINCT p.team_key,p.team_name,p.version_key,i.product_type,COALESCE(NULLIF(trim(i.size),''),trim(i.name)) AS variant
    FROM commercial_products p JOIN commercial_publications s ON s.owner_phone=p.owner_phone AND s.commercial_product_id=p.id
    JOIN commercial_product_skus l ON l.owner_phone=p.owner_phone AND l.commercial_product_id=p.id
    JOIN products i ON i.owner_phone=l.owner_phone AND i.id=l.sku_id
    WHERE p.owner_phone=$1 AND p.status='ready' AND s.status='published' AND i.inventory_status='active'`, [owner]);
  await client.query('ROLLBACK');
} catch (error) {
  // Error messages can contain connection details. Persist a stable code only.
  result.errorCode = error.code || 'DATABASE_DIAGNOSTIC_FAILED';
  await client.query('ROLLBACK').catch(() => {});
} finally { await client.end().catch(() => {}); }
const safe = JSON.stringify(result, null, 2).replaceAll(owner || '\u0000', '[tenant]');
await fs.writeFile('docs/catalog-performance/production-database.json', safe + '\n');
console.log(JSON.stringify({ readOnly: result.transactionReadOnly, errorCode: result.errorCode, connectMs: result.connectMs,
  roundTripsMs: result.roundTripsMs, connections: result.connections, plans: result.plans.map(p => ({ label: p.label, clientMs: p.clientMs, planningMs: p.plan[0]['Planning Time'], executionMs: p.plan[0]['Execution Time'] })) }));
if (result.errorCode) process.exitCode = 1;
