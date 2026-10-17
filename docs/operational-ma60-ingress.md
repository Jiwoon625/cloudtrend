# Prospective ETF MA60 publication ingress

The prospective release is enabled after independent review and fixed-input web/Actions parity verification. Only new screening inputs dated 2026-10-19 or later can use the provider. Deployment does not execute screening or replay history.

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

The initial verification releases kept operational activation OFF while separate authenticated web and Actions diagnostic requests were checked. A platform-level termination of the previous combined request was observed; without runtime logs it is not certified as a timeout or memory failure. No production screening or repair utility was executed by these tests.

## Bounded canonical normalization

The first deployed two-request check completed the raw web phase but the Actions phase returned a generic platform server error. No timeout or out-of-memory cause is certified. Post-check hashes for 26 owner database scopes and 5,108 non-research Storage objects remained unchanged.

The Actions diagnostic now downloads and validates each original source's bytes, immediately canonicalizes it, and retains only canonical text for the final parser. It does not hold all raw source text in parallel with each validator's normalized rows and sorted CSV. The original file hash, logical/schema hashes, source precedence and validator remain mandatory and unchanged. Diagnostic output/logging is bounded numeric byte counts and elapsed times, never source rows, paths or credentials. This remains a read-only diagnostic, not a new workflow or live screening execution. That validation deployment kept operational activation OFF pending successful actual parity.

## Prospective activation verification, 2026-10-17

The user supplied a completed diagnostic export after the bounded normalization deployment. Its SHA-256 is `393747553b78b798b781ab421d451b81b20fa0b5caa8aee8a0306fa41b910734`. The export contains web and Actions result digests and input fingerprints that match exactly, with 22 sources and 1,790 analysis rows. The original dataset digest is unchanged. Across all 768 changed ETF strategy snapshots, only provenance fields and 218 numeric MA60 values differ; entry/exit, score, raw onset and underlying close are unchanged. The full prior fixed-input comparison fields match the earlier independently verified report. Web phase elapsed 82,241 ms and Actions phase 152,545 ms. These are completed fixed-input comparison measurements, not a promise about future duration.

The supplied export is not attributed to an earlier unobserved browser request: it has no execution timestamp or signed run identity. Its file metadata and user-provided success screenshot corroborate the result; independent record/Storage metadata observations are reported separately, not inferred from `writesPerformed=0`. A subsequent read-only audit found all 26 database scope hashes and 5,108 non-research Storage object metadata hashes unchanged from the verification baseline; this is not a re-download/hash of every stored object byte.

The release flag can now enable the existing guarded publication provider for new input dates from 2026-10-19 only. No engine, chart, cache, owner-installation or financial-ledger logic changes in the activation commit. Cash/bond and other non-target ETFs remain reference-only. The first real new screening session remains unverified until the user runs it and its output is checked.
