import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyTurn, executionArgs, quotaRetryAt } from './fullmatch/supervisorPolicy.js';
import { acquireLock, logLifecycle, runAgent, supervisor } from './fullmatch/supervisor.js';

const id = '11111111-1111-4111-8111-111111111111';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fullmatch-supervisor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const docs = path.join(root, 'docs/fullmatch'); await fs.mkdir(docs, { recursive: true });
  const cp = { version: 1, status: 'IN_PROGRESS', revision: 1, stage: 0, nextAction: 'A tested fixture task' };
  const write = value => fs.writeFile(path.join(docs, 'checkpoint.json'), JSON.stringify(value));
  await write(cp); await fs.writeFile(path.join(docs, 'TASKS.md'), '- [ ] task\n');
  await fs.writeFile(path.join(docs, 'IMPLEMENTATION_STATE.md'), '- Status: `IN_PROGRESS`\n');
  return { root, docs, cp, write, options: { root, acknowledge: true, preflight: false, environment: {} } };
}

test('only structured explicit usage-limit errors are quota; generic failures never are', () => {
  assert.equal(classifyTurn([{ type: 'error', message: 'HTTP 429 quota' }], 1).kind, 'failure');
  assert.equal(classifyTurn([{ type: 'error', error: { code: 'rate_limit_exceeded' } }], 1).kind, 'failure');
  assert.equal(classifyTurn([{ type: 'turn.failed', error: { code: 'usage_limit_reached', resets_at: 1800000000 } }], 1).kind, 'quota');
  assert.equal(classifyTurn([{ type: 'error', error: { code: 'authentication_error' } }], 1).kind, 'auth');
  assert.equal(classifyTurn([], null).kind, 'interrupted');
  assert.equal(classifyTurn([{ type: 'turn.completed' }], 1).kind, 'failure');
});

test('quota waiting uses exact supported reset or bounded spaced backoff', () => {
  const now = 1790000000000;
  assert.equal(quotaRetryAt(now, 0, null), now + 30 * 60_000);
  assert.equal(quotaRetryAt(now, 9, null), now + 4 * 60 * 60_000);
  assert.equal(quotaRetryAt(now, 0, now + 3600_000), now + 3660_000);
  assert.equal(quotaRetryAt(now, 0, NaN), now + 1800_000);
});

test('exec/resume use exact session, ChatGPT and workspace sandbox without API fallback', () => {
  const args = executionArgs('C:/fixture', id);
  assert.deepEqual(args.slice(0, 9), ['-C', 'C:/fixture', '-s', 'workspace-write', '-a', 'never', 'exec', 'resume', id]);
  assert.ok(!args.includes('--last')); assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.throws(() => executionArgs('x', '--last'), /INVALID_SESSION_ID/);
});

test('successful turn persists ID, resumes it and stops after verified project completion', async t => {
  const f = await fixture(t); let calls = 0;
  const result = await supervisor({ ...f.options, wait: async () => {}, runner: async options => {
    calls++;
    assert.equal(options.args.includes('resume'), calls > 1);
    if (calls > 1) assert.ok(options.args.includes(id));
    await options.onSession(id);
    await f.write({ ...f.cp, revision: calls + 1, status: calls === 2 ? 'COMPLETED' : 'IN_PROGRESS' });
    if (calls === 2) await fs.writeFile(path.join(f.docs, 'TASKS.md'), '- [x] task\n');
    return { events: [{ type: 'turn.completed' }], exitCode: 0 };
  } });
  assert.equal(result.kind, 'completed'); assert.equal(calls, 2);
  const local = JSON.parse(await fs.readFile(path.join(f.root, '.fullmatch-runtime/session.json')));
  assert.equal(local.sessionId, id);
});

test('auth/config/interruption stop once, no retries; stale checkpoint also stops', async t => {
  for (const failure of ['auth', 'interrupted', 'failure', 'no-progress']) {
    const f = await fixture(t); let calls = 0;
    const run = () => supervisor({ ...f.options, runner: async options => {
      calls++; await options.onSession(id);
      return { events: failure === 'auth' ? [{ type: 'error', code: 'authentication_error' }]
        : failure === 'no-progress' ? [{ type: 'turn.completed' }] : [], exitCode: failure === 'interrupted' ? null : failure === 'no-progress' ? 0 : 1 };
    } });
    if (failure === 'no-progress') await assert.rejects(run, /CHECKPOINT_NOT_ADVANCED/);
    else assert.equal((await run()).kind, failure);
    assert.equal(calls, 1);
  }
});

test('quota pauses checkpoint, waits across restart, never invokes while reset is future', async t => {
  const f = await fixture(t), now = 1790000000000;
  const first = await supervisor({ ...f.options, once: true, clock: () => now, runner: async options => {
    await options.onSession(id); return { events: [{ type: 'error', error: { code: 'usage_limit_reached' } }], exitCode: 1 };
  } });
  assert.equal(first.kind, 'quota');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.docs, 'checkpoint.json'))).status, 'PAUSED_QUOTA');
  const second = await supervisor({ ...f.options, once: true, clock: () => now + 1000, runner: async () => assert.fail('must wait') });
  assert.equal(second.kind, 'waiting');
});

test('exclusive lock, active-session guard, STOP, blocked and inconsistent completion fail closed', async t => {
  const f = await fixture(t), runtime = path.join(f.root, '.fullmatch-runtime'); await fs.mkdir(runtime);
  const release = await acquireLock(runtime);
  await assert.rejects(() => acquireLock(runtime), { code: 'EEXIST' }); await release();
  await assert.rejects(() => supervisor({ ...f.options, environment: { CODEX_THREAD_ID: id } }), /NESTED_CODEX_FORBIDDEN/);
  await assert.rejects(() => supervisor({ ...f.options, acknowledge: false }), /ACKNOWLEDGE/);
  await fs.writeFile(path.join(runtime, 'STOP'), 'stop');
  assert.equal((await supervisor({ ...f.options, runner: async () => assert.fail() })).kind, 'stopped');
  await fs.unlink(path.join(runtime, 'STOP'));
  await f.write({ ...f.cp, status: 'BLOCKED' }); assert.equal((await supervisor(f.options)).kind, 'blocked');
  await f.write({ ...f.cp, status: 'COMPLETED' }); await assert.rejects(() => supervisor(f.options), /UNCHECKED/);
});

test('raw event reader is exercised with a local fake process, no Codex invocation', async t => {
  const f = await fixture(t), fake = path.join(f.root, 'fake-agent.mjs');
  await fs.writeFile(fake, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'${id}'}));console.log(JSON.stringify({type:'item.completed',item:{text:'secret-never-log'}}));console.log(JSON.stringify({type:'turn.completed'}));});`);
  let session;
  const result = await runAgent({ command: process.execPath, args: [fake], root: f.root, prompt: 'fixture',
    onSession: async value => { session = value; }, stopRequested: async () => false });
  assert.equal(session, id); assert.equal(result.exitCode, 0); assert.equal(result.events.length, 1);
  await logLifecycle(f.root, { kind: 'completed', secret: 'never-log', token: 'secret', revision: 3 });
  assert.ok(!(await fs.readFile(path.join(f.root, 'supervisor.log'), 'utf8')).includes('secret'));
});
