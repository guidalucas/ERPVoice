import { Client } from 'pg';
import { databaseTarget } from './fullmatch/databaseTarget.js';
import { readCommerceMigration } from '../server/commerce/migrationSource.js';

let client;
let stage = 'CONFIG';
try {
  const apply = process.argv.includes('--apply');
  client = new Client(databaseTarget(process.env, { allowRemote: process.argv.includes('--allow-remote-database') }));
  stage = 'CONNECT';
  await client.connect();
  stage = 'BEGIN';
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  await client.query("SET LOCAL search_path=public,pg_catalog; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
  stage = 'LOCK';
  if (apply) await client.query("SELECT pg_advisory_xact_lock(hashtext('stocky:commerce:migration'))");
  stage = 'LEDGER';
  const ledger = (await client.query("SELECT to_regclass('public.commerce_schema_migrations') AS name")).rows[0].name;
  if (apply && (!ledger || !(await client.query('SELECT 1 FROM commerce_schema_migrations WHERE version=5')).rowCount)) {
    throw new Error('COMMERCE_UNIVERSAL_REQUIRED');
  }
  let ready = true, changed = false;
  for (const version of [6, 7, 8, 10]) {
    stage = `READ_${version}`;
    const { sql, checksum, acceptedChecksums } = await readCommerceMigration(version);
    stage = `CHECK_${version}`;
    const previous = ledger && (await client.query('SELECT checksum FROM commerce_schema_migrations WHERE version=$1', [version])).rows[0];
    if (previous && !acceptedChecksums.includes(previous.checksum)) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
    if (!previous && apply) {
      stage = `APPLY_${version}`;
      await client.query(sql);
      stage = `REGISTER_${version}`;
      await client.query('INSERT INTO commerce_schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
      changed = true;
    }
    if (!previous && !apply) ready = false;
  }
  stage = 'COMMIT';
  await client.query('COMMIT');
  console.log(JSON.stringify({ ready, changed, version: 10 }));
} catch (error) {
  const code = [error.code, error.message].find(value => typeof value === 'string' && /^[A-Z0-9_]{2,64}$/.test(value));
  console.error(JSON.stringify({ error: 'AUTO_STORY_MIGRATION_FAILED', stage, code: code ?? 'UNKNOWN' }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
