CloudTrend Exit Risk Research — 2026-10-14

Research only. No production table, live ledger, Shadow, CM05/CM06 checkpoint,
main merge or deployment is part of this package.

Reproduce with Node 24.19.0 (verified runtime), Python 3.12, pandas 2.2.3,
numpy 2.3.5, matplotlib. Extract the code ZIP and the relevant market input ZIP(s)
into the same study directory. ETF has two input ZIPs; extract BOTH.

1. python restore_inputs.py
2. In official-history: npm ci --ignore-scripts --no-audit --no-fund
3. In study root: python run_matrix.py file candidates_kospi.json
   or: python run_matrix.py file candidates_etf.json
4. Baselines, if not yet run:
   python -c "from run_matrix import run; run('KOSPI',{'id':'K0','currentExecution':True})"
   python -c "from run_matrix import run; run('ETF',{'id':'OFF'})"
5. python baseline_compare.py KOSPI K0
   python baseline_compare.py ETF OFF
6. Extra sensitivity batches: candidates_kospi_extra.json / candidates_etf_extra.json.
7. python analyze_results.py KOSPI ; python analyze_results.py ETF
   python sensitivity_analysis.py KOSPI ; python sensitivity_analysis.py ETF
   python make_report.py KOSPI ; python make_report.py ETF

The runner validates configuration, code and input hashes before reusing a
strategy COMPLETE.json and verifies every recorded output byte/hash. It skips
only an identical completed strategy; failed strategies have no completion
marker and can be run again. It does not rewrite an incompatible completed
strategy. Use a fresh output directory or a distinct run id when code changes.

For Colab or another temporary host, set EXIT_RESULTS_BACKUP_DIR to a mounted
Google Drive checkpoint folder before running. Each independently verified
strategy is copied to a code-hash-specific folder and finalized by rename.
Run with EXIT_WORKERS=1 for constrained memory; 2 was used after profiling.
EXIT_NODE_OPTIONS=--max-old-space-size=2500 is sufficient for the bounded ETF
runner. KR was verified at 3000 MiB old-space. These are V8 heap limits, not
total process RSS limits.

Historical signals are the hash-bound official current-rule cache from run
38016639367. They are not recomputed from saved generic scores. Thirty original
Parquet sources, fifty-six exact prepared source files and all twenty signal
cache segments were verified. Code fingerprints and source/price parity
receipts accompany the outputs. Original large sources remain in their existing
canonical locations; no raw source or original CM checkpoint was modified.

All years were reused historical research data. 2018–2022 is a reused development
block, 2023–2024 a reused validation block, and 2025/2026 separate diagnostics.
Leave-one-year-out re-links daily returns; it is not a new account that skips
trading during that year. E4's extra sensitivity was selected after seeing the
full historical comparison and is explicitly exploratory.

Source adjustment/distribution and raw execution-price completeness are not
certified. Current-universe/sector metadata leave survivorship/selection bias.
The partial historical ETF liquidity universe covers a 370-code union, with
28 codes absent from the current price panel; product eligibility remains to
be assessed for these codes. The research is capped at 2026-09-11.

Pre-optimization source snapshots are retained under provenance/ for the
recorded initial runs. Later changes indexed repeated searches, bounded the
stream, reused a date formatter, and strengthened resume verification. The
baseline economic results exactly match the stored official run.
