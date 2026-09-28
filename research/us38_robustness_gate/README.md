> HISTORICAL PRELIMINARY ARTIFACT — superseded by the actual 2026-09-28 run in `research/us38-robustness-gate/completed_run_20260928/` and the updated Notion US3.8 page. Missing-grid/auth-blocked statements and the old PBO convention below are not current results. Strict PIT remains NOT PASSED / PENDING.

# US3.8 — Robustness / Overfitting Gate

This folder contains preliminary, non-reoptimized diagnostics from the frozen US3.5/US3.7 outputs. It is **not a completed validation gate**. No simulator rerun was possible because the full feature/price inputs are held in multi-gigabyte Drive files that this connector cannot materialize (the Drive fetch endpoint rejected `stocks.csv` at 3.17 GB against its 256 MiB limit). Sharadar/PIT collector code exists, but no processed Sharadar PIT dataset was found in the Drive folder.

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

See `PRELIMINARY_REPORT.md` and `data_revision_audit.json` for the present status and available evidence.
