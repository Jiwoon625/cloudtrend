# US3.8 — Robustness / Overfitting Gate

**Status: INCOMPLETE — no Production conclusion.** This is a preliminary audit of the frozen US3.5/US3.7 result files. All six candidates and three controls remain unchanged. This report does not promote a new parameter.

## A. Executive Summary

1. 과거의 높은 CAGR 차이를 구조적 Alpha라고 단정할 근거는 아직 없습니다.
2. 저장된 Core 표면에서 B3 55:45는 50:50·60:40 사이의 뚜렷한 단일 봉우리입니다.
3. A0 주기 표면은 비교적 완만하지만 A2 분기 성과는 주변 주기보다 낙폭과 비용에 민감합니다.
4. 실제 2023 신규 현금 시작에서는 B3 55:45가 후보 6개 중 5천만원 6위, 1억원 5위였습니다.
5. 여러 후보의 상위 5종목 기여가 누적 P&L의 52~73%이며, IT_HW 매핑 섹터 기여도도 큽니다.
6. 21·63일 block bootstrap 동시구간은 후보와 기존전략 차이를 구분하지 못했습니다.
7. 고정 9개 선택지 CSCV의 PBO 진단값은 53.6%로, 순위 선택 위험을 뒷받침합니다.
8. 비용 50bp에서 여러 후보의 수익률과 낙폭이 크게 악화됩니다.
9. Sharadar full-history 가격·특징 입력은 US3.5/3.7에서 이미 사용됐지만, 완전한 PIT universe 재구성과 이번 정확한 민감도 재실행은 아직 없어 **ROBUST 후보는 없습니다**.
10. 가장 높은 과거 CAGR은 신뢰도 높은 기대수익률로 읽으면 안 됩니다.

## B. Baseline Reproduction

### Frozen run and parity evidence

US3.5의 `US35_results.zip`은 2,442거래일, REAL 1%, 왕복이 아닌 편도 비용 0.25%, ADV20 최소 $500,000, 최근 20일 활동, 정수 주식, 최소 주문 $10, 최대 20종목, 기업행사 대금 5일 지연을 사용합니다. 기본 현금은 $100,000이며 수익을 재투자합니다. 2017~2026-09 구간은 이미 후보 선택·비교에 사용된 과거 자료입니다.

US3.5의 저장 parity 표는 US3.4와 겹치는 14개 경로에서 일별 최대 차이 0, 주문 한도 위반 0을 기록했습니다. US3.7은 9개 2017 시작 대조 경로를 US3.5와 비교해 최대 일별 차이 0을 기록했고, US3.7 완료 파일은 45회 계산(2023 신규 시작 36회 + 과거 경로 9회), 933일, 한도 위반 0으로 되어 있습니다. 이 자료는 저장된 완료 기록을 재검토한 것으로, 이번 작업에서 45회 전체 시뮬레이터를 다시 실행한 것은 아닙니다.

### Six candidates: saved 2017-start REAL 1% paths

| Candidate | CAGR | MDD | Sharpe | Annual turnover | SPY CAGR | Excess CAGR |
|---|---:|---:|---:|---:|---:|---:|
| A0 quarterly | 24.04% | -48.21% | 0.745 | 8.25x | 15.35% | +8.69pp |
| A0 every two months | 23.16% | -45.61% | 0.731 | 8.57x | 15.35% | +7.81pp |
| A2 quarterly | 26.43% | -58.42% | 0.800 | 8.85x | 15.35% | +11.08pp |
| A2 weekly | 22.34% | -53.94% | 0.724 | 12.92x | 15.35% | +6.99pp |
| B3 Core 55:45 | 29.03% | -51.05% | 0.853 | 7.62x | 15.35% | +13.68pp |
| B3 beta <0.60, 3 days | 24.52% | -46.09% | 0.732 | 12.51x | 15.35% | +9.17pp |

Annual turnover is purchase plus sale notional divided by NAV. The exact legacy control values and all yearly records are in `outputs/frozen_path_metrics.csv` and `outputs/annual_returns.csv`.

### Order, residual, and event controls

