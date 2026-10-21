import { Client } from 'pg';
import { databaseTarget } from './fullmatch/databaseTarget.js';
import { migrateCatalog, inspectCatalogSchema } from '../server/commerce/catalogMigration.js';
let client;
try {
  client = new Client(databaseTarget(process.env, { allowRemote: process.argv.includes('--allow-remote-database') }));
  await client.connect();
  if (process.argv.includes('--apply')) console.log(JSON.stringify(await migrateCatalog(client)));
  else { await client.query('BEGIN READ ONLY'); console.log(JSON.stringify(await inspectCatalogSchema(client))); await client.query('ROLLBACK'); }
} catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'CATALOG_MIGRATION_FAILED'); process.exitCode = 1; }
finally { if (client) await client.end().catch(() => {}); }
