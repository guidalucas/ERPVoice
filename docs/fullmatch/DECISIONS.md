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

## D008 — verified private commercial boundary

Stage 1 uses scoped commercial commands/immutable receipts, owner-only access, explicit SKU links and optimistic revisions. A repeatable-read story snapshot is kept in its `story.prepare` receipt; semantic revalidation compares live commercial data rather than using timestamps or maximum revisions. Prices remain exact decimal strings in minor units. No product endpoint accepts inventory balances/prices as commercial edits.

## D009 — real photo processing and uncertain commits

Sharp 0.35.4 was confirmed available from npm and installed with its prebuilt dependency. Local storage is limited to nonproduction; the Supabase REST adapter requires an explicit private bucket and server-only credentials and has not been enabled against a real provider. Keep the planned eight-photo/12-MiB/24-megapixel limits. Upload TTL is 30 minutes; a two-minute reclaimable attempt lease is separate from the maintenance five-minute stale threshold. Processing/storage are outside SQL transactions. In an uncertain COMMIT outcome, preserve files until metadata can be rechecked; a verified ready reference wins over cleanup. Master reads verify the recorded SHA-256. Logical retire precedes an explicit purge after 24 hours. Maintenance has no automatic schedule and never writes inventory.

## D010 — independent Studio and fixture acceptance

Studio builds from `studio.html`/`vite.studio.config.ts` into `dist-studio`; it reuses auth/session services without importing Stocky's application store or `/api/state`. Browser drafts and unconfirmed operations are scoped by the logged-in owner. Fixtures use a uniquely named loopback PostgreSQL database, random ports/secrets, actual authentication and local synthetic art clearly marked DEMO. Five Edge desktop/mobile acceptance flows passed, including a new ficha through SKU selection, photo processing and a real 1080x1920 export. Production enablement remains separate from fixture completion.

## D011 — public catalog boundary and SSR

Stage 2 adds explicit catalog migration 2; it does not modify migration 1 or auto-enable a production business. Catalog master switch and per-ficha publication have separate revisions/receipts. Public DTOs use an explicit allowlist and boolean availability, without SKU identities, internal quantities/reserves, owner IDs, keys or operational state. Every public image repeats the publication/readiness boundary. Invalid identity/money/cover/contact and disabled businesses fail closed. Replaying an old publication receipt cannot reverse a later hide.

The public catalog uses Express-rendered HTML/CSS at stable `/c/:shop` and `/c/:shop/p/:slug` routes. This supplies crawlable content and SEO without another frontend runtime or rewrite requirement. Absolute canonical URLs require a configured origin; HTML and JSON-LD are escaped by context. Studio remains the separate React entry. Fixtures and tests contain DEMO data only; no production catalog or external account was published.