The preserved US3.5 order audit reports no participation-cap violations. Across the six candidate paths, partial-order counts range from 5,946 to 17,348; rejected orders from 104 to 348; the backlog audit shows pending items on 962 to 1,329 days and maximum pending ages of 26 to 89 trading days. These are nonzero execution frictions, not cosmetic details. The frozen files record fees, terminal corporate-action events, residual values, and accounting error; US3.5’s max accounting residual was about $6.98e-10 in the validation run. The U.S. source’s 11 verified corporate-event corrections were retained in revision 3. This preliminary work has not independently replayed those events.

## C. Robustness Plateau

### Core weight

Only the existing REAL 1% B3 runs at ret120 weights 50%, 55%, and 60% are available. CAGR/MDD/Sharpe were 19.03%/-57.40%/0.645, 29.03%/-51.05%/0.853, and 21.29%/-47.25%/0.697, respectively. The 55% value is 10.00pp above 50% and 7.74pp above 60%. This is consistent with a narrow peak, not evidence of a 50~60% plateau. The required 45% point is missing; no parameter is re-selected.

### Beta exit

Stored runs include threshold 0.40/0.50/0.60 with 3-day persistence and threshold 0.50 with 2/5 days. The frozen 0.60×3 candidate has CAGR 24.52%, MDD -46.09%, Sharpe 0.732. For comparison, 0.50×3 has 24.20%/-49.15%/0.747; 0.40×3 has 27.56%/-58.09%/0.818; 0.50×2 has 15.39%/-49.04%/0.564; 0.50×5 has 25.15%/-54.09%/0.752. These are not the requested complete 0.55/0.60/0.65 × 2/3/5 surface. Persistence neighbors are at a different threshold, so the surface cannot validate 0.60×3’s local stability.

### Rebalancing frequency

Existing frequency definitions are calendar week, biweek, month, bimonth, and quarter boundaries. They approximate the requested economic cadence but are not identical to fixed 5/10/20/40/60 trading-day intervals.

| Policy | Existing frequency sweep CAGR range | MDD range | Annual turnover range |
|---|---:|---:|---:|
| A0 | 18.48~24.04% | -47.48~-45.61% | 8.25~11.81x |
| A2 | 21.48~26.43% | -62.08~-53.94% | 8.85~12.92x |

A0 is relatively smooth in MDD; return changes with cadence but there is no isolated dramatic high point. A2 quarterly is the local CAGR high and weekly has a smaller MDD, while bimonthly has the worst MDD. Its surface is less stable. These previously run values are diagnostics, not new optimization results.

## D. Start-date and Rolling Stability

### Start date

The 2017-start daily output was sliced at each later calendar year and rebased mathematically. This is **not** a valid fresh-cash backtest: holdings, pending orders, and the execution path were inherited from the 2017 portfolio. Those rows are retained only as path-dependence diagnostics and are not used to claim fresh-start stability.

The relevant fresh-cash evidence is US3.7: all 2023 starts had cash only, used prior data only to warm up signals, had no prior holdings/orders, and used the same pending-order rules as REAL 1%. With fixed KRW/USD 1,500, the $33,333/$66,667 starting-account results were:

| Candidate | 5천만원 CAGR / MDD | 1억원 CAGR / MDD |
|---|---:|---:|
| A0 quarterly | 35.59% / -39.84% | 36.25% / -37.26% |
| A0 every two months | 34.40% / -39.91% | 40.26% / -37.76% |
| A2 quarterly | 58.61% / -44.41% | 56.77% / -43.07% |
| A2 weekly | 60.65% / -40.03% | 52.01% / -35.36% |
| B3 Core 55:45 | 15.02% / -50.78% | 19.37% / -51.73% |
| B3 beta <0.60, 3 days | 22.18% / -43.31% | 18.89% / -43.30% |

The ordering changes materially: B3 55:45 falls from the top long-horizon candidate to rank 6/6 at KRW50M and 5/6 at KRW100M. The new-start CAGR is not comparable to the legacy account’s full-period CAGR as if only the start date changed; account scale and fresh order path also changed. This is strong evidence that the historical winner label is path- and execution-dependent.

### Rolling windows (overlapping windows, descriptive only)

From 2017 REAL 1% paths, 3-year (756-session) and 5-year (1,260-session) windows were evaluated every 21 sessions. The overlapping windows are highly dependent.

