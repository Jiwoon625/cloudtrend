# KOSPI operational strategy adoption

## Entry sequence: confirm1 + positive confirmation-day RSAccel

1. Keep the existing eligible-stock E8 raw event: previous score < 8.0 and current score >= 8.0. `kospi80Onset` records this raw Onset; it is not executable entry permission.
2. At the close of the next **KOSPI trading day**, require a score >= 8.0 and finite RSAccel > 0. A UP95 upward crossing on that confirmation close does **not** veto a new entry. RSAccel = RS20 − RS60, measured on the confirmation day. Zero, negative, or missing RSAccel does not pass.
3. Only a confirmed, eligible assessment can enter at the following tradable session's open. The confirmation-day close never provides a same-day execution price.
4. Failed or unobservable confirmation cannot create an entry. A later score recovery or RSAccel improvement does not revive a rejected event; a new E8 Onset is needed.

KOSPI PL remains ETF PL 84 first, Stock PL 80 fallback (PR #102 scoring unchanged). RSAccel is an entry filter, not an addition to the technical or priority score. KOSPI score exit remains an upward crossing from below 9.5 to at least 9.5, with no downside exit. Existing H60 expiry, P30, sector cap, costs, and duplicate-signal protection remain in place. Held symbols and a sale consuming the same Onset are suppressed from new entries.

KOSDAQ retains Stock PL 80, E8 / U9.0 / D3.0 / H60 and its entry-day overshoot precedence. ETF and US strategies are unchanged.

## Stored state and display

`operationalStrategy.ts` owns operating signal eligibility and shared descriptions. `kospi80Onset` preserves the raw E8 event. The compatibility alias `kospiEightPointEntry` is true only for confirmed, date-bound entry readiness. Use `isOperationalEntry(row, asOfDate)` to determine actionable entry permission; consumers must also apply portfolio holdings/sold-signal suppression.

`kospiEntry` stores version, assessment date, Onset origin date, confirmation date, state (`none`, `pending`, `confirmed`, `rejected`, or `unobservable`), issues, confirmation-day RSAccel, and eligibility. The date is the assessment date; the origin date is the original E8 Onset, not the execution day.

Dashboard counts/lists and screener filters distinguish raw Onset / confirmation pending from confirmed entry readiness. Detail and history show stored dates, state, RSAccel, and issues. Historical reconstructed confirmations before the operational effective date (2026-10-02) are reference-only and are excluded from new operational entries. Older snapshots without a confirmation record are not inferred to be confirmed from an Onset flag, label, or current RSAccel. Existing historical ledger rows are not rewritten.

## Same-day UP95 amendment (2026-10-02 KST)

The amended policy is `kospi-e8-confirm1-rsaccel-up95-v3`, effective for confirmation dates from 2026-10-02, unchanged from the adoption date and decided before that day's close. This removes only the confirmation-day UP95 new-entry veto; it does not allow a fresh raw Onset to skip the one-session confirmation. Onset-day overshoots keep the existing pending state. Other exits do not gain an entry exception.

Stored valid v2 confirmations remain consumable under their original stricter no-UP95 rule, and v2 UP95 exits remain readable for held positions. Row and confirmation versions must match. Rejected, missing, mismatched or stale v2 evidence is never upgraded. A fresh v3 source-data reconstruction on or after October 2 may confirm a previously rejected UP95 case; this change performs no data migration or historical ledger rewrite. No screening or research backtest is run while preparing this draft. After deployment, existing cache-miss paths can rebuild screening under v3; this is ordinary cache refresh, not a migration. Pre-October-2 reconstruction remains reference-only. The three screening/dashboard/instrument cache contracts are bumped so old rejection results are not presented as a fresh v3 run. Ledger cache version 3 invalidates the strategy fingerprint on the next explicit sync and preserves the source date of KOSPI exit evidence separately from the current price mark: neither a new simulated holding nor a newer actual holding displays a pre-entry confirmation signal as a fresh held exit. Actual execution rows are unchanged.

A confirmation+UP95 record deliberately carries both contextual signals: a never-held new candidate can enter at the next tradable open; an existing position exits under its normal UP95 rule and cannot re-enter from the same Onset. The confirmation close precedes the new trade's entry date, so its UP95 is not a post-entry exit and cannot cause same-bar round-trip execution. No change is made to score construction, held exits, actual executions, KOSDAQ, ETF or US rules. Archived comparative research that used the veto remains labeled as the prior policy; this amendment does not assert a new profit estimate.

## Verification expectations

Cover the next KOSPI trading-day confirmation boundary, holidays/weekends, score rejection, confirmation-day UP95 new-entry acceptance and held-position exit separation, positive/zero/negative/missing RSAccel, next-open execution, stale/missing snapshots, pre-effective-date exclusion, repeated synchronization, and held/sold-signal suppression. Verify dashboard, screener, instrument detail, history, cache, and portfolio consumers against the same stored state. Keep KOSDAQ, ETF, US and scoring regression coverage unchanged.
