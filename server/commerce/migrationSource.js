import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const files = { 1: '001_foundation.sql', 2: '002_catalog.sql', 3: '003_content_library.sql' };
export async function readCommerceMigration(version) {
  if (!Object.hasOwn(files, version)) throw new Error('UNKNOWN_COMMERCE_MIGRATION');
  const sql = (await fs.readFile(new URL(`../migrations/commerce/${files[version]}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const hash = value => createHash('sha256').update(value).digest('hex');
  // Older Windows runs recorded CRLF bytes. Accept that equivalent source without
  // rewriting its ledger; new migrations always record the portable LF checksum.
  return { version, sql, checksum: hash(sql), acceptedChecksums: [...new Set([hash(sql), hash(sql.replace(/\n/g, '\r\n'))])] };
}