| Candidate | Window | % windows beating SPY | Median CAGR | Worst CAGR | Median MDD |
|---|---:|---:|---:|---:|---:|
| A0 quarterly | 3y / 5y | 74% / 91% | 22.7% / 20.4% | -2.8% / 5.7% | -36.4% / -38.3% |
| A0 every two months | 3y / 5y | 70% / 84% | 21.2% / 17.6% | -0.9% / 6.6% | -36.7% / -37.5% |
| A2 quarterly | 3y / 5y | 73% / 84% | 21.8% / 17.5% | -15.7% / 9.3% | -42.0% / -57.9% |
| A2 weekly | 3y / 5y | 67% / 75% | 21.0% / 16.4% | -12.5% / 8.3% | -39.6% / -53.9% |
| B3 Core 55:45 | 3y / 5y | 84% / 98% | 31.4% / 28.5% | -9.6% / 10.2% | -45.6% / -46.9% |
| B3 beta <0.60, 3 days | 3y / 5y | 94% / 98% | 31.5% / 27.0% | -0.6% / 12.8% | -41.9% / -46.0% |

These rolling statistics still use the expanded but non-PIT history and inherit survivorship/data limitations. They do not establish prospective performance.

## E. Return Attribution

The saved P&L attribution is a post-hoc decomposition from the $100K path. It is not a counterfactual replay with a stock or sector removed.

| Candidate | Top stock | Top 5 stock P&L share | Top 10 share | Largest mapped sector | Sector share |
|---|---|---:|---:|---|---:|
| A0 quarterly | QUBT | 57.1% | 86.5% | IT_HW | 53.5% |
| A0 every two months | QUBT | 59.1% | 88.2% | IT_HW | 56.4% |
| A2 quarterly | QUBT | 64.1% | 95.6% | IT_HW | 46.2% |
| A2 weekly | LITE | 70.9% | 106.8% | IT_HW | 49.9% |
| B3 Core 55:45 | LITE | 52.3% | 84.6% | IT_HW | 28.9% |
| B3 beta <0.60, 3 days | BATL | 72.7% | 106.7% | IT_HW | 43.0% |

Top-10 shares above 100% mean losses elsewhere offset positive contributors. The mapping snapshot is dated 2026-09-27, so sector shares are not point-in-time sector attribution. Exact top-five ticker lists are retained in `outputs/concentration_diagnostics.csv`.

### Year concentration diagnostic

Removing a year from the daily log-return chain and annualizing over remaining sessions gives a diagnostic, not a re-run of the portfolio’s capital allocation. The most influential year reduced CAGR as follows:

| Candidate | Year removed | Share of total log growth | CAGR after removing year |
|---|---:|---:|---:|
| A0 quarterly | 2019 | 33.6% | 17.3% |
| A0 every two months | 2019 | 35.2% | 16.2% |
| A2 quarterly | 2024 | 41.8% | 16.5% |
| A2 weekly | 2024 | 36.4% | 15.4% |
| B3 Core 55:45 | 2020 | 30.9% | 21.7% |
| B3 beta <0.60, 3 days | 2020 | 38.9% | 16.1% |

The attribution confirms meaningful dependence on a handful of names, the IT_HW grouping, and particular years. True leave-stock-out, leave-sector-out and re-simulated return jackknives remain pending.

## F. Statistical Uncertainty

### Paired block bootstrap

The preliminary bootstrap uses 10,000 paired circular moving-block resamples at 21 and 63 sessions, seed 3821/3863. The paired statistic is the difference in annualized CAGR between the saved daily paths. A max-T family-wise interval adjusts all 15 candidate-vs-own-baseline, within-policy, and candidate-vs-SPY comparisons together. It is a bootstrap on saved history, not a re-simulation of orders.

For the 21-day blocks, every individual 95% interval for a candidate versus its existing strategy includes zero. All 15 simultaneous intervals include zero for both 21- and 63-day blocks. Example point differences and 21-day intervals:

| Comparison | Point Δ CAGR | Individual 95% CI | Simultaneous max-T 95% CI |
|---|---:|---:|---:|
| A0 quarterly vs A0 existing | +4.9pp | -1.4 to +13.2pp | -6.2 to +15.9pp |
| A0 two-month vs A0 existing | +4.0pp | -2.4 to +12.0pp | -6.9 to +14.9pp |
| A2 quarterly vs A2 existing | +11.0pp | +2.9 to +21.9pp | -3.6 to +25.5pp |
| A2 weekly vs A2 existing | +6.9pp | +1.7 to +12.6pp | -1.4 to +15.2pp |
| B3 55:45 vs B3 existing | +10.0pp | -3.7 to +25.7pp | -12.3 to +32.3pp |
| B3 beta exit vs B3 existing | +5.5pp | -10.1 to +22.5pp | -19.0 to +30.0pp |

