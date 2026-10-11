# KOSPI200 quick comparison · fixed initial KRW 100m / 30

**Research only.** This is the user-approved simplified alternative to the stricter, blocked KOSPI200 validation PR #262.

## Study boundary

- Reuse the **completed 20 historical signal-cache segments** from the privately persisted KR/ETF run `38016639367` at source commit `38da620ced597eaae4e07b54f36a2173c70d9640`. Verify all source/cache hashes, do **not rescore** or change the actual KOSPI signal/exit decision dates.
- Replay **only KOSPI stocks**, standalone 30-slot account, initial balance KRW 100m and a **fixed lifetime nominal new-position budget** `100,000,000 / 30`; no annual prior-NAV rebudget; no rebalance of open holdings.
- Retain original E8 next-session confirmation, risk-off restrictions embedded in previously computed dated signals, next tradable open execution, new U9.5 upward crossing exit/H60 close expiry, sector cap, and integer units.
- Model stock round-trip cost 0.30%, ETF cost one-way 0.15%, no cash interest. The exact price/volume/H60/cash exception mechanics still come from CloudTrend's existing ledger executor.
- Benchmark = **KODEX 200 (069500)** actual observed open and close **adjusted OHLC** rows from the same pinned historical raw source. **Do not pay additional cash dividends or ETF distributions**; user's CM research judged their price effects already reflected in the adjusted series.
- Do **not** require independent historical exchange-date/PIT gate certification. This is a historical approximation under the existing backtest's data limitations, not audited out-of-sample evidence.
- Through **2026-09-11**, the verified common Korean-stock history cutoff. Include prior history from 2017-08-21 in both account states, but score separately for 2018–2024, 2025, 2026 partial, full 2018–2026 and a stitched **2025-excluded daily return sensitivity**. Leave-one-full-year-out and rolling 504-session comparisons as side diagnostics.

## Compared accounts

1. `kospi_fixed_p30` — untouched signal dates, **re-run** stock cash, holdings and fills with fixed initial-capital sizing.
2. `kodex200_buy_hold` — purchase whole ETF shares at the first historical open and hold, with model entry fee and mark-to-market (no terminal forced sale).
3. `kodex200_exposure_mirror` — next-open ETF+cash fraction equal to the prior-close invested fraction of the stock strategy. Synthetic fractional units, daily rebalancing and fees; supplementary check on stock-picking vs exposure timing, not directly investable.

Report total return, 252-session CAGR, Sharpe, MDD, Calmar and stock-minus-ETF differences. A numeric Sharpe advantage does not guarantee future outperformance.

## Implemented components

- `src/lib/portfolioLedgers.ts` — research-only fixed-budget option, production modes preserved.
- `src/lib/research/adoptedKrBacktest.ts` — optional budget policy passed to original ledger executor.
- `scripts/run-adopted-kr-etf-backtest.ts` — standalone fixed-P30-only replay from *immutable historical scored cache*, with original signal-generator hash explicitly pinned and current replay code hash separately preserved. Emits KODEX 200 adjusted bars and the exact stock ledger.
- `research/kospi200_simple/compare.py` — common-date series and robust year/rolling slices.
- `research/kospi200_simple/run_private.py` — one-shot read-only import of 20 historical cache segments plus hash-pinned original source Parquets; create-only private output to Supabase.
- `.github/workflows/kospi200-lite-fixed-p30.yml` — one-shot Actions run gated by explicit `run(kospi200-lite): replay` commit, with separate non-secret type/unit checks. **No cron, no auto-repeat and no production site deployment.**

## Storage and confidentiality

Original read-only sources: Supabase private bucket `cloudtrend-data/{owner}/research/adopted-full-period/inputs`; cached scored chunks and previous NAV: `research/adopted-full-period/resumable/38016639367`. New private outputs (if successful): `research/adopted-full-period/runs/{new_run_id}-1/result/`, with KOSPI fixed-P30 daily NAV, trades, budgets, adjusted ETF prices, compare CSV, compare JSON and brief. The resulting GitHub run log emits **aggregate performance only**, never raw records, positions or credentials.

A corresponding Drive research-result copy belongs at `CloudTrend/한국시장/04_연구결과/기타_백테스트/KOSPI200_위험대비_최종검증` after verification. The study does not assume action-run storage is Google Drive itself.

## What this **does not** claim

- Dividend completeness is adopted **as a research assumption**, not re-audited; do not double count payouts.
- Cached source signals may retain the original retrospective investable universe and past market-regime limitations. Historical returns are not independent OOS.
- The exposure-matched ETF is a **daily lagged diagnostic** with frequent trading, not a recommended portfolio.
- The 2025-excluded stitch removes returns from observed series; it does **not** recompute investment decisions while skipping 2025.
- The earlier annual-prior-NAV P30 replay is not relabeled as fixed P30; actual cash/holdings are resimulated.

## Validation and execution

Tests run on Actions via `npm ci`, `npx tsc --noEmit`, `npx vitest run --config vitest.adopted-backtest.config.ts src/lib/research/adoptedKrBacktest.test.ts`, and `python -m unittest discover -s research/kospi200_simple -p 'test_*.py' -v`.

The actual historical run is authorized exactly once by the committed request marker and uses existing secret-backed private data access. Later pushes do not restart the historical replay unless explicitly marked `run(kospi200-lite): replay`.
