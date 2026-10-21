import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyTurn, executionArgs, quotaRetryAt } from './fullmatch/supervisorPolicy.js';
import { acquireLock, logLifecycle, readStatus, runAgent, supervisor } from './fullmatch/supervisor.js';

const id = '11111111-1111-4111-8111-111111111111';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fullmatch-supervisor-'));
  t.after(async () => {
    const resolved = await fs.realpath(root), parent = await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('fullmatch-supervisor-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
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

test('auth stops; unknown/interrupted once mode persists spaced retry; no-progress stops', async t => {
  for (const failure of ['auth', 'interrupted', 'failure', 'no-progress']) {
    const f = await fixture(t); let calls = 0;
    const run = () => supervisor({ ...f.options, once: true, runner: async options => {
      calls++; await options.onSession(id);
      return { events: failure === 'auth' ? [{ type: 'error', code: 'authentication_error' }]
        : failure === 'no-progress' ? [{ type: 'turn.completed' }] : [], exitCode: failure === 'interrupted' ? null : failure === 'no-progress' ? 0 : 1 };
    } });
    if (failure === 'no-progress') await assert.rejects(run, /CHECKPOINT_NOT_ADVANCED/);
    else assert.equal((await run()).kind, failure);
    assert.equal(calls, 1);
    const local = JSON.parse(await fs.readFile(path.join(f.root, '.fullmatch-runtime/session.json')));
    if (['interrupted', 'failure'].includes(failure)) assert.ok(local.nextCheckAt >= Date.now() + 29 * 60_000);
  }
});

test('quota recovery after persisted wait preserves newer progress and resumes exact session', async t => {
  const f = await fixture(t); let now = 1790000000000;
  await supervisor({ ...f.options, once: true, clock: () => now, runner: async options => {
    await options.onSession(id);
    await f.write({ ...f.cp, revision: 6, stage: 1, nextAction: 'Preserved newer commercial task' });
    return { events: [{ type: 'turn.failed', error: { code: 'usage_limit_reached' } }], exitCode: 1 };
  } });
  const paused = JSON.parse(await fs.readFile(path.join(f.docs, 'checkpoint.json')));
  assert.equal(paused.revision, 7); assert.equal(paused.stage, 1); assert.equal(paused.nextAction, 'Preserved newer commercial task');
  let calls = 0, waits = 0;
  const result = await supervisor({ ...f.options, clock: () => now, wait: async ms => { assert.ok(ms <= 60_000); now += ms; waits++; }, runner: async options => {
    calls++; assert.ok(options.args.includes(id)); assert.ok(options.prompt.includes(paused.nextAction));
    assert.ok(now >= 1790000000000 + 30 * 60_000);
    await f.write({ ...paused, revision: 8, status: 'COMPLETED' });
    await fs.writeFile(path.join(f.docs, 'TASKS.md'), '- [x] task\n');
    return { events: [{ type: 'turn.completed' }], exitCode: 0 };
  } });
  assert.equal(result.kind, 'completed'); assert.equal(calls, 1); assert.ok(waits >= 30);
  const local = JSON.parse(await fs.readFile(path.join(f.root, '.fullmatch-runtime/session.json')));
  assert.equal(local.quotaAttempts, 0); assert.equal(local.nextCheckAt, null);
});

test('IDE checkpoint starts fresh CLI context; interrupted session restarts from saved ID and files', async t => {
  const f = await fixture(t); let now = Date.now();
  const first = await supervisor({ ...f.options, once: true, clock: () => now, runner: async options => {
    assert.ok(!options.args.includes('resume'));
    for (const doc of ['IMPLEMENTATION_BRIEF.md', 'IMPLEMENTATION_STATE.md', 'TASKS.md', 'DECISIONS.md', 'checkpoint.json']) assert.ok(options.prompt.includes(doc));
    assert.ok(options.prompt.includes(f.cp.nextAction));
    await options.onSession(id); await f.write({ ...f.cp, revision: 2, nextAction: 'Continue after interruption' });
    return { events: [], exitCode: null };
  } });
  assert.equal(first.kind, 'interrupted'); now = first.nextCheckAt;
  const recovered = await supervisor({ ...f.options, once: true, clock: () => now, runner: async options => {
    assert.ok(options.args.includes('resume')); assert.ok(options.args.includes(id));
    assert.ok(options.prompt.includes('Continue after interruption'));
    await f.write({ ...f.cp, revision: 3 });
    return { events: [{ type: 'turn.completed' }], exitCode: 0 };
  } });
  assert.equal(recovered.kind, 'turn-completed');
});

test('active status requires live PID and recent heartbeat; STOP during waiting prevents a new child', async t => {
  const f = await fixture(t); const now = Date.now(); let checks = 0;
  const first = await supervisor({ ...f.options, once: true, clock: () => now, runner: async options => {
    const status = await readStatus(f.root, now);
    assert.equal(status.active, true); assert.equal(status.processAlive, true); assert.equal(status.phase, 'running');
    await options.onSession(id); return { events: [], exitCode: null };
  } });
  assert.equal((await readStatus(f.root, now)).active, false);
  const stopped = await supervisor({ ...f.options, clock: () => now, wait: async () => {
    checks++;
    const status = await readStatus(f.root, now); assert.equal(status.phase, 'waiting');
    assert.equal(status.nextCheckAt, new Date(first.nextCheckAt).toISOString());
    await fs.writeFile(path.join(f.root, '.fullmatch-runtime/STOP'), 'stop');
  }, runner: async () => assert.fail('STOP must prevent restart') });
  assert.equal(checks, 1); assert.equal(stopped.kind, 'stopped');
  const runtime = path.join(f.root, '.fullmatch-runtime');
  const release = await acquireLock(runtime);
  const stale = await readStatus(f.root, now + 60_000); assert.equal(stale.active, false);
  await release();
});

test('unknown failures back off then stop; supported quota keeps waiting beyond eight attempts', async t => {
  const f = await fixture(t); let now = Date.now(), calls = 0;
  const failure = await supervisor({ ...f.options, clock: () => now, wait: async ms => { now += ms; }, runner: async options => {
    calls++; await options.onSession(id); return { events: [{ type: 'error', message: 'unrecognized 429' }], exitCode: 1 };
  } });
  assert.equal(failure.kind, 'failure-needs-human'); assert.equal(calls, 9);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.docs, 'checkpoint.json'))).status, 'IN_PROGRESS');
  const sessionFile = path.join(f.root, '.fullmatch-runtime/session.json');
  await fs.writeFile(sessionFile, JSON.stringify({ version: 1, sessionId: id, quotaAttempts: 12, failureAttempts: 0, nextCheckAt: null }));
  const quota = await supervisor({ ...f.options, once: true, clock: () => now, runner: async () => ({
    events: [{ type: 'error', code: 'usage_limit_reached' }], exitCode: 1,
  }) });
  assert.equal(quota.kind, 'quota'); assert.equal(quota.nextCheckAt, now + 4 * 60 * 60_000);
});

