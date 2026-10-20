import { Client } from 'pg';
import { databaseTarget } from './fullmatch/databaseTarget.js';
import { inspectCommerceSchema } from '../server/commerce/schemaInspection.js';
import { migrateCommerce } from '../server/commerce/migration.js';

let client;
try {
  const apply = process.argv.includes('--apply');
  client = new Client(databaseTarget(process.env, { allowRemote: process.argv.includes('--allow-remote-database') }));
  await client.connect();
  if (apply) console.log(JSON.stringify(await migrateCommerce(client)));
  else {
    await client.query('BEGIN READ ONLY');
    console.log(JSON.stringify(await inspectCommerceSchema(client)));
    await client.query('ROLLBACK');
  }
} catch (error) { console.error(JSON.stringify({ code: error.code ?? 'COMMERCE_MIGRATION_FAILED' })); process.exitCode = 1; }
finally { if (client) await client.end().catch(() => {}); }
