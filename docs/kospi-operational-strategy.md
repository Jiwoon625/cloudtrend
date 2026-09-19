# KOSPI operational strategy adoption

- KOSPI PL: ETF PL 84 first, Stock PL 80 fallback (PR #102 scoring unchanged).
- KOSPI entry: eligible stock, previous score < 8.0 and current score >= 8.0.
- KOSPI score exit: previous score < 9.5 and current score >= 9.5; no downside exit.
- KOSDAQ retains Stock PL 80, E8 / U9.0 / D3.0 / H60.
- Existing H60 expiry, next-session open execution, P30, sector cap, costs and duplicate-signal protection remain in place for the portfolio. Entry-day overshoots prioritize entry, as in the existing KOSDAQ implementation.

`operationalStrategy.ts` owns operating signals and shared descriptions. `kospi80Onset` is the executable field; `kospiEightPointEntry` is a compatibility alias. Snapshots carry `operationalSignalVersion`; older informational KOSPI snapshots and old level-based UP95/DOWN25 records cannot create trades or exits. Rescreening produces the new signals. No historical ledger rows are rewritten by this change.

Dashboard, screener, detail, snapshots and portfolio consume structural fields. CLI and browser dashboard caches now share the same builder and version. The obsolete V6 orchestration status/score-delta overwrite is removed. Detail shows holdings only when the portfolio ledger actually contains an open, positive-share position.

Validation: 29 focused tests pass, including the requested 7.5→8 / 9→9.5 / 3→2 cases, all 441 half-point KOSDAQ transitions, snapshots/projections, next-open portfolio execution and H60. Production build passes. Full-suite baseline and branch both have the same 18 failing assertions and 5 suite-loading failures; TypeScript diagnostics also match baseline (no new errors). Authenticated live portfolio writes were not performed during validation.
