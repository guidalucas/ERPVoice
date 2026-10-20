# Windows continuity — external, opt-in supervisor

Verified locally: Codex CLI `0.163.0-alpha.10.2`, `exec`, explicit `exec resume <UUID>`, JSONL and `login status` reporting ChatGPT. No coding CLI/inference was launched from the desktop implementation session.

## One-command use (separate PowerShell after stopping this chat's implementation)

From the repository, with no other agent writing here:

```powershell
pwsh -File scripts/fullmatch-autocontinue.ps1 -AcknowledgeNoOtherWriter
```

For one bounded turn, including manual recovery:

```powershell
pwsh -File scripts/fullmatch-autocontinue.ps1 -Once -AcknowledgeNoOtherWriter
```

The first external run starts one dedicated CLI session and saves the actual `thread.started` UUID in ignored `.fullmatch-runtime/session.json`. Subsequent runs resume that exact UUID, never `--last`. It does not assume that the desktop conversation is safely resumable from a CLI with equivalent context. The brief/references/checkpoints transfer the project objective to the external session.

The runner forces ChatGPT/OpenAI subscription authentication, ignores user provider overrides, removes API-key environment overrides, limits writes to the workspace and disables sandbox network access. It does not register Windows services/tasks/startup entries, upgrade plans, change accounts or buy credits. Sandbox failures requiring permission stop for human intervention; no bypass mode is used. Git checkpoint commits may require manual approval because `.git` can be sandbox protected.

## Stop and status

```powershell
pwsh -File scripts/fullmatch-autocontinue.ps1 -Status
pwsh -File scripts/fullmatch-autocontinue.ps1 -Stop
```

STOP is graceful: the current bounded unit can finish/checkpoint; no next Codex is launched. After verifying there is no writer and inspecting the checkpoint, remove only `.fullmatch-runtime/STOP` to resume. A lock is never stolen automatically. If the supervisor crashed, inspect its recorded PID and all agent activity before removing the single lock file. Never delete the runtime directory to resolve a running writer.

The supervisor lock prevents two cooperating supervisor instances. No local script can guarantee that an unrelated desktop editor/agent honors that lock: the acknowledgement explicitly confirms that this chat/other writers have been stopped. Environment checks also reject nesting inside a Codex turn. Keep only one writer on this branch.

## Quota and limits — important verification boundary

Official JSONL documents turn completion/failure, but live installed-CLI quota/reset event shapes have not been observed. The detector accepts only explicit structured usage-limit codes. An arbitrary 429, textual error, test failure, network error or authentication failure is **not** treated as subscription quota. Unknown failures stop and retain the exact session/checkpoint; use the one-command manual recovery once the issue is resolved.

For supported structured quota events, PAUSED_QUOTA is saved, the last checkpoint/next action is retained and no calls occur before a supported reset or conservative 30-minute-to-4-hour backoff. After eight consecutive quota attempts human attention is required. A failed CLI may not emit enough structure to support automatic reset recovery: **automatic recovery after real quota exhaustion is not claimed verified**. No scraping or paid API fallback.

Logs contain only allowlisted lifecycle fields, bounded to three roughly 128-KiB files. Raw command outputs, events, prompts, tokens and stderr are not persisted. Runtime session/lock files are gitignored. Ctrl+C is not advertised as an atomic checkpoint; prefer STOP and wait for the current unit.

## Simulations

```powershell
node --test scripts/test-fullmatch-supervisor.js
```

Tests use temporary repositories and a fake local Node child, never a second Codex or deliberately exhausted quota. They cover exact resume ID, progress, completion gates, quota waiting/restart, interrupted/auth/config failures, mutual exclusion, active-session rejection, STOP and no raw-log leakage. Real inference/resume and a live quota renewal remain unverified until an authorized external invocation is performed separately.

Official references: [non-interactive execution and JSONL](https://developers.openai.com/codex/noninteractive), [CLI commands](https://developers.openai.com/codex/cli/reference), [ChatGPT authentication](https://developers.openai.com/codex/auth).
