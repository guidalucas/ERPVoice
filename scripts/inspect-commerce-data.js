import { Client } from 'pg';
import { databaseTarget } from './fullmatch/databaseTarget.js';

let client;
try {
  client = new Client(databaseTarget(process.env, { allowRemote: process.argv.includes('--allow-remote-database') }));
  await client.connect(); await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='8000ms'");
  const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='products'")).rows;
  const required = ['inventory_status', 'price_currency', 'stock_available', 'stock_reserved', 'price', 'owner_phone', 'attributes_json', 'family_id'];
  if (!required.every(name => columns.some(row => row.column_name === name))) throw new Error('INVENTORY_SCHEMA_INCOMPLETE');
  const rows = (await client.query(`SELECT count(*)::int AS total_skus,
    count(*) FILTER(WHERE inventory_status='active')::int AS active_skus,
    count(*) FILTER(WHERE price_currency='XXX')::int AS unspecified_currency,
    count(*) FILTER(WHERE price=0)::int AS zero_price,
    count(*) FILTER(WHERE price<0 OR stock_available<0 OR stock_reserved<0)::int AS negative_rows,
    count(*) FILTER(WHERE attributes_json<>'{}'::jsonb)::int AS typed_attributes,
    count(*) FILTER(WHERE family_id IS NOT NULL)::int AS assigned_family
    FROM products WHERE ($1::text IS NULL OR owner_phone=$1)`, [process.env.COMMERCE_INSPECT_OWNER ?? null])).rows;
  console.log(JSON.stringify({ readOnly: true, aggregates: rows }));
  await client.query('ROLLBACK');
} catch (error) { console.error(JSON.stringify({ code: error.code ?? (/^[A-Z_]+$/.test(error.message) ? error.message : 'DATA_INSPECTION_FAILED') })); process.exitCode = 1; }
finally { if (client) await client.end().catch(() => {}); }
