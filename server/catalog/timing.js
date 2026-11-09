import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const requests = new AsyncLocalStorage();
const record = (name, duration) => {
  const metrics = requests.getStore(); if (metrics) metrics[name] = (metrics[name] || 0) + duration;
};
export function measureCatalogPhase(name, callback) {
  if (!requests.getStore()) return callback();
  const start = performance.now();
  try {
    const value = callback();
    if (value && typeof value.then === 'function') return Promise.resolve(value).finally(() => record(name, performance.now() - start));
    record(name, performance.now() - start); return value;
  } catch (error) { record(name, performance.now() - start); throw error; }
}

// Aggregate durations only: never SQL, identifiers, URLs, inventory or credentials.
export function catalogTiming(_req, res, next) {
  const start = performance.now(), metrics = { queries: 0 };
  const end = res.end;
  res.end = function (...args) {
    if (!res.headersSent) {
      const entries = [`total;dur=${(performance.now() - start).toFixed(1)}`];
      for (const name of ['db', 'db_setup', 'db_finalize', 'storage', 'encode', 'render']) if (metrics[name] !== undefined)
        entries.push(`${name};dur=${metrics[name].toFixed(1)}${name === 'db' ? `;desc="${metrics.queries} queries"` : ''}`);
      res.setHeader('Server-Timing', entries.join(', '));
    }
    return end.apply(this, args);
  };
  return requests.run(metrics, next);
}

export function measuredCatalogRuntime(runtime) {
  const wrap = method => (callback, ...options) => {
    if (!requests.getStore()) return runtime[method](callback, ...options);
    const start = performance.now(); let callbackFinished;
    return runtime[method](async client => {
      // For transactions this includes pool acquisition AND BEGIN, not pure pool wait.
      record('db_setup', performance.now() - start);
      const measured = new Proxy(client, { get(target, key) {
        if (key === 'query') return (...args) => {
          requests.getStore().queries++;
          return measureCatalogPhase('db', () => target.query(...args));
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      try { return await callback(measured); } finally { callbackFinished = performance.now(); }
    }, ...options).finally(() => { if (callbackFinished !== undefined) record('db_finalize', performance.now() - callbackFinished); });
  };
  return { ...runtime, transaction: wrap('transaction'), withClient: wrap('withClient') };
}