test('malformed events and unexpected session changes fail closed; lifecycle logs rotate', async t => {
  const f = await fixture(t);
  const result = await supervisor({ ...f.options, runner: async () => ({ events: [], exitCode: 1, malformed: true }) });
  assert.equal(result.kind, 'failure');
  await assert.rejects(() => supervisor({ ...f.options, runner: async options => {
    await options.onSession(id); await options.onSession('22222222-2222-4222-8222-222222222222');
  } }), /SESSION_CHANGED_UNEXPECTEDLY/);
  const log = path.join(f.root, 'supervisor.log');
  for (let i = 0; i < 3; i++) { await fs.writeFile(log, 'x'.repeat(128 * 1024 + 1)); await logLifecycle(f.root, { kind: 'test', token: 'never-log' }); }
  assert.ok((await fs.stat(`${log}.2`)).size > 128 * 1024);
  assert.ok((await fs.stat(log)).size < 1024);
  assert.ok(!(await fs.readFile(log, 'utf8')).includes('never-log'));
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

test('full controller recovers from quota through real local JSONL child processes without Codex', async t => {
  const f = await fixture(t), fake = path.join(f.root, 'fake-quota-agent.mjs'); let now = Date.now(), children = 0;
  await fs.writeFile(fake, `import fs from 'node:fs/promises';
process.stdin.resume();process.stdin.on('end',async()=>{
 const file='docs/fullmatch/checkpoint.json'; const cp=JSON.parse(await fs.readFile(file,'utf8'));
 console.log(JSON.stringify({type:'thread.started',thread_id:'${id}'}));
 if(cp.revision===1){
  await fs.writeFile(file,JSON.stringify({...cp,revision:2,stage:1,nextAction:'preserved child progress'}));
  console.log(JSON.stringify({type:'turn.failed',error:{code:'usage_limit_reached'}}));process.exitCode=1;
 }else{
  await fs.writeFile(file,JSON.stringify({...cp,revision:cp.revision+1,status:'COMPLETED'}));
  await fs.writeFile('docs/fullmatch/TASKS.md','- [x] task\\n');
  console.log(JSON.stringify({type:'turn.completed'}));
 }
});`);
  const result = await supervisor({ ...f.options, clock: () => now, wait: async ms => { now += ms; }, runner: async options => {
    children++;
    if (children > 1) { assert.ok(options.args.includes(id)); assert.ok(options.prompt.includes('preserved child progress')); }
    return runAgent({ ...options, command: process.execPath, args: [fake] });
  } });
  assert.equal(result.kind, 'completed'); assert.equal(children, 2);
  assert.equal((await readStatus(f.root)).active, false);
  const log = await fs.readFile(path.join(f.root, '.fullmatch-runtime/supervisor.log'), 'utf8');
  assert.ok(log.includes('quota.wait')); assert.ok(log.includes('completed'));
});
