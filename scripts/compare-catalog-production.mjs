import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const option = (key, fallback) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) || fallback;
const afterLabel = option('after', 'production-after'), probesLabel = option('probes', 'production-probes'), outputLabel = option('output', 'production-comparison');
if (![afterLabel, probesLabel, outputLabel].every(value => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value))) throw new Error('Use short kebab-case report labels.');
const rawBefore = await fs.readFile('docs/catalog-performance/production-before.json');
const before = JSON.parse(rawBefore), after = JSON.parse(await fs.readFile(`docs/catalog-performance/${afterLabel}.json`, 'utf8'));
if (after.error || after.deploymentBefore !== after.deploymentAfter) throw new Error('Only a complete run against a stable deployment can be compared.');
if (after.baselineSha256 !== createHash('sha256').update(rawBefore.toString('utf8').replace(/\r\n/g, '\n')).digest('hex')) throw new Error('Historical baseline was changed.');
const stats = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? { n: sorted.length, p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1] } : null;
};
const summary = { measuredDeployment: after.deploymentBefore, beforeMeasuredAt: before.measuredAt, afterMeasuredAt: after.measuredAt,
  comparison: 'One historical observation per device versus median and nearest-rank p95 of three new runs. Small-sample descriptive comparison, not field percentiles.',
  conditions: after.conditions, baselineSha256: after.baselineSha256, scenarios: [], supplements: [], errors: [], incompleteRequestRecords: 0 };
for (const mobile of [false, true]) for (const name of new Set(after.journeys.map(row => row.name))) {
  const original = before.journeys.find(row => row.mobile === mobile && row.name === name), rows = after.journeys.filter(row => row.mobile === mobile && row.name === name);
  const record = { mobile, name, after: {} };
  for (const field of ['visibleMs', 'imageReadyMs', 'navigationTtfbMs', 'requests', 'documentRequests', 'dataApiRequests', 'imageApiRequests', 'transferredBytes', 'responses304']) record.after[field] = stats(rows.map(row => row[field]));
  if (rows.every(row => row.documentRequests > 0)) for (const field of ['documentTtfbMs', 'documentFcpMs', 'lcp']) record.after[field] = stats(rows.map(row => row[field]));
  if (original) {
    record.before = { n: 1, visibleMs: original.visibleMs, requests: original.requests, transferredBytes: original.transferredBytes, navigationTtfbMs: original.documentTtfbMs };
    if (record.after.lcp) Object.assign(record.before, { lcp: original.lcp, documentFcpMs: original.documentFcpMs });
    const oldPath = original.paths.find(row => row.type === 'document' && row.path.startsWith('/c/'))?.path;
    record.samePagePath = rows.every(row => row.requestDetails.find(request => ['document', 'fetch'].includes(request.type) && request.path.startsWith('/c/'))?.path === oldPath);
    record.visibleReductionPercent = 100 * (1 - record.after.visibleMs.p50 / original.visibleMs);
    record.ttfbReductionPercent = record.after.navigationTtfbMs && 100 * (1 - record.after.navigationTtfbMs.p50 / original.documentTtfbMs);
    summary.scenarios.push(record);
  } else summary.supplements.push(record);
}
for (const row of after.journeys) for (const request of row.requestDetails) {
  if (!request.status && !request.failure) summary.incompleteRequestRecords++;
  if (request.failure || request.status >= 400) summary.errors.push({ mobile: row.mobile, run: row.run, name: row.name, ...request });
}
const probes = JSON.parse(await fs.readFile(`docs/catalog-performance/${probesLabel}.json`, 'utf8'));
if (probes.sourceDeployment !== after.deploymentBefore) throw new Error('Probe and browser deployments differ.');
summary.probes = [...new Set(probes.probes.map(row => row.name))].map(name => {
  const rows = probes.probes.filter(row => row.name === name);
  return { name, ttfbMs: stats(rows.map(row => row.ttfbMs)), totalMs: stats(rows.map(row => row.totalMs)), bytes: stats(rows.map(row => row.bytes)),
    width: rows[0].width, height: rows[0].height, format: rows[0].format, conditionalTtfbMs: stats(rows.map(row => row.conditional?.ttfbMs)),
    conditionalStatuses: [...new Set(rows.map(row => row.conditional?.status).filter(Boolean))], conditionalBytes: stats(rows.map(row => row.conditional?.bytes)) };
});
await fs.writeFile(`docs/catalog-performance/${outputLabel}.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(`Compared ${summary.scenarios.length} historical scenarios and ${summary.supplements.length} new scenarios; ${summary.errors.length} HTTP/request errors.`);
