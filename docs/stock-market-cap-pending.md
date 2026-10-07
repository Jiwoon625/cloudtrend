# Current-session stock market-cap prerequisite

A stock without a usable market cap for the analysis session cannot pass the entry universe. Missing, non-finite, zero, negative, or stale-session cap data remains unavailable; the engine does not estimate it or carry yesterday's value forward.

## Result contract

- `hardFilterStatus: PASS`: all required universe checks passed
- `hardFilterStatus: FAIL`: at least one observed rule failed
- `hardFilterStatus: PENDING`: required evidence is missing, without a known rule failure
- `pendingRules` retains missing prerequisites even when another rule fails
- `hardFilterPassed` is true only for PASS

Technical scoring, feature availability, score history, and held-position exit evaluation continue independently. Missing cap remains missing in the priority score. KOSPI onset and confirmation both require the relevant dated cap before entry readiness can be established. Correcting the cap on the same source session re-evaluates those observations without requiring another price bar.

## Consumers and caches

The screener, detail page, dashboard, and history distinguish pending from disqualification and preserve raw scores. Pending rows remain visible when disqualified rows are hidden. Current portfolio and Shadow entry consumers veto explicit pending metadata even if a stale structural entry flag is true. A previously confirmed order is evaluated from the information available before its execution open, without applying future closing data.

Snapshots and compact dashboard rows preserve pending evidence. Schema/version changes invalidate caches written under the old skip-based contract. Same-date source-content changes cause one recalculation and portfolio refresh; unchanged repeated reads reuse cached results without new source downloads or portfolio replay. ETF's existing missing-KRX policy and the separate US strategy are retained.

## Frozen Shadow compatibility

Frozen contracts, completed sessions, and archived input prefixes are unchanged. Legacy snapshots without the new evidence retain their prior replay semantics. A synthetic first-session result and next-session continuation generated on clean main `e8c66871fcc51e3e554a793403e1cb6315d06e49` are checked byte-for-byte against the corrected runtime, including a legacy `hardFilterPassed: false` onset. This fixture contains no account or production data.

Only the exact reviewed runtime hash is admitted. The immutable frozen code identity remains separate from per-publication runtime provenance. Production replay checks the reviewed runtime against registry identity before a new publication; unknown runtime hashes fail closed. This is a prospective missing-input bugfix after existing sessions, not a pre-first-session exception, history reset, or blanket runtime allowance.

## Regression coverage

- Missing/invalid/current-date/stale caps; known failure vs pending; same-date correction
- Raw technical scores and availability preserved; held exit signals unaffected
- KOSPI onset-day and confirmation-day missing evidence
- Stale entry flags blocked in portfolio, snapshot, dashboard and Shadow consumers
- Legacy prefix/reuse/continuation exact equality; immutable source/history guards
- Same-date cache refresh followed by zero extra reads/replays
- Existing ETF, US, ledger, dashboard, and source/cache test configurations

Production deployment and one existing-source screening refresh are verified separately in the release record. No orders are submitted by this change.

## Bounded history persistence

The deployed-input check exposed that repeated pending metadata could exceed the existing 1 MiB `screening_history.snapshot` JSONB text limit even when all calculations succeeded. Oversized snapshots now use a versioned, lossless field-name schema envelope only at the database boundary. All domestic history readers decode it before domain, portfolio, or display logic. Existing plain snapshots remain readable and are not bulk-rewritten. Small snapshots retain their existing format.

The size guard accounts for PostgreSQL JSONB separator spaces, UTF-8, and numeric exponent expansion rather than comparing compact JavaScript JSON alone. It rejects malformed envelopes and oversized output with an explicit error; it never truncates entries or pending evidence. No database limit, migration, sharing setting, or frozen Shadow calculation is changed.

PostgreSQL's JSONB output normalization is documented in [JSON input/output syntax](https://www.postgresql.org/docs/current/datatype-json.html#JSON-IO).
