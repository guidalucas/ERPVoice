import { migrateDatabase, closeDatabase } from '../server/postgresDatabase.js';

try {
  await migrateDatabase();
  console.log('Migration completed successfully.');
} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
