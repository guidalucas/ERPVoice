import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { classifyTurn, continuationPrompt, executionArgs, quotaRetryAt, UUID, validateCheckpoint } from './supervisorPolicy.js';

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async file => fs.access(file).then(() => true, () => false);
const save = async (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
};

export async function acquireLock(directory) {
  const lockPath = path.join(directory, 'supervisor.lock');
  const handle = await fs.open(lockPath, 'wx');
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => { await handle.close(); await fs.unlink(lockPath).catch(() => {}); };
}

export async function logLifecycle(directory, data) {
  const file = path.join(directory, 'supervisor.log');
  const size = await fs.stat(file).then(stat => stat.size, () => 0);
  if (size > 128 * 1024) {
    await fs.rename(`${file}.1`, `${file}.2`).catch(() => {});
    await fs.rename(file, `${file}.1`);
  }
  // Only allow non-secret lifecycle fields. Never persist raw CLI events, prompts, stderr or tool outputs.
  const entry = { at: new Date().toISOString(), kind: String(data.kind).slice(0, 60) };
  for (const key of ['revision', 'exitCode', 'nextCheckAt', 'attempt']) if (data[key] !== undefined) entry[key] = data[key];
  await fs.appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

async function capture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const collect = bytes => { if (text.length < 64_000) text += bytes; };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', reject);
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI_PREFLIGHT_TIMEOUT')); }, 30_000);
    child.once('close', code => { clearTimeout(timer); resolve({ code, text }); });
  });
}

