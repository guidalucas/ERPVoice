import { Client } from 'pg';
import { databaseTarget } from './fullmatch/databaseTarget.js';
import { readCommerceMigration } from '../server/commerce/migrationSource.js';

let client;
try {
  const apply = process.argv.includes('--apply');
  const { version, sql, checksum, acceptedChecksums } = await readCommerceMigration(6);
  client = new Client(databaseTarget(process.env, { allowRemote: process.argv.includes('--allow-remote-database') }));
  await client.connect();
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  await client.query("SET LOCAL search_path=public,pg_catalog; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
  if (apply) await client.query("SELECT pg_advisory_xact_lock(hashtext('stocky:commerce:migration'))");
  const ledger = (await client.query("SELECT to_regclass('public.commerce_schema_migrations') AS name")).rows[0].name;
  if (apply && (!ledger || !(await client.query('SELECT 1 FROM commerce_schema_migrations WHERE version=5')).rowCount)) {
    throw new Error('COMMERCE_UNIVERSAL_REQUIRED');
  }
  const previous = ledger && (await client.query('SELECT checksum FROM commerce_schema_migrations WHERE version=$1', [version])).rows[0];
  if (previous && !acceptedChecksums.includes(previous.checksum)) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
  if (apply && !previous) {
    await client.query(sql);
    await client.query('INSERT INTO commerce_schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({ ready: Boolean(previous || apply), changed: apply && !previous, version }));
} catch (error) {
  console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'AUTO_STORY_MIGRATION_FAILED');
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
