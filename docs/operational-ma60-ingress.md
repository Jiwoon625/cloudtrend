# Prospective ETF MA60 publication ingress

This change keeps `OPERATIONAL_INDEX_ENABLED=false` until the reviewed verification deployment and authenticated no-save comparison succeed. Activation is a separate commit. Only new screening inputs dated 2026-10-19 or later can use the provider.

## Boundaries

- `screeningPublicationAnalysis` is the shared web/Actions publication adapter. Frozen engines and Shadow receive their original dataset/analysis. Existing price observations, saved history and actual fills are never rewritten by the provider.
- Strategy-target ETFs may use the approved MA60 for the existing confirmation/exit predicates. Cash, bond, leveraged/inverse and other non-target ETFs only gain `operationalEtfReference`; their strategy fields and action labels remain unchanged.
- Missing/conflicting observations are not forward-filled. Per-symbol quarantine/missing MA60 suppresses actionable MA60 confirmation/exit and exposes unavailable data.
- Approval remains a user-selected vintage, not certified historical point-in-time official data.

## Owner installation and recovery

Apply `20261017091854_operational_index_installations.sql` before deploying this code. It creates an owner-scoped, insert/read-only receipt table and backfills owners of either pinned artifact. Readers still verify both actual artifact byte hashes and the bounded approval delta. No trading/history table is changed.

The installer records a validated installation intent before its first immutable Storage write. Thus a partial installation or subsequent deletion remains distinguishable from a never-installed owner. Never-installed owners retain the legacy path. Missing, corrupt or mismatched installed artifacts fail closed. Read-only comparisons do not write receipts.

## Identity and saved results

All three ingress paths use `screeningInputIdentity`, `stableCacheJson`, and the same deterministic-analysis digest shape. Source order is registry calculation precedence (activated_at, created_at, id), never lexical reordering. Legacy fallback fields remain unchanged. Provider identity is included only when actually applied.

Browser readers use validated saved `analysis.operationalIndex`; they do not infer provider use from the current global flag or source max_date (not supplied by the browser registry API). Dashboard projections carry the same identity. Saved chart restoration verifies the digest and selects the pinned provider independently of the current flag. Unknown provider versions fail rather than upgrading a historical result.

The local browser writer asks the authenticated read-only policy endpoint whether this owner/date is operational. It blocks before local calculation/snapshot/cache writes in operational context, and also refuses to overwrite a saved operational result after rollback. Never-installed owners retain local legacy calculation.

## Verification

The synthetic ingress suite calls the actual web runner and Actions runner against fake storage, then reads their output with the real browser cache reader. It covers OFF/ON, 10/16 and 10/19, installed/uninstalled, missing/corrupt artifacts, equal publication digests/fingerprints, untouched Shadow inputs, rollback chart restoration and local-write boundaries. PGlite verifies receipt backfill, RLS, anonymous denial and immutability. Existing tests cover bounded approval conflicts, original/approved hash mismatch and missing observations.

The authenticated no-save diagnostic runs raw web input and canonicalized Actions input through the same publication projection and compares digests/fingerprints. The two large dataset phases run as separate authenticated requests; only compact evidence is compared. Source, date, configuration and provider identity must agree across requests. It never calls the screening publisher, Shadow replay, snapshot persistence or portfolio services. This proves only the current fixed input, not the first future session.

Commands: dedicated underlying-index Vitest config; screening-memory, CLI, dashboard-cache and portfolio-screening-refresh tests; TypeScript; changed-file ESLint; build with frozen Shadow manifest checks. Compare the default Vitest failure set with main rather than claiming a clean full suite.

After successful activation, the user executes the first new real screening. Until its result is observed, report: **first new-session validation remains pending**.

## Remaining ingress review fixes

The chart repair utility validates the saved digest and provider identity, reconstructs the same pinned provider independently of rollout state, and accepts an explicit original scoring-config JSON for non-default results. It does not run screening or modify a ledger. Actions reuse validates the owner provider before accepting an operational-date cached run; provider and ordered source identity are part of prospective reuse eligibility. The missing-installation decision rechecks the receipt after absent artifact bytes, blocking a receipt-first installation race instead of publishing legacy results during that observed race.

Operational activation remains OFF. Separate authenticated web and Actions diagnostic requests must finish and agree before reactivation. A platform-level termination of the previous combined request was observed; without runtime logs it is not certified as a timeout or memory failure. No production screening or repair utility was executed by these tests.