export async function runAgent({ command, args, root, prompt, onSession, stopRequested }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL']) delete env[key];
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const events = [];
    let buffer = '', sessionId = null, stopped = false, malformed = false, persistenceError = false;
    const decoder = new StringDecoder('utf8');
    let saves = Promise.resolve();
    const consume = line => {
      let event;
      try { event = JSON.parse(line); } catch { malformed = true; return; }
      if (event.type === 'thread.started') {
        if (!UUID.test(event.thread_id ?? '')) { malformed = true; return; }
        sessionId = event.thread_id;
        saves = saves.then(() => onSession(sessionId)).catch(() => { persistenceError = true; child.kill(); });
      }
      if (['turn.completed', 'turn.failed', 'error'].includes(event.type)) {
        if (events.length >= 100) { malformed = true; child.kill(); return; }
        events.push(event);
      }
    };
    child.stdout.on('data', bytes => {
      buffer += decoder.write(bytes);
      if (buffer.length > 1024 * 1024) { malformed = true; child.kill(); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.stdin.end(prompt);
    // Stop file is graceful: allow the current bounded unit to checkpoint, then do not launch again.
    const timer = setInterval(async () => { if (await stopRequested()) stopped = true; }, 1000);
    child.once('close', async code => {
      clearInterval(timer);
      buffer += decoder.end();
      if (buffer.trim()) consume(buffer.trim());
      await saves;
      resolve({ events, sessionId, exitCode: code, stopped, malformed: malformed || persistenceError });
    });
  });
}

export async function supervisor({ root, once = false, acknowledge = false, command = 'codex', runner = runAgent,
  preflight = true, environment = process.env, clock = () => Date.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  root = await fs.realpath(root);
  const directory = path.join(root, '.fullmatch-runtime');
  const checkpointPath = path.join(root, 'docs/fullmatch/checkpoint.json');
  const checkpointReal = await fs.realpath(checkpointPath);
  if (!checkpointReal.startsWith(`${root}${path.sep}`)) throw new Error('CHECKPOINT_OUTSIDE_WORKSPACE');
  if (!acknowledge) throw new Error('ACKNOWLEDGE_NO_OTHER_WRITER_REQUIRED');
  if (environment.CODEX_THREAD_ID || environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) throw new Error('NESTED_CODEX_FORBIDDEN');
  await fs.mkdir(directory, { recursive: true });
  const release = await acquireLock(directory); // Never steal a stale lock automatically.
  const sessionFile = path.join(directory, 'session.json'), stopFile = path.join(directory, 'STOP');
  try {
    if (preflight) {
      const auth = await capture(command, ['login', 'status'], root);
      if (auth.code !== 0 || !/Logged in using ChatGPT/i.test(auth.text)) throw new Error('CHATGPT_LOGIN_REQUIRED');
      const help = await capture(command, ['exec', 'resume', '--help'], root);
      if (help.code !== 0 || !help.text.includes('--json') || !help.text.includes('--ignore-user-config')) throw new Error('CLI_CAPABILITY_MISMATCH');
    }
    let local = await exists(sessionFile) ? await readJson(sessionFile) : { version: 1, sessionId: null, quotaAttempts: 0, nextCheckAt: null };
    if (local.version !== 1 || (local.sessionId !== null && !UUID.test(local.sessionId))) throw new Error('INVALID_SAVED_SESSION');
    while (!(await exists(stopFile))) {
      const before = validateCheckpoint(await readJson(checkpointPath));
      if (before.status === 'BLOCKED') return { kind: 'blocked' };
      if (before.status === 'COMPLETED') {
        if (/^- \[ \]/m.test(await fs.readFile(path.join(root, 'docs/fullmatch/TASKS.md'), 'utf8'))) throw new Error('COMPLETION_HAS_UNCHECKED_TASKS');
        return { kind: 'completed' };
      }
      if (local.nextCheckAt && clock() < local.nextCheckAt) {
        if (once) return { kind: 'waiting', nextCheckAt: local.nextCheckAt };
        await wait(Math.min(60_000, local.nextCheckAt - clock())); continue;
      }
      await logLifecycle(directory, { kind: 'turn.start', revision: before.revision });
      const result = await runner({ command, args: executionArgs(root, local.sessionId), root,
        prompt: continuationPrompt(before), stopRequested: () => exists(stopFile),
        onSession: async sessionId => {
          if (local.sessionId && local.sessionId !== sessionId) throw new Error('SESSION_CHANGED_UNEXPECTEDLY');
          local.sessionId = sessionId; await save(sessionFile, local);
        } });
      const classification = result.malformed ? { kind: 'failure' } : classifyTurn(result.events, result.exitCode);
      await logLifecycle(directory, { kind: classification.kind, exitCode: result.exitCode });
      if (classification.kind === 'quota') {
        if ((local.quotaAttempts ?? 0) >= 8) return { kind: 'quota-needs-human' };
        local.nextCheckAt = quotaRetryAt(clock(), local.quotaAttempts ?? 0, classification.resetAt);
        local.quotaAttempts = (local.quotaAttempts ?? 0) + 1;
        await save(sessionFile, local);
        const paused = { ...before, status: 'PAUSED_QUOTA', revision: before.revision + 1 };
        await save(checkpointPath, paused);
        const statePath = path.join(root, 'docs/fullmatch/IMPLEMENTATION_STATE.md');
        const state = await fs.readFile(statePath, 'utf8');
        await fs.writeFile(statePath, state.replace(/- Status: `[^`]+`/, '- Status: `PAUSED_QUOTA`'));
        await logLifecycle(directory, { kind: 'quota.wait', nextCheckAt: local.nextCheckAt, attempt: local.quotaAttempts });
        if (once) return { kind: 'quota', nextCheckAt: local.nextCheckAt };
        continue;
      }
      if (classification.kind !== 'completed') return classification;
      if (!local.sessionId) throw new Error('CLI_SESSION_NOT_PERSISTED');
      local.nextCheckAt = null; local.quotaAttempts = 0; await save(sessionFile, local);
      const after = validateCheckpoint(await readJson(checkpointPath));
      if (after.revision <= before.revision) throw new Error('CHECKPOINT_NOT_ADVANCED');
      if (result.stopped || await exists(stopFile)) return { kind: 'stopped' };
      if (once) return { kind: 'turn-completed' };
      await wait(5000);
    }
    return { kind: 'stopped' };
  } finally { await release(); }
}

async function main() {
  const args = process.argv.slice(2), value = args.indexOf('--repo');
  const root = value >= 0 ? args[value + 1] : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  if (!root) throw new Error('REPOSITORY_REQUIRED');
  const directory = path.join(root, '.fullmatch-runtime');
  if (args.includes('--stop')) { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'STOP'), 'Stop after current bounded unit.\n'); console.log('Stop requested; current turn may finish/checkpoint.'); return; }
  if (args.includes('--status')) {
    const checkpoint = validateCheckpoint(await readJson(path.join(root, 'docs/fullmatch/checkpoint.json')));
    console.log(JSON.stringify({ project: checkpoint.status, stage: checkpoint.stage, revision: checkpoint.revision,
      stopRequested: await exists(path.join(directory, 'STOP')), supervisorLock: await exists(path.join(directory, 'supervisor.lock')) })); return;
  }
  const result = await supervisor({ root, once: args.includes('--once'), acknowledge: args.includes('--acknowledge-no-other-writer') });
  console.log(JSON.stringify(result));
  if (['failure', 'auth', 'interrupted', 'quota-needs-human'].includes(result.kind)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Supervisor stopped: ${/^[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_CONFIGURATION_OR_RUNTIME_ERROR'}`); process.exitCode = 1; });
}
