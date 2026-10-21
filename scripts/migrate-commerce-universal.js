import { Client } from 'pg';
import { databaseTarget } from './fullmatch/databaseTarget.js';
import { migrateUniversalCommerce } from '../server/commerce/universalMigration.js';
let client;
try {
  client = new Client(databaseTarget(process.env, { allowRemote: process.argv.includes('--allow-remote-database') })); await client.connect();
  if (process.argv.includes('--apply')) console.log(JSON.stringify(await migrateUniversalCommerce(client)));
  else {
    await client.query('BEGIN READ ONLY');
    const ledger = (await client.query("SELECT to_regclass('public.commerce_schema_migrations') AS name")).rows[0].name;
    console.log(JSON.stringify({ ready: Boolean(ledger && (await client.query('SELECT 1 FROM commerce_schema_migrations WHERE version=5')).rowCount), version: 5 }));
    await client.query('ROLLBACK');
  }
} catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'UNIVERSAL_COMMERCE_MIGRATION_FAILED'); process.exitCode = 1; }
finally { if (client) await client.end().catch(() => {}); }
