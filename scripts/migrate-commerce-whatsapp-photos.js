import { Client } from 'pg';
import { databaseTarget } from './fullmatch/databaseTarget.js';
import { inspectWhatsAppPhotoSchema, migrateWhatsAppPhotos } from '../server/commerce/whatsappPhotoMigration.js';

let client;
try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--check', '--allow-remote-database'].includes(arg)) || (args.includes('--apply') && args.includes('--check'))) {
    throw new Error('INVALID_MIGRATION_ARGUMENTS');
  }
  client = new Client(databaseTarget(process.env, { allowRemote: args.includes('--allow-remote-database') }));
  await client.connect();
  const result = await (args.includes('--apply') ? migrateWhatsAppPhotos(client) : inspectWhatsAppPhotoSchema(client));
  console.log(JSON.stringify(result));
  if (!result.ready) process.exitCode = 2;
} catch (error) {
  console.error(error.code ?? 'WHATSAPP_PHOTOS_MIGRATION_FAILED');
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
