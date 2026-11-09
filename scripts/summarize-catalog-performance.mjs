import fs from 'node:fs/promises';

const read = async name => JSON.parse(await fs.readFile(`docs/catalog-performance/${name}.json`, 'utf8'));
const stats = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return { n: sorted.length, p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1] };
};
const summary = {
  method: 'p50: middle observation; p95: nearest rank. Three local repetitions; one production journey per viewport. Small samples are descriptive, not field percentiles.',
  units: { time: 'ms', transfer: 'bytes' }, local: {}, productionBefore: {},
};
for (const label of ['before', 'after']) {
  const result = await read(label), group = { journeys: [], database: [] };
  for (const mobile of [false, true]) for (const name of new Set(result.journeys.map(row => row.name))) {
    const rows = result.journeys.filter(row => row.mobile === mobile && row.name === name), record = { mobile, name };
    for (const field of ['visibleMs', 'settledMs', 'requests', 'transferredBytes', 'documentRequests']) record[field] = stats(rows.map(row => row[field]));
    // LCP/FCP/TTFB entries belong to the document, not a subsequent soft navigation.
    if (['cold-list', 'reload-product'].includes(name)) for (const field of ['documentTtfbMs', 'documentFcpMs', 'lcp']) record[field] = stats(rows.map(row => row[field]));
    group.journeys.push(record);
  }
  for (const name of ['list-3', 'detail']) {
    const rows = result.database.filter(row => row.name === name), record = { name };
    for (const field of ['queryCount', 'dbMs', 'totalMs']) record[field] = stats(rows.map(row => row[field]));
    group.database.push(record);
  }
  group.eventTimingProxy = stats(result.journeys.map(row => row.longestInteraction));
  group.longTasksMax = Math.max(...result.journeys.map(row => row.longTasks));
  summary.local[label] = group;
}
const production = await read('production-before');
summary.productionBefore.journeys = production.journeys.map(({ name, mobile, visibleMs, documentTtfbMs, documentFcpMs, lcp, requests, transferredBytes }) => ({ name, mobile, visibleMs, documentTtfbMs, documentFcpMs, lcp, requests, transferredBytes }));
await fs.writeFile('docs/catalog-performance/summary.json', JSON.stringify(summary, null, 2) + '\n');
console.log('Saved docs/catalog-performance/summary.json');
