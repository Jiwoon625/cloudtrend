# US3.8 — completed replay, strict PIT gate not passed

On 2026-09-28 the authorized Colab run completed 245 actual portfolio replays: nine frozen baselines, 173 diagnostic paths, and 63 stock/sector exclusions. Daily parity with US3.5 passed for all nine baselines before diagnostics ran (2,442 observations each, maximum absolute error 9.974659986866641e-17, tolerance 1e-10). Participation violations were zero across all cases. No candidate was promoted or retuned. Production/main were not modified.

The user-facing research report is in [Notion — 개발노트_미국 / US3.8](https://app.notion.com/p/3e9d908cac2f81798958f745cee40e2d?pvs=204). [Drive run folder](https://drive.google.com/drive/folders/1jgJMGxg6cwRVRJwdEPLY2ZnvlsTgYTMx) contains all daily paths, attribution, execution details, source audits and hashes. Selected derived evidence is preserved in `completed_run_20260928/`.

## Frozen design

- Candidates: A0 quarter, A0 bimonth; A2 Core 50:50 quarter, A2 Core 50:50 week; B3 Core ret120:ret252 55:45; B3 Core 50:50 beta rank <0.60 for three consecutive sessions.
- Controls: A0 existing, A2 existing, B3 Core 50:50 existing.
- Primary: REAL 1%, one-way cost 25bp, USD 100,000. US3.7 controlled pending orders persist identically in every comparison.
- Anchor `b4d47858bccd5b732b88af9b14368ac9581e770a`, corporate correction revision 3, mapping v2 `20260927_r2`.

## Executed calculations

- Core weights 45/50/55/60; beta .55/.60/.65 × 2/3/5; A0/A2 fixed 5/10/20/40/60 sessions. These are diagnostic-only and cannot become candidates.
- 63 genuine fresh-cash settings (nine 2017 baselines plus 54 starts in 2018–2023), 3/5-year overlapping continuous-path windows. Calendar boundaries and fixed-session schedules are distinct.
- Top 1/3/5/10 stock and sector contributions; 63 actual stock/sector exclusion replays with original ranks held fixed. Year removal is contribution-chain removal only, not a portfolio replay.
- 21/63-session paired circular bootstrap, 10,000 draws each, max-T approximation across 15 fixed comparisons; every simultaneous interval includes zero. Individual A2-vs-control intervals are positive.
- CSCV on only the frozen nine: 10 chronological blocks, 252 half splits. Standard r/(N+1), logit<=0 gives simple-return Sharpe PBO 67.86%; legacy log-return Sharpe 66.27%. Earlier 53.57% used log returns and excluded median rank through r/N. Neither is a global-search PBO or guaranteed lower bound. DSR withheld without defensible independent trial count.
- 108 capital/execution settings: USD100k, KRW50m/100m at inherited fixed1500 KRW/USD assumption × REAL1/25bp, REAL1/50bp, REAL5/25bp, participation-only unlimited/25bp. All use the same pending-order logic.

## Data gate and decision

All seven full-history Sharadar CSVs exist, as does US3.3 canonical_feature_inputs.parquet; US3.5/3.7 already used them. Dated listing/delisting/ticker/exchange/SIC actions exist and were audited. However, complete historical eligibility and effective classifications/ticker continuity plus publication vintages have not been certified. Every mapping row still has historicalTimelineComplete=false. metrics.csv is a one-row-per-ticker latest-observation snapshot, not a verified historical feature panel. The literal ticker NA is preserved in the audit parser; replay inputs were unchanged.

Strict PIT reconstruction and the same-nine replay on that separate revision are **NOT PASSED / PENDING**. No ROBUST candidate. Keep the simplest A0 existing research baseline and propose pre-registered prospective OOS. The full candidate rationale is in Notion and `candidate_classification.csv`; classifications do not promote new configurations.

## Reproduction

[Colab notebook with actual outputs](https://colab.research.google.com/drive/1aQDc2HGNQ8jXDeIN_p2LggqB_n2eYk-9). Source notebook in `colab/US38_Robustness_Overfitting_Gate.ipynb` launches `run_us38_gate.py`, requires parity, then exports review tables with `export_us38_review.py` after process completion. Repeat runs use a new timestamped folder strictly under US38_robustness_gate_20260928.

Actual runner/statistics commit: `628e1073c63d7b789a12d468638e894c5304035f`. Exporter commit: `5aa7a809812d786fded864041013ea38006ae531`. The source provenance and raw/feature hashes are in the evidence folder. Ten reference hashes matched before/after; the 59 downloaded review files and review ZIP matched Drive hashes. Four targeted helper tests passed; actual parity and all-case ledger checks are the primary verification.

`PRELIMINARY_REPORT.md`, `outputs/` and `analyze_existing_outputs.py` are historical preliminary artifacts, superseded by this run. Their missing-grid/auth-blocked status and old PBO convention are not current results. The old surface-only runner has been retired so it cannot bypass the baseline gate.
