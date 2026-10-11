# KOSPI individual stocks vs KODEX 200: audited comparison (research only)

**Status: DATA BLOCKED / synthetic regression available.** This folder is deliberately isolated from the CloudTrend production engine. It neither claims that the current stock strategy has been re-run nor creates public investment recommendations.

## Why this exists

The question is whether the **current KOSPI stock strategy** beats a simple **KOSPI200 ETF** on a risk-adjusted basis **even without 2025**. Comparing the old KOSPI price index to older strategy variants cannot establish this.

The reference contract is `docs/operating-rules-20261012.md` (a **work-in-progress** operating contract at the time of initial review). A separately produced, audited historical replay matching that contract must be supplied. Its essential requirements include:

- KOSPI E8 raw onset, one *next KOSPI-session* confirmation with >=8, no confirmation-day *new* U9.5 breakout, risk-off/unknown trading restrictions; RSAccel>0 on confirmation if the original signal was in the bear regime.
- Next available open execution, U9.5 next-open exit / H60 observation close, no downside score exit, same-sector cap 3, priority and tie-breaking per current adopted implementation.
- Initial capital / 30 *fixed* slot budget; **not** annual-prior-NAV / 30. Genuine execution constraints, cash, corporate actions, 0.15% each-way model costs, holdings and subsequent NAV must be included in the supplied stock replay.

A source tagged as `kr-annual-signal-year-research-v2` **cannot** be promoted to current-policy NAV; the original 2026-10-10 study used annual re-budgeting.

## Actual data inventory checked on 2026-10-12

