# US3.8 — Robustness / Overfitting Gate

This folder contains preliminary, non-reoptimized diagnostics from the frozen US3.5/US3.7 outputs. It is **not a completed validation gate**. The seven Sharadar Prices Full History CSVs are present in Drive `미국주식데이터` and the manifest marks all seven complete. US3.3 generated `canonical_feature_inputs.parquet` from Sharadar history, and US3.5/3.7 already use these features and Sharadar full-history prices with corporate-action correction revision 3. The connector’s 256 MiB limit is only a transfer limit. Strict historical listing/category/ticker reconstruction still needs validation. A separate Colab notebook and runner now cover the missing fixed Core/Beta/rebalance surfaces and candidate/control parity. The notebook is in the Drive research folder; its first run is waiting on Google passkey verification. Until that run and the strict PIT replay complete, the gate remains incomplete.

## Frozen candidate set

The six US3.5 candidates and three existing controls were preserved. No candidate was promoted and no parameter was changed.

## Run the available-output diagnostics

Place `US35_results.zip` and `US37_results.zip` next to this README, then run:

```bash
python analyze_existing_outputs.py
```

The script computes start-date slices, rolling windows, available historical surfaces, post-hoc contribution diagnostics, a 10,000-draw paired moving-block bootstrap with max-T intervals, and a fixed-nine-choice CSCV/PBO lower-bound diagnostic. It does not replay orders, rebuild daily returns, or pass the PIT gate.

## Limitations

- Start-year results are slices of a continuous 2017 portfolio path; they are not fresh-cash replays. The authentic 2023 fresh-cash results are quoted from US3.7.
- Rebalance intervals are existing calendar week/biweek/month/bimonth/quarter definitions, not an exact fixed 5/10/20/40/60 trading-day schedule.
- The available Core grid is 50/55/60; the required 45 point is missing. The beta exit threshold and persistence grid is incomplete.
- Ticker and sector attribution uses the 2026-09-27 mapping snapshot. It is not historical sector membership. Contribution shares are not counterfactual portfolio reruns.
- PBO uses only the fixed six candidates plus three controls. It does not capture all earlier feature, entry, exit, portfolio, or sizing trials. DSR is therefore withheld.
- Current US3.3 expanded-universe tests are survivorship diagnostics, not full point-in-time universe results.

The supplementary runner is `colab/run_us38_surfaces.py`; the notebook is `colab/US38_Robustness_Overfitting_Gate.ipynb`. It writes only to `US38_robustness_gate_20260928` and does not modify US3.5/3.6/3.7 outputs. It first asserts parity for nine frozen candidate/control paths, then exports diagnostic-only surfaces. See `PRELIMINARY_REPORT.md` and `data_revision_audit.json` for the present status and available evidence.
