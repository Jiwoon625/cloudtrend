# Unified Shadow portfolio

`/shadow` is the single model-observation tab for **KOSPI 하루확인·불황 시 RSAccel 필터**, US A2 quarterly and US B3 Beta. `/us/portfolio` retains A0 Primary and SPY, with a link to the unified tab. Existing US storage, registry, strategy IDs, snapshots, trades and capital are unchanged. KRW and USD are never added together or implicitly converted.

## KOSPI research rule, frozen v1

Model ID: `KOSPI_CONFIRM1_BEAR_RSACCEL_SHADOW`  
Rule version: `kospi-confirm1-bear-rsaccel-shadow-v1`

This is a research-policy virtual ledger. It does **not** create operational buy-ready signals, actual transactions, or actual investment capital. Its module is not imported by operational entry or actual-ledger code.

1. Start from the original raw V8 E8 cross (previous score <8, current score ≥8), without Primary entry vetoes. Freeze the exact original Onset date's complete KOSPI regime evidence.
2. At the exact next KOSPI session close, require V8 ≥8 but strictly below the 9.5 upside-exit score, plus the research common-history/signal-open condition. Common history means 253 valid session-aligned closes, with at least two paired eligible stocks. Missing confirmation is excluded without later retry.
3. An original bullish/neutral regime imposes no RS condition. An original bearish regime requires confirmation-day RSAccel >0. Unknown onset regime is excluded, never backfilled or reclassified from a later regime.
4. A confirmation-day V8 score ≥9.5 is excluded from every new entry, even when 9.5 was already reached on the Onset day and there is no fresh UP95 crossing on confirmation. Existing held-position UP95 exits remain authoritative.
5. Model entry uses the next session's executable open. No late retry after an unavailable entry open. Existing exits use UP95 at next executable open, H60 at an executable close or deferred open when halted; no downside exit and no regime-forced liquidation.
6. Baseline: KRW 100,000,000; 30 slots; max 3 per sector; previous-close NAV / 30 target; nearest integer shares capped by available cash; 0.15% per side (0.30% round trip). Priority is confirmation V8 descending, confirmation priority descending, symbol ascending.

[Research record](https://app.notion.com/p/3edd908cac2f812c9c8ae19e2a242776?pvs=204)

## Prospective-only start and persistence

The first valid source close on/after 2026-10-02 establishes cash and observation baselines only. No historical candidate, pending order, holding or executed trade is imported. Later closes advance one exact market session at a time. A date gap fails closed; it does not compress missing trading sessions. Holidays follow the KOSPI source calendar.

Private owner-scoped objects in the existing `cloudtrend-data` bucket:

- `USER/shadow/kospi-confirm1-bear-rsaccel-v1/registry.json`: immutable initial date, capital/rules/scoring config/hash and initial source/code provenance
- `.../sessions/YYYY-MM-DD.json`: immutable daily source hashes, exact dated regime evidence, pending candidates, virtual positions, fills, metrics and state
- `.../latest.json`: recoverable read projection, full NAV series and recent 1,000 model trades; full fills remain in the dated journal

No new public permissions or database schema changes. No writes to `portfolio_*`, `us_*`, `screening_history`, `analysis_runs`, or Primary caches.

Only the serialized main-branch `KOSPI prospective Shadow` GitHub workflow may publish. It runs after a successful main-branch `CloudTrend screening`, or via manual dispatch. Local CLI invocation defaults to denied publishing; `--dry-run` permits read-only validation. PR jobs never publish. Exact checked-out SHA is recorded.

Publishing requires the active source's as-of date exactly; newer current membership/ETF metadata cannot repair an earlier session. Optional `as_of` only asserts the exact active source date. Genuine gap repair requires the appropriate exact dated source snapshot, and cannot overwrite a completed date. Sources must be registered after the session close. Uploaded data quality is still a source limitation, not independent market certification.

Registry-only retries must use the same original source and code. Previous authoritative snapshots must exist and match the projection before advancing. A missing projection never permits resetting or rewinding capital when later journal entries exist. Same-day same-input/config/rule retries reuse the frozen result even after a later code deployment, retaining the original recorded SHA. Changed inputs/rules fail closed. New strategy logic requires an explicit versioned series decision.

## Metrics and limitations

KOSPI stores NAV, cash, benchmark price-index NAV, cumulative return, CAGR (252 annual sessions, elapsed sessions since cash baseline), MDD, current/mean exposure, fees, turnover and trade counts. Short-window CAGR is explicitly caveated. Date filters apply to NAV and trades; summary cards, holdings and pending observations are clearly labeled latest-snapshot data.

A missing close marks to the available current open or previous valid mark, with a stale-close warning. Corporate-action entitlement accounting, executable quotes, slippage/participation and real order fills are not certified. This prospective series uses current source OHLC reference prices; it does not claim realized investor performance or silently splice the historical adjusted-reference backtest into live results.

## Verification

- `npx vitest run src/lib/engine/kospiShadow.test.ts src/lib/engine/kospiShadowDataset.test.ts src/lib/kospiShadowStore.test.ts`
- `npx vitest run --config vitest.shadow.config.ts`
- `node tests/shadow-runner-smoke.mjs`
- `npm run test:us`
- `npx vitest run --config vitest.dashboard.config.ts`
- `npm run build`

Independent simulation parity against the exact research Python candidate-event and execution engines: 95 sessions ×45 symbols, 355 entries/341 exits, all exit dates/quantities/P&L matched; maximum daily NAV difference < KRW 0.00000006. UI tests cover all three descriptive model options, currencies, uninitialized/error states, preserved US holdings/trades, selected-model/date filtering and A0 separation. Full-repo TypeScript/lint/default-test baseline issues must be reported separately from these focused passes.