| Input | Evidence and location | Finding |
| --- | --- | --- |
| KOSPI stock canonical | [Drive: Korean market source](https://drive.google.com/drive/folders/1a6g5i7XaBD77VqRvwhOm0vQW6rqkvTq5), `01_원천데이터/주식/백테스트_canonical/v1` | Directory exists; full corporate-action/PIT qualification is **not certified**. |
| KODEX 200 ETF 069500 | [Drive ETF v2.1](https://drive.google.com/drive/folders/1TTG5tbN-7looypeySf1XdzfmxiE52jGe), `cloudtrend_etf_research_20160712_20260918_v2.1.parquet` (70,169,637 bytes) | [symbol-level QA](https://drive.google.com/file/d/15kDAnE1ecmoDH1XQtLwsrdeHxtev-8Ne/view) shows 2,500 dates (2016-07-12 to 2026-09-18), 100% price coverage for 069500; TIGER 200 102110 also present. |
| Newer ETF raw | Supabase private `cloudtrend-data/{user_id}/research/adopted-full-period/inputs/f2f20f437e46276a44817f5ddc8d85d3b5287488b30109357a81c52eaf038107/sources/cloudtrend_etf_research_20160720_20260930_v3.3_qa1_official.parquet` | Storage object exists, 105,702,948 bytes. Not yet inspected at column/corporate-action level. |
| Existing KOSPI 2017–2026 daily NAV | Supabase private `cloudtrend-data/{user_id}/research/adopted-full-period/resumable/38016639367/replay-kr/attempt-1/result/KOSPI_STANDALONE_DIAGNOSTIC.daily-nav.jsonl` | Object exists (446,054 bytes); **historical annual-NAV-budget policy, not current fixed-capital policy**. |
| ETF distributions and certified total return | Existing ETF bars were sourced from Toss `candles adjusted=true` ([field dictionary](https://drive.google.com/file/d/1uv_yrMOAhq4ChJq9LS1_ejV4wFOWk2jh/view)). | **Unverified:** adjustment alone does not establish complete reinvestment of distributions. Do not call it total return without reconciliation. |
| Point-in-time market gate | [KOSPI gate code](https://github.com/Jiwoon625/cloudtrend/blob/main/src/lib/engine/kospiMarketGate.ts) | Logic exists, but historically complete as-of dated VKOSPI/realized volatility + index foreign flows + price observations **not validated**. |
| KRX sessions | Canonical history and [index membership reference](https://drive.google.com/drive/folders/1j7FAsO8aIxPhs4xEonqyRSICqGfxHKph) exist. | Need pinned, verified session-by-session calendar to detect missing dates. |

**Consequently no production-quality backtest or investment superiority verdict is authorized yet.** Files existing at a location, metadata, and old backtest summaries are not equivalent to verified replay inputs.

### Required next data operations (without replacing originals)

1. Re-run and QA the **October 12 adopted stock strategy** from source, retaining daily end-of-session equity, after-cost open holdings, cash, and invested fraction. Hash the code/config, source data, results; verify fixed initial-budget policy, current entry/exit ordering, PIT stocks/sector and corporate-action treatment. Do **not** copy the October 10 NAV into this input under a new label.
2. Reconcile official KODEX 200 distribution history against daily adjusted prices (or produce a separately audited total-return synthetic OHLC series with documented methodology), avoiding dividend double count. Confirm traded ETF choice and dates.
3. Reconstruct daily KOSPI gate statuses strictly from observations available by **that day's close**. UNKNOWN stays UNKNOWN. Preserve evidence and as-of timestamp, including 63+ session warmup.
4. Verify the exchange session calendar, common full-year coverage (2018–2025) and 2026 through 2026-09-11, and create hashed input CSVs with a *separate* signed-off provenance manifest.

These are prerequisites, not tasks silently solved by this analysis script.

## Five portfolios; first four are the requested primary comparison

| Arm | Implementation |
| --- | --- |
| `stock` | **Certified unchanged current-policy stock replay NAV**, normalized to KRW 100m before 2018 first session. |
| `etf_100` | KODEX 200 synthetic audited total-return units, 100% buy and hold. |
| `etf_vol_matched` | KODEX 200 + cash with **ex-ante** volatility target: previous 63 trading-day stock realized vol / ETF vol, capped [0,1], rebalanced at first trading **open** of each month. |
| `etf_gate` | KODEX 200 + cash with **previous-close** market-gate timing; RISK_ON/NEUTRAL -> ETF, RISK_OFF/UNKNOWN -> cash at next open. **This is a timing-control experiment, not exact replication of the stock strategy's entry-only restrictions.** |
| `etf_exposure_matched` | Additional selection-control experiment: ETF weight equals the previous-close stock strategy's verified invested fraction, transacted the **next open**. |

All ETF arms use 0.15% one-way simulated transaction cost, zero cash interest, no leverage, and synthetic fractional total-return units. **Synthetic ETF TR units are not actual ETF physical shares or a distribution ledger.** They are suitable for common risk-factor comparisons only after the ETF total-return and open/close adjustment have been certified. The stock NAV must already be after the same model trading costs.

## Research windows / statistical safeguards

- Full overlap 2018-01-02 .. 2026-09-11; calendar-year 2018–2024, **2025 standalone**, 2026 partial.
- For each arm: cumulative, 252-session equivalent CAGR, annualized volatility and Sharpe (cash rate assumed 0), maximum drawdown, Calmar.
- **Remove 2025 *daily returns* and stitch** (non-executable sensitivity), plus leave-one-**full**-year-out sensitivities for 2018–2025. Neither creates a hindsight-skipped live strategy.
- Every rolling 504-session window: share of windows in which stocks outperform ETF on cumulative return and Sharpe.
- Paired 20-session block-bootstrap confidence intervals for annualized mean **daily** excess return vs ETF arms. These are exploratory, not independent out-of-sample evidence; if 2025 does all the work or OOS is lacking, do not conclude genuine superiority.
- If any date, provenance, price, corporate-action sign-off, ETF total-return evidence, gate point-in-time sign-off or hash is missing, fail **before writing any output**.
- No publishing or running on CloudTrend's production web app; no unreviewed automatic deployment. Outputs stay private and user-owned.

## Input contract

A verified manifest (copy `manifest.example.json` to a **private** input directory and populate it after verifying all evidence) must pin **four SHA-256**-checked files and provenance:

| CSV | Required columns | Meaning |
| --- | --- | --- |
| `stock_nav.csv` | `date,nav,stock_exposure` | Certifiably current stock strategy end-of-day NAV (KRW), fraction 0–1 invested. |
| `kodex200_total_return.csv` | `date,open_tr,close_tr` | **Audited adjusted total-return OHLC** values (both adjusted to *identical* basis). No raw-close approximation. |
| `kospi_market_gate.csv` | `date,status,asof_date,available_after_close` | Each dated gate computed with no future observations; `asof_date` must equal `date` and `available_after_close=true`. |
| `krx_sessions.csv` | `date` | Audited unique official Korean market sessions, including >=64 pre-start days. |

The manifest has `stock_policy_id` fixed to `kospi-20261012-fixedcapital-e8-confirm1-u95-h60-v1`, as well as review flags, source manifest SHA-256, policy SHA-256 and evidence locators. These flags and strings record external reviewer sign-off, **not cryptographic proof that the underlying economic assumptions are correct**. Review underlying evidence separately.

Preflight:
```sh
python -m research.kospi200_comparison.engine preflight \
  --manifest /path/to/private/verified/manifest.json
```

Comparison (only if preflight succeeds):
```sh
python -m research.kospi200_comparison.engine run \
  --manifest /path/to/private/verified/manifest.json \
  --output "/content/drive/MyDrive/CloudTrend/한국시장/04_연구결과/기타_백테스트/KOSPI200_위험대비_최종검증"
```

The output directory must be on Drive if executing in Colab with Drive mounted. `summary.json` and `daily_nav.csv` are only written after success; maintain a separate copy of the input manifest and SHA list there for resumption/replay. For large actual replays, checkpoint the upstream stock replay in private storage/Drive before using this evaluation layer.

Synthetic, credential-free regression:
```sh
python -m unittest discover -s research/kospi200_comparison -p 'test_*.py' -v
```

The CI workflow runs **only synthetic tests**. Never upload portfolio NAV, raw sources, service-role keys, private Storage files or authenticated output as public GitHub commit / Actions artifact.

## Interpretation

A favorable stock CAGR alone is insufficient. Prefer a result where stock Sharpe/Calmar remains better than volatility-matched and exposure-matched ETF/cash **in 2018–2024, leave-one-year-out and rolling 2-year checks**, and where extreme drawdowns and bootstrap uncertainty are acceptable. Even that demonstrates historical conditional evidence, not a causal proof or future guaranteed return. The project is public; results should be stored in private Drive and optionally summarized in Notion only after audit.
