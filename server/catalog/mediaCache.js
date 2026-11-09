// Only immutable image bytes go here, never publication permissions, stock or prices.
// Both memory and outstanding work are bounded; failures are not cached.
export function createMediaCache({ maxBytes = 32 * 1024 * 1024, maxEntries = 128, ttlMs = 300_000, maxPending = 64, maxConcurrent = 4 } = {}) {
  const entries = new Map(), pending = new Map(), waiting = []; let size = 0, running = 0;
  const acquire = () => {
    if (running < maxConcurrent) { running++; return Promise.resolve(); }
    return new Promise(resolve => waiting.push(resolve));
  };
  const release = () => { if (waiting.length) waiting.shift()(); else running--; };
  const remove = key => { const entry = entries.get(key); if (entry) { size -= entry.bytes.length; entries.delete(key); } };
  return async function read(key, loader) {
    const hit = entries.get(key);
    if (hit && hit.expires > Date.now()) { entries.delete(key); entries.set(key, hit); return hit.bytes; }
    remove(key);
    if (pending.has(key)) return pending.get(key);
    // Bound outstanding storage/encoding work as well as retained bytes.
    if (pending.size >= maxPending) throw Object.assign(new Error('MEDIA_CACHE_BUSY'), { code: 'MEDIA_CACHE_BUSY' });
    const work = acquire().then(async () => { try { return await loader(); } finally { release(); } }).then(bytes => {
      if (bytes.length <= maxBytes) {
        while (entries.size && (size + bytes.length > maxBytes || entries.size >= maxEntries)) remove(entries.keys().next().value);
        entries.set(key, { bytes, expires: Date.now() + ttlMs }); size += bytes.length;
      }
      return bytes;
    }).finally(() => pending.delete(key));
    pending.set(key, work); return work;
  };
}
