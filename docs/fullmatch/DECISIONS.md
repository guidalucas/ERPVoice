# FullMatch implementation decisions

## D001 — authorization and reference precedence
2026-10-20: the implementation brief supersedes the earlier planning-only scope. Preserve audit/plan as historical references; use current code and safety constraints first. No production changes, real money normalization, deployments, pushes, paid services or real external publications/payments.

## D002 — architecture
One Node/Express backend, PostgreSQL and existing inventory authority. Studio has its own React entry and does not hydrate `/api/state`. Commercial metadata never duplicates stock or base prices. Keep scoped compound relations and explicit API contracts.

## D003 — continuity
Installed CLI supports `exec --json`, `exec resume <id>` and is logged in with ChatGPT. Only help/version/login-status were invoked. Prepare an external supervisor, never start another coding agent from this active implementation. JSONL is documented; live quota error/reset shapes are not yet verified, so unknown failures stop instead of being guessed as quota. No persistent Windows task/startup registration.

## D004 — fixtures before production
Real currency/scale, storage and production resources require confirmation. Develop/migrate/test on explicit isolated fixtures. New inspection tools must not import PostgreSQL bootstrap. Production enablement is a gate, not grounds to halt independent work.

## D005 — preserving prior work
Baseline is `4dc5d9b`; branch `codex/fullmatch-studio`. Audit and technical plan existed as untracked documents. Preserve them and snapshot reference/brief in docs/fullmatch for recovery; do not silently rewrite the historical plan.

## D006 — verified foundations
The first commercial migration is a single atomic additive version with six domain tables, scoped FKs, private grants and RLS. It does not configure any real business or rewrite inventory. Existing test harness creates its own temporary PostgreSQL before applying it. Inventory money validation runs after immutable receipt replay and only for explicitly configured businesses. Production/verify-mode HTTP bootstrap inspects instead of executing DDL; explicit production migration requires a separate maintenance opt-in. Final hardened foundation run: 344 PostgreSQL checks passed.

## D007 — Windows test environment
Supervisor tests initially failed because the restricted Windows sandbox denies rename even for newly created temporary fixture files. The same eight tests pass with expanded local execution; no implementation fallback weakens atomic checkpoint writes. 165 baseline domain tests and 344 isolated PostgreSQL checks passed before the last constraint hardening; re-run integration after that change.
