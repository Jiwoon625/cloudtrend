# KOSPI operational strategy adoption

## Entry sequence: confirm1 + positive confirmation-day RSAccel

1. Keep the existing eligible-stock E8 raw event: previous score < 8.0 and current score >= 8.0. `kospi80Onset` records this raw Onset; it is not executable entry permission.
2. At the close of the next **KOSPI trading day**, require a score >= 8.0, no UP95 upward crossing on that confirmation day, and finite RSAccel > 0. RSAccel = RS20 − RS60, measured on the confirmation day. Zero, negative, or missing RSAccel does not pass.
3. Only a confirmed, eligible assessment can enter at the following tradable session's open. The confirmation-day close never provides a same-day execution price.
4. Failed or unobservable confirmation cannot create an entry. A later score recovery or RSAccel improvement does not revive a rejected event; a new E8 Onset is needed.

KOSPI PL remains ETF PL 84 first, Stock PL 80 fallback (PR #102 scoring unchanged). RSAccel is an entry filter, not an addition to the technical or priority score. KOSPI score exit remains an upward crossing from below 9.5 to at least 9.5, with no downside exit. Existing H60 expiry, P30, sector cap, costs, and duplicate-signal protection remain in place. Held symbols and a sale consuming the same Onset are suppressed from new entries.

KOSDAQ retains Stock PL 80, E8 / U9.0 / D3.0 / H60 and its entry-day overshoot precedence. ETF and US strategies are unchanged.

## Stored state and display

`operationalStrategy.ts` owns operating signal eligibility and shared descriptions. `kospi80Onset` preserves the raw E8 event. The compatibility alias `kospiEightPointEntry` is true only for confirmed, date-bound entry readiness. Use `isOperationalEntry(row, asOfDate)` to determine actionable entry permission; consumers must also apply portfolio holdings/sold-signal suppression.

`kospiEntry` stores version, assessment date, Onset origin date, confirmation date, state (`none`, `pending`, `confirmed`, `rejected`, or `unobservable`), issues, confirmation-day RSAccel, and eligibility. The date is the assessment date; the origin date is the original E8 Onset, not the execution day.

Dashboard counts/lists and screener filters distinguish raw Onset / confirmation pending from confirmed entry readiness. Detail and history show stored dates, state, RSAccel, and issues. Historical reconstructed confirmations before the operational effective date (2026-10-02) are reference-only and are excluded from new operational entries. Older snapshots without a confirmation record are not inferred to be confirmed from an Onset flag, label, or current RSAccel. Existing historical ledger rows are not rewritten.

## Verification expectations

Cover the next KOSPI trading-day confirmation boundary, holidays/weekends, score and UP95 rejection, positive/zero/negative/missing RSAccel, next-open execution, stale/missing snapshots, pre-effective-date exclusion, repeated synchronization, and held/sold-signal suppression. Verify dashboard, screener, instrument detail, history, cache, and portfolio consumers against the same stored state. Keep KOSDAQ, ETF, US and scoring regression coverage unchanged.