The individual intervals are not multiple-testing corrected. The simultaneous intervals are the decision-relevant comparison and do not establish improvement.

### CSCV PBO and DSR

CSCV splits the history into 10 chronological blocks and tests all 252 ways to select five in-sample blocks. The in-sample winner’s out-of-sample rank is below median in **53.6%** of splits; median relative rank is 44.4%. This is a lower-bound diagnostic over only the fixed six candidates plus three controls. It does not reconstruct earlier feature/entry/exit exploration and is not a genuine untouched OOS test.

DSR is withheld. The historical scenario counts are 395 in US3.4 and 116 in US3.5, but they contain repeated execution environments and overlapping variants; they are not a defensible count of independent strategy trials. Assigning them as if independent would create a spurious precision. The present bootstrap/PBO evidence is already insufficient to call a winner.

## G. Execution Robustness

### Cost and participation stress (2017-start $100K paths)

| Candidate | REAL1, 25bp one-way CAGR / MDD | REAL5 CAGR / MDD | 50bp one-way CAGR / MDD |
|---|---:|---:|---:|
| A0 quarterly | 24.04% / -48.21% | 15.98% / -45.49% | 17.26% / -50.34% |
| A0 every two months | 23.16% / -45.61% | 15.81% / -44.69% | 18.69% / -47.96% |
| A2 quarterly | 26.43% / -58.42% | 21.93% / -56.55% | 22.68% / -58.30% |
| A2 weekly | 22.34% / -53.94% | 21.79% / -51.91% | 14.15% / -60.92% |
| B3 Core 55:45 | 29.03% / -51.05% | 29.46% / -45.91% | 19.26% / -60.78% |
| B3 beta <0.60, 3 days | 24.52% / -46.09% | 25.36% / -45.21% | 19.15% / -55.28% |

The 50bp stress weakens every candidate’s CAGR and often worsens MDD. B3 55:45 has particularly poor cost stress, which is material to its apparent historical return advantage.

### Capital scale and actual 2023 fresh starts

US3.7 ran all six frozen candidates, three controls, KRW50M and KRW100M starting cash, REAL1 and participation-only-disabled modes, with the same pending-order handling in both modes. The exact 2023 fresh-start results are shown in section D. At both account sizes A2 variants lead while B3 55:45 is last/near last. Capital size also changes the ordering within A0/A2 pairs. The 2023 window is used history, not new OOS.

## H. PIT Gate

**NOT PASSED / PENDING — raw full-history source is available; PIT reconstruction and strategy rerun are not complete.** The user clarified that the seven CSV files directly in Drive `미국주식데이터` are the full US-market universe. I verified `manifest.json`: plan `Prices Full History`, years `full`, all seven tables report `status=complete`, with snapshot creation 2026-09-27 03:57:52 UTC. The bundle comprises `stocks.csv` (3,167,196,337 bytes), `funds.csv` (1,114,713,626), `actions.csv` (49,568,954), `tickers.csv` (24,975,596), `metrics.csv` (3,819,669), `sp500.csv` (3,332,824), and `descriptions.csv` (93,778). The manifest explicitly warns that source tables have independent publication times and are not one synchronized database snapshot.

The available source materially improves PIT readiness: `tickers.csv` has 74,272 security rows and includes `permaticker`, ticker, exchange, `isdelisted`, first/last price dates, and sector/industry fields; `actions.csv` contains dated corporate actions and counter-ticker fields; `sp500.csv` contains dated membership actions. This is broad historical coverage including delisted securities, but the snapshot fields alone do not establish historical listing eligibility or time-varying sector classification. `metrics.csv` is not yet verified as an as-of historical feature panel and must not be used as such without date/availability checks. Historical ticker continuity, eligible-equity filters, action adjustment, missing-price gaps, and sector history still require validation.

