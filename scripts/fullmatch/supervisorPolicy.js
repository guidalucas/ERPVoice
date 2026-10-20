import { createHash } from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const checkpointStatuses = ['IN_PROGRESS', 'PAUSED_QUOTA', 'BLOCKED', 'COMPLETED'];

export function validateCheckpoint(value) {
  if (value?.version !== 1 || !checkpointStatuses.includes(value.status)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.stage) || value.stage < 0 || value.stage > 4
    || typeof value.nextAction !== 'string' || !value.nextAction.trim()) {
    throw new Error('INVALID_PROJECT_CHECKPOINT');
  }
  return value;
}

// Never infer quota from arbitrary HTTP 429s, free-form stderr or network failures.
// Unknown installed-CLI error shapes stop for human inspection instead of looping.
export function classifyTurn(events, exitCode) {
  if (exitCode === 0 && events.some(event => event.type === 'turn.completed')
    && !events.some(event => ['turn.failed', 'error'].includes(event.type))) return { kind: 'completed' };
  const errors = events.filter(event => ['turn.failed', 'error'].includes(event.type));
  for (const event of errors) {
    const error = event.error ?? event;
    const code = error.code ?? error.codex_error_info?.type;
    if (['usage_limit_reached', 'usageLimitReached'].includes(code)) {
      const reset = error.resets_at ?? error.reset_at;
      const numeric = typeof reset === 'number' ? (reset < 1e12 ? reset * 1000 : reset) : NaN;
      return { kind: 'quota', resetAt: Number.isFinite(numeric) ? numeric : null };
    }
    if (['unauthorized', 'authentication_error', 'authentication_failed'].includes(code)) return { kind: 'auth' };
  }
  return { kind: exitCode === null ? 'interrupted' : 'failure' };
}

export function quotaRetryAt(now, attempt, reportedReset) {
  const minimum = now + 30 * 60_000;
  if (Number.isFinite(reportedReset) && reportedReset > now && reportedReset < now + 8 * 86400_000) {
    return Math.max(minimum, reportedReset + 60_000);
  }
  return now + Math.min(4 * 60, 30 * 2 ** Math.min(attempt, 3)) * 60_000;
}

export function executionArgs(root, sessionId) {
  if (sessionId !== null && !UUID.test(sessionId)) throw new Error('INVALID_SESSION_ID');
  const base = ['-C', root, '-s', 'workspace-write', '-a', 'never', 'exec'];
  if (sessionId) base.push('resume', sessionId);
  base.push('--ignore-user-config', '--json', '-c', 'forced_login_method="chatgpt"',
    '-c', 'model_provider="openai"', '-c', 'sandbox_mode="workspace-write"',
    '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=false', '-');
  return base;
}

export function continuationPrompt(checkpoint) {
  return `Continue the explicitly authorized FullMatch Studio implementation in this repository.
Read docs/fullmatch/IMPLEMENTATION_BRIEF.md, IMPLEMENTATION_STATE.md, TASKS.md, DECISIONS.md and checkpoint.json first.
Verify real files/tests; resume the first incomplete implementable task, currently: ${checkpoint.nextAction}
Complete a bounded meaningful unit, run relevant tests and preserve Stocky regressions. Never use real database credentials for tests.
Do not start another Codex, supervisor, subagent or external task. Do not deploy, push, alter production, normalize real money, pay, publish or connect external accounts.
Use isolated fixtures for unknown commercial facts. Keep status IN_PROGRESS while independent work remains; BLOCKED only for a human-required stop.
Before ending this turn update the three checkpoint documents and checkpoint.json, increment its revision, record executed evidence and the next concrete action.
Use PAUSED_QUOTA only for an actual quota limit. COMPLETED requires all authorized implementable acceptance criteria and no unchecked implementation tasks.
Local milestone commits are authorized only after their relevant tests pass. Never include secrets or erase other work.`;
}

export const progressFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
