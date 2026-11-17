import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { digest, requestMessage, signature } from '../server/commerce/autoStorySecurity.js';

const namespace = '/api/internal/instagram-auto-story/v1';
const empty = Buffer.alloc(0);
export function originalClaimTime(createdAt, schedule, scheduledAt) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) throw new Error('RUNNER_CONFIGURATION_INVALID');
  if (scheduledAt) {
    const requested = Date.parse(scheduledAt);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:17:00Z$/.test(scheduledAt) ||
      !Number.isFinite(requested) || new Date(requested).toISOString() !== scheduledAt.replace('Z', '.000Z') ||
      ![12, 15, 19, 23].includes(new Date(requested).getUTCHours()) || requested > created) {
      throw new Error('RUNNER_CONFIGURATION_INVALID');
    }
    return requested;
  }
  if (!schedule) return created;
  const hour = /^17(?:,37,57)? (12|15|19|23) \* \* \*$/.exec(schedule)?.[1];
  if (!hour) throw new Error('RUNNER_CONFIGURATION_INVALID');
  const scheduled = new Date(created).setUTCHours(Number(hour), 17, 0, 0);
  return scheduled <= created ? scheduled : scheduled - 86_400_000;
}

export async function waitForApi(origin, { fetchImpl = fetch, pause = sleep, attempts = 6 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetchImpl(origin + namespace + '/health', { signal: AbortSignal.timeout(40_000), redirect: 'error' });
      if (response.status === 204) return;
    } catch { /* A sleeping host may close the first connection. */ }
    if (i < attempts - 1) await pause(Math.min((i + 1) * 5000, 15_000));
  }
  throw new Error('STOCKY_UNREACHABLE');
}

export function createRunnerClient(origin, key, fetchImpl = fetch) {
  return async (path, method = 'POST', bytes = empty) => {
    const target = namespace + path;
    const time = String(Date.now()), nonce = randomUUID();
    const sha = digest(bytes);
    const headers = { 'x-stocky-time': time, 'x-stocky-nonce': nonce, 'x-stocky-content-sha256': sha,
      'x-stocky-signature': signature(key, requestMessage(method, target, time, nonce, sha)) };
    if (bytes.length) headers['Content-Type'] = 'image/jpeg';
    let response;
    try {
      response = await fetchImpl(origin + target, { method, headers,
        body: bytes.length ? bytes : undefined, signal: AbortSignal.timeout(100_000), redirect: 'error' });
    } catch { throw new Error('STOCKY_REQUEST_FAILED'); }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) {
      const code = result?.error?.code;
      throw new Error(typeof code === 'string' && /^[A-Z_]{3,60}$/.test(code) ? code : 'STOCKY_REQUEST_FAILED');
    }
    return result;
  };
}

export async function renderWithPlaywright(payload, browserOptions) {
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    cacheDir: 'node_modules/.cache/stocky-auto-story-vite',
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  let browser;
  try {
    await vite.listen();
    browser = await chromium.launch(browserOptions);
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/scripts/auto-story-render.html`);
    await page.waitForFunction(() => typeof window.renderAutoStory === 'function');
    return Buffer.from(await page.evaluate(data => window.renderAutoStory(data), payload));
  } finally {
    await browser?.close();
    await vite.close();
  }
}

async function run() {
  const api = URL.parse(process.env.AUTO_STORY_API_ORIGIN ?? '');
  if (!api) throw new Error('RUNNER_CONFIGURATION_INVALID');
  if (api.protocol !== 'https:' || api.href !== api.origin + '/' || !/^[0-9a-f]{64}$/i.test(process.env.AUTO_STORY_RUNNER_KEY ?? '')) {
    throw new Error('RUNNER_CONFIGURATION_INVALID');
  }
  const dryRun = process.argv.includes('--dry-run');
  const at = process.env.GITHUB_ACTIONS === 'true' && !dryRun
    ? originalClaimTime(process.env.AUTO_STORY_RUN_CREATED_AT, process.env.AUTO_STORY_RUN_SCHEDULE,
      process.env.AUTO_STORY_SCHEDULED_AT) : undefined;
  const request = createRunnerClient(api.origin, Buffer.from(process.env.AUTO_STORY_RUNNER_KEY, 'hex'));
  await waitForApi(api.origin);
  let job = await request(dryRun ? '/simulate' : at === undefined ? '/claim' : `/claim?at=${at}`);
  if (job.status === 'rendering') {
    const { id } = job;
    let jpeg;
    try { jpeg = await renderWithPlaywright(job); }
    catch {
      if (!dryRun) await request(`/jobs/${id}/render-failed`);
      throw new Error('RENDER_FAILED');
    }
    if (dryRun) return { status: 'simulated' };
    job = await request(`/jobs/${id}/jpeg`, 'PUT', jpeg);
  }
  if (job.status === 'ready') {
    const { id } = job;
    job = await request(`/jobs/${id}/advance`);
    for (let i = 0; i < 4 && job.status === 'processing'; i++) {
      await sleep(60_000);
      job = await request(`/jobs/${id}/advance`);
    }
  }
  return job;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let summary;
  try {
    const { status, code } = await run();
    summary = `Instagram Story: ${status}${code ? ` (${code})` : ''}`;
    if (['failed', 'unknown'].includes(status)) process.exitCode = 1;
  } catch (error) {
    const code = /^[A-Z_]{3,60}$/.test(error.message) ? error.message : 'AUTO_STORY_FAILED';
    summary = `Instagram Story: error (${code})`;
    process.exitCode = 1;
  }
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}