The earlier statement that no Sharadar input was present was incorrect. The US3.3 validation created `canonical_feature_inputs.parquet` (841,727,873 bytes) from Sharadar history. US3.5 `prepare_us34.py` loads this feature file together with raw `stocks.csv`, `funds.csv`, `actions.csv` and mapping v2; the price setup builds the replay marks from Sharadar full-history prices and applies the 11 verified event corrections in revision 3. US3.7 inherits the same price arrays and controlled pending-order behavior. Thus existing US3.5/3.7 results are already Sharadar-based expanded-universe results, not legacy-only results. They are not yet certified as a complete strict-PIT universe: current snapshot category/status fields, historical listing eligibility, ticker continuity, action timing and sector history still need audit. The connector’s 256 MiB materialization and executor’s 32 MiB transfer limits are transfer constraints; Colab Drive mounting can read the original files without staging individual large CSVs.

Therefore Sharadar full-history source availability and use in US3.5/3.7 are **CONFIRMED**. Strict PIT universe reconstruction, reconciliation/QC, and a replay of the frozen nine settings on that reconstructed revision remain **NOT PASSED / PENDING**. A separate US3.8 Colab notebook and runner have been prepared in Drive, but its first run is blocked at Google passkey verification; no new US3.8 surface or baseline-parity output has yet been computed. No Production candidate can pass this research gate yet.

## I. Candidate Classification

| Candidate | Preliminary class | Reason |
|---|---|---|
| A0 quarterly | INCONCLUSIVE | Smooth MDD across the available frequency sweep, but max-T interval includes zero; 2019 contributes a third of log growth and the top five names 57%. |
| A0 every two months | INCONCLUSIVE | Similar results to quarterly and no convincing statistical separation; cost stress is material; same name/year concentration. |
| A2 quarterly | PROMISING BUT SENSITIVE | Good saved CAGR/Sharpe and many rolling windows beat SPY, but MDD reaches -58%, 2024 is highly influential, cost/period effects remain, and adjusted uncertainty includes zero. |
| A2 weekly | PROMISING BUT SENSITIVE | Smaller MDD than A2 quarterly in the base path, at substantially higher turnover; cost stress and recent account sizes alter ranking. |
| B3 Core 55:45 | REJECT / DIAGNOSTIC ONLY | Narrow 55% peak, 2023 fresh-start rank deterioration, large cost sensitivity, and material single-name/year concentration. Keep only as a frozen diagnostic comparator. |
| B3 beta <0.60, 3 days | PROMISING BUT SENSITIVE | Saved MDD improvement versus B3 control is plausible, but high turnover, incomplete local surface, high top-five concentration and PIT absence prevent validation. |

No candidate meets **ROBUST**. This classification is provisional because major required inputs and surfaces are still missing.

## J. Next Gate

1. Continue the separate Colab runner after Google account passkey verification, first checking daily baseline parity for the fixed six candidates and three controls. The runner writes only to `US38_robustness_gate_20260928`; existing US3.5/3.7 outputs are read-only.
2. Run the missing pre-specified 45% Core weight, exact 0.55/0.60/0.65 × 2/3/5 beta exit grid, and exact fixed-session cadence surface. Keep all diagnostic points unpromoted.
3. Build strict historical membership/ticker/status and sector revisions from the available full-history sources, freeze hashes and publication snapshots, then replay the same nine fixed settings against that separate PIT revision. Do not call current mapping v2 fully PIT.
4. Validate historical active-universe reconstruction from price coverage, delisted status, permaticker/ticker history, and dated corporate actions; then re-run the frozen 9 settings on that revision. Until this is complete, PIT performance remains pending.
5. Complete true stock, year and sector jackknives and compare with the existing attribution-only diagnostics. Do not alter production or `main` from this stage.

## Source and output manifest

- Notion research set reviewed: all 10 current rows in `Cloud Trend → 개발노트_미국`, including US V0~3.2, US3.3 studies, US3.4, US3.5, US3.6 and US3.7.
- Simulator anchor: `b4d47858bccd5b732b88af9b14368ac9581e770a`; US3.5 frozen follow-up and US3.7 controlled pending-order logic.
- Data: Sharadar full-history prices/features already used in US3.5/3.7; verified event correction revision 3; US3.7 mapping snapshot `20260927_r2`; strict historical membership PIT incomplete.
- Preliminary analysis outputs: `outputs/` CSV files and `data_revision_audit.json`.
- Code: `analyze_existing_outputs.py`; Colab runner/notebook under `colab/`; README describes inputs and limitations. Colab execution is currently pending Google passkey verification.
