# Prospective ETF MA60 connection

## Scope

The approved historical KRX underlying-index observations are a separate immutable provider. They never overwrite stock/ETF OHLC, source registry bytes, past screening snapshots, Shadow sessions, or actual fills. The operational connection starts no earlier than the new 2026-10-19 screening date. It is disabled until the authenticated, read-only full-universe comparison has been reviewed.

Only existing equity/option-overlay ETF targets receive MA60 confirmation/exit changes. Cash, bond, inverse, leveraged and other excluded instruments get chart/reference data only. M0 technical/priority/health/environment, peer environments, own-index lag, original crossings, eligibility and origin dates are unchanged. Price-based E4 and other adopted rules remain unchanged.

The adapter runs after the frozen full-market engine. Shadow publication retains the original engine result and dataset. The executable engine manifest must remain byte-identical.

## Rolling inputs

The approved October 16 artifact is pinned by SHA256. Original-vs-approved content is validated with only the enumerated historical value choices allowed. New daily KRX observations append by explicit date and matching index name/provider. Historical values outside exact approved pairs, name/source drift, missing new observations and unresolved conflicts are not silently overridden. Validation is per symbol; quarantined or incomplete values are null and not actionable. Neither day shifting, repeated-value deduplication, NAV substitution nor blanket future override is permitted.

The original artifact is diagnostic evidence, not an independently certified index identity/currency/methodology or a PIT backtest source. The prospective provider version records the explicit operational choice without changing that limitation.

## Display and storage boundaries

Operational publication records provider version, artifact digest, as-of and availability time. Fingerprints include the version/digest when activation is eligible. Restored chart contexts must match the saved operational metadata. Pre-activation chart points stay unchanged. No read endpoint initiates screening or writes a ledger.

The existing diagnostic comparison remains frozen-vintage-only. The separate operational comparison loads the current owner sources, computes original full analysis once, applies only the MA60 adapter, verifies source/dataset hashes before/after and returns changes. It stores nothing and does not return raw source files. All score components, eligibility and raw onset dates must be identical. Changed entry/exit decisions need explicit review before enabling.

## Verification and rollback

Run the dedicated underlying-index test config, TypeScript check, build, and Shadow manifest comparison. Check the owner-authenticated full-universe impact report before setting OPERATIONAL_INDEX_ENABLED=true. The first deployment leaves that flag false. Rollback disables only this provider; do not restore old price files or replay stored sessions.

## Local validation (2026-10-17)

The focused suite passed 167 tests before the additional original-artifact guard regressions. TypeScript and production build passed. The full default Vitest run reports 47 failures on both this branch and an untouched main worktree (25 failing files); no new failing test names remain. The existing failures include server-function RPC test configuration problems. They are not represented as a full-suite pass. Re-run the dedicated configuration after the guard additions and inspect CI for the published commit.

PR294 review follow-up: consumers now verify the pinned original artifact bytes and compare the approved artifact against that original. Only the exact approved value selections, approval metadata and non-earlier availability time may differ. Audit markers count the preference values actually selected, including differences below numerical conflict tolerance. Focused suite: 186 passed locally including the original/approved file pair (the optional pair test uses explicit environment file paths and skips in CI without those files).
