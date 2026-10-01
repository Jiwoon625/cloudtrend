# ETF V0.2: one-session confirmation, liquidity priority, no replacement

Approved 2026-10-01. Policy version `etf-v02-confirm1-liquidity-no-replacement`.
Notion specification: https://app.notion.com/p/3ecd908cac2f81dc954fd037e45adbd4

## Signal timeline
- Raw Onset at session t close: consecutive valid M0 scores cross from <80 to >=80. 80 is an absolute score, not a percentile.
- At exact next Korean market session t+1 close: require eligible data, M0 >=80, underlying close >= underlying MA60.
- Confirmed candidates target t+2 open. A failed/missing confirmation expires; never bridge missing symbol dates, chase an old candidate, or infer holidays from weekdays.
- `rawOnset` is the original crossover; `entryState` is none/pending/confirmed/rejected. `onset` is the backward-compatible actionable **confirmed** alias. `originDate`, `confirmationDate`, `confirmationIssues` are persisted with the snapshot and dashboard projection.
- No score changes: 62.5/7.5/15/15, including domestic relative-performance Priority and existing environment scores.

## Portfolio
- Sort by confirmation-close trailing20 KRX trading-value average DESC, symbol ASC ties. Twenty dates must match market sessions; no future price/turnover.
- Exclude actual and legacy tracked holdings, and sales on/after the original signal date. A sale consumes that signal even if confirmation happens tomorrow.
- Maximum10; no replacement, top-up, rebalancing, or deferred-candidate queue. Existing recorded executions are not rewritten.
- Normal underlying<MA60 exit unchanged; missing underlying is a separate data warning.
- Sell first, then recompute actual available cash/slots. Never fund a plan with unexecuted sales.
- Sizing from confirmation close: 10% * min(1, 15% / annualized sample std20), sqrt252, zero volatility=>10%. Invalid volatility blocks orders. Budget=min(cash,equity*weight), integer quantity=floor(budget/(estimatedOrderPrice*1.0015)). Closing-price default is an estimate, not a known future open.
- Screens produce plans only. Manual execution recording remains separate and does not submit brokerage orders.

## UI and rollout
ETF screener and portfolio show pending/confirmed/rejected, dates, reason, turnover and weight. Unknown holdings block order plans. Pending/rejected rows do not expose an enabled signal-buy action. Manual historical trade entry remains available.
Policy, screening/detail/dashboard and projection cache versions change. Old policy results cannot emit current entry signals. Recalculate from supplied data; missing inputs remain missing. Other markets and disabled timed screening schedules are unchanged.

## Evidence / limitations
Current614-stock/768-ETF-candidate panel,2017–2026-09-11,cost0.30% round trip: immediate/symbol CAGR8.0801%, MDD-17.7177%, Sharpe0.785789; confirmation/liquidity/no replacement9.4397%/-15.0629%/0.911550. Executable delayed-zero-volume-exit audit9.4380%/-15.0748%/0.911404. Not a new independent OOS or certified corporate-action/total-return accounting. Recent2025+ MDD worsened -11.43%→-12.71%. Historical policy researchEvidence in config is retained and explicitly tagged previousPolicy.

## Verification
Focused engine/portfolio/cache regression suite; independent golden technical/volatility fixture; exact-day missing-data and repeated-run tests; held/sold suppression and turnover tie-break; integer/cash/max10/no-replacement tests. Existing main's legacy V4/Vf tests fail unchanged; the repository's whole-suite command also incorrectly collects node:test files in Vitest. Record exact final counts and CI/deployment separately in PR, not as assumed success here.
