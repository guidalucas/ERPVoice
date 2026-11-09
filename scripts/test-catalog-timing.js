import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogTiming, measuredCatalogRuntime, measureCatalogPhase } from '../server/catalog/timing.js';

function response() {
  const headers = {};
  return { headers, headersSent: false, setHeader: (name, value) => { headers[name] = value; }, end: value => value };
}
const client = { query: async value => value };
const runtime = { transaction: async (callback, options) => { assert.deepEqual(options, { readOnly: true }); return callback(client); }, withClient: async callback => callback(client) };

test('catalog timing preserves results and records only aggregate phases', async () => {
  const res = response(), measured = measuredCatalogRuntime(runtime);
  await catalogTiming({}, res, async () => {
    const value = await measured.transaction(async db => {
      assert.equal(await db.query('private SQL / tenant / credential'), 'private SQL / tenant / credential');
      return measureCatalogPhase('render', () => 'rendered');
    }, { readOnly: true });
    assert.equal(res.end(value), 'rendered');
  });
  assert.match(res.headers['Server-Timing'], /db;dur=[\d.]+;desc="1 queries"/);
  for (const phase of ['total', 'db_setup', 'db_finalize', 'render']) assert.match(res.headers['Server-Timing'], new RegExp(`${phase};dur=`));
  assert.doesNotMatch(res.headers['Server-Timing'], /private|tenant|credential/);
});
test('simultaneous requests retain isolated query counts', async () => {
  const measured = measuredCatalogRuntime(runtime), first = response(), second = response();
  await Promise.all([first, second].map((res, index) => catalogTiming({}, res, async () => {
    await measured.withClient(async db => { for (let i = 0; i <= index; i++) await db.query('SELECT fixture'); }); res.end();
  })));
  assert.match(first.headers['Server-Timing'], /desc="1 queries"/); assert.match(second.headers['Server-Timing'], /desc="2 queries"/);
});
test('errors propagate and requests without SQL do not inherit timings', async () => {
  assert.throws(() => measureCatalogPhase('render', () => { throw new Error('sync'); }), /sync/);
  const measured = measuredCatalogRuntime(runtime), failed = response();
  await catalogTiming({}, failed, async () => {
    await assert.rejects(measured.transaction(async () => { throw new Error('async'); }, { readOnly: true }), /async/);
    await assert.rejects(measureCatalogPhase('encode', async () => { throw new Error('encode'); }), /encode/);
    failed.end();
  });
  assert.match(failed.headers['Server-Timing'], /encode;dur=/);
  const clean = response(); catalogTiming({}, clean, () => clean.end()); assert.doesNotMatch(clean.headers['Server-Timing'], /db|encode/);
});
