import fs from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.js';

const validateKey = key => {
  if (typeof key !== 'string' || !/^[a-f0-9]{32}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/(master|thumbnail)\.jpg$/.test(key)) throw new Error('INVALID_INTERNAL_MEDIA_KEY');
  return key;
};
const validatePrefix = prefix => { if (!/^[a-f0-9]{32}$/.test(prefix)) throw new Error('INVALID_INTERNAL_MEDIA_PREFIX'); return prefix; };

/** No credentials or object keys enter browser DTOs. No bucket is created implicitly. */
export function createMediaStorage(env = process.env) {
  if (env.COMMERCE_MEDIA_ADAPTER === 'local' && env.NODE_ENV !== 'production' && env.COMMERCE_MEDIA_DIRECTORY) {
    const root = path.resolve(env.COMMERCE_MEDIA_DIRECTORY);
    const target = key => path.join(root, ...validateKey(key).split('/'));
    return {
      configured: true, kind: 'local',
      async put(key, bytes) { const file = target(key); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); },
      get: key => fs.readFile(target(key)),
      remove: key => fs.rm(target(key), { force: true }),
      async list(prefix) {
        validatePrefix(prefix); const result = [];
        const visit = async (relative, depth) => {
          let entries; try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
          for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const key = `${relative.replaceAll(path.sep, '/')}/${entry.name}`;
            if (entry.isDirectory() && depth < 2 && /^[a-f0-9-]{36}$/.test(entry.name)) await visit(key, depth + 1);
            else if (entry.isFile() && depth === 2 && ['master.jpg', 'thumbnail.jpg'].includes(entry.name)) {
              validateKey(key); const stat = await fs.stat(target(key)); result.push({ key, createdAt: stat.mtime.toISOString() });
              if (result.length > 10_000) throw new Error('MEDIA_SCAN_LIMIT_REACHED');
            }
          }
        };
        await visit(prefix, 0); return result;
      },
    };
  }
  if (env.COMMERCE_MEDIA_ADAPTER === 'supabase' && env.COMMERCE_STORAGE_URL && env.COMMERCE_STORAGE_SERVICE_KEY && env.COMMERCE_STORAGE_BUCKET) {
    const origin = new URL(env.COMMERCE_STORAGE_URL);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('INVALID_STORAGE_ORIGIN');
    const bucket = env.COMMERCE_STORAGE_BUCKET;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(bucket)) throw new Error('INVALID_STORAGE_BUCKET');
    const headers = { Authorization: `Bearer ${env.COMMERCE_STORAGE_SERVICE_KEY}`, apikey: env.COMMERCE_STORAGE_SERVICE_KEY };
    const call = async (route, options = {}) => {
      const response = await fetch(new URL(`/storage/v1/${route}`, origin), { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
      if (!response.ok) throw new Error('PRIVATE_STORAGE_UNAVAILABLE');
      return response;
    };
    let checked;
    const ensurePrivate = async () => {
      checked ??= call(`bucket/${bucket}`).then(response => response.json()).then(data => {
        if (data.public !== false) throw new Error('STORAGE_BUCKET_MUST_BE_PRIVATE');
      }).catch(error => { checked = undefined; throw error; });
      await checked;
    };
    return { configured: true, kind: 'supabase',
      async put(key, bytes) { await ensurePrivate(); await call(`object/${bucket}/${validateKey(key)}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }, body: bytes }); },
      async get(key) { await ensurePrivate(); const response = await call(`object/authenticated/${bucket}/${validateKey(key)}`); const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 16 * 1024 * 1024) throw new Error('STORED_IMAGE_TOO_LARGE'); return bytes; },
      async remove(key) { await ensurePrivate(); await call(`object/${bucket}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [validateKey(key)] }) }); },
      async list(prefix) {
        validatePrefix(prefix); await ensurePrivate(); const result = []; let visited = 0;
        const visit = async (folder, depth) => {
          for (let offset = 0; ; offset += 100) {
            const page = await (await call(`object/list/${bucket}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prefix: folder, limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }) })).json();
            if (!Array.isArray(page)) throw new Error('INVALID_STORAGE_LIST');
            for (const entry of page) {
              if (++visited > 10_000) throw new Error('MEDIA_SCAN_LIMIT_REACHED');
              if (typeof entry.name !== 'string' || entry.name.includes('/') || entry.name.includes('\\')) continue;
              const key = `${folder}/${entry.name}`;
              if (!entry.id && depth < 2 && /^[a-f0-9-]{36}$/.test(entry.name)) await visit(key, depth + 1);
              else if (entry.id && depth === 2 && ['master.jpg', 'thumbnail.jpg'].includes(entry.name)) {
                validateKey(key); if (!Number.isFinite(Date.parse(entry.created_at))) throw new Error('STORAGE_OBJECT_DATE_MISSING');
                result.push({ key, createdAt: entry.created_at });
              }
            }
            if (page.length < 100) break;
          }
        };
        await visit(prefix, 0); return result;
      },
    };
  }
  return { configured: false, kind: 'unconfigured', put: async () => fail('MEDIA_NOT_CONFIGURED', 'Falta configurar el almacenamiento privado de fotografías.', 503) };
}
