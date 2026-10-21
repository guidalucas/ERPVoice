import { createDatabaseRuntime } from '../server/dbRuntime.js';
import { databaseTarget } from './fullmatch/databaseTarget.js';
import { createMediaStorage } from '../server/commerce/mediaStorage.js';
import { maintainCommercialMedia } from '../server/commerce/mediaMaintenance.js';
const args = process.argv.slice(2), ownerIndex = args.indexOf('--owner');
let runtime;
try {
  runtime = createDatabaseRuntime(databaseTarget(process.env, { allowRemote: args.includes('--allow-remote-database') }));
  const report = await maintainCommercialMedia(runtime, createMediaStorage(), { businessId: ownerIndex >= 0 ? args[ownerIndex + 1] : null,
    apply: args.includes('--apply'), purge: args.includes('--purge') });
  console.log(JSON.stringify(report));
} catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'MEDIA_MAINTENANCE_FAILED'); process.exitCode = 1; }
finally { if (runtime) await runtime.close(); }
