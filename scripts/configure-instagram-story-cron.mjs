import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { databaseTarget } from './fullmatch/databaseTarget.js';

const actions = ['--apply', '--validate', '--activate', '--pause', '--simulate'].filter(flag => process.argv.includes(flag));
if (actions.length > 1) throw new Error('CHOOSE_ONE_SCHEDULER_ACTION');
const action = actions[0];
const client = new Client(databaseTarget(process.env, {
  allowRemote: process.argv.includes('--allow-remote-database'),
}));
let stage = 'CONNECT';
try {
  await client.connect();
  await client.query(action ? 'BEGIN' : 'BEGIN READ ONLY');
  await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
  if (action) await client.query("SELECT pg_advisory_xact_lock(hashtext('stocky:instagram:scheduler'))");
  stage = 'SCHEMA';
  if (action === '--apply' || action === '--validate') {
    await client.query(await readFile(new URL('./fullmatch/instagram-story-cron.sql', import.meta.url), 'utf8'));
  }
  const { rows: [schema] } = await client.query(
    "SELECT to_regclass('stocky_automation.instagram_story_dispatches') IS NOT NULL AS ready");
  if (action && !schema.ready) throw new Error('SCHEDULER_SCHEMA_REQUIRED');
  if (!schema.ready) {
    console.log(JSON.stringify({ ready: false }));
  } else {
    if (action === '--activate') {
      const { rowCount } = await client.query('SELECT 1 FROM commerce_schema_migrations WHERE version=10');
      if (!rowCount) throw new Error('FIVE_STORY_WINDOWS_MIGRATION_REQUIRED');
      stage = 'TOKEN';
      const { rows: [secret] } = await client.query(
        "SELECT EXISTS(SELECT 1 FROM vault.secrets WHERE name='stocky_instagram_actions_token') AS present");
      if (!secret.present) throw new Error('GITHUB_DISPATCH_TOKEN_REQUIRED');
      stage = 'WORKFLOW';
      const response = await fetch('https://api.github.com/repos/guidalucas/ERPVoice/contents/.github/workflows/instagram-auto-story.yml?ref=main', {
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      });
      if (!response.ok) throw new Error('GITHUB_WORKFLOW_UNAVAILABLE');
      const file = await response.json();
      if (!Buffer.from(file.content, 'base64').toString('utf8').includes('AUTO_STORY_SCHEDULED_AT:')) {
        throw new Error('GITHUB_WORKFLOW_UPDATE_REQUIRED');
      }
    }
    if (action === '--activate' || action === '--pause') {
      stage = 'ACTIVATION';
      await client.query("SELECT cron.alter_job(jobid, active := $1) FROM cron.job WHERE jobname ~ '^stocky-instagram-story-(0|12|15|18|19|21|23)(-retry)?$'",
        [action === '--activate']);
    }
    if (action === '--simulate') {
      stage = 'SIMULATION';
      const result = await client.query('SELECT stocky_automation.dispatch_instagram_story(15, true) AS request_id');
      console.log(JSON.stringify(result.rows[0]));
    }
    const jobs = await client.query("SELECT jobname,schedule,active FROM cron.job WHERE jobname LIKE 'stocky-instagram-story-%' ORDER BY jobname");
    const dispatches = await client.query('SELECT request_id,scheduled_at,requested_at,dry_run,http_status,http_error FROM stocky_automation.instagram_story_dispatches ORDER BY requested_at DESC LIMIT 12');
    console.log(JSON.stringify({ ready: true, jobs: jobs.rows, dispatches: dispatches.rows }));
  }
  stage = action === '--validate' ? 'ROLLBACK' : 'COMMIT';
  await client.query(stage);
  if (action === '--validate') console.log(JSON.stringify({ validated: true, changed: false }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  const code = [error.code, error.message].find(value => typeof value === 'string' && /^[A-Z0-9_]{2,64}$/.test(value));
  console.error(JSON.stringify({ error: 'STORY_SCHEDULER_CONFIGURATION_FAILED', stage, code: code ?? 'UNKNOWN' }));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
