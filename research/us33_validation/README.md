# US3.3 fixed-strategy expanded-universe validation

Eight configurations: aggressive/balanced × N15/N20 × original sector count cap/no cap. Rules are frozen; the 2023–2026 period was already reviewed during selection and is not untouched out-of-sample evidence.

## Private inputs and outputs

Do not commit data, sector-map records, trades, result CSVs, credentials, or notebook outputs to this public repository. The GitHub workflow `.github/workflows/us33-survivorship-control.yml` runs the unchanged prior engine against existing private inputs and writes results and detailed logs only to the verified private Supabase bucket. No Actions artifacts or input caches are created.

The expanded validation can run in Colab, a private local machine, or a suitably provisioned private runner. Set `US33_DATA_ROOT` to the directory containing stocks.csv, funds.csv, actions.csv, tickers.csv; set `US33_OLD_ROOT` to the existing US research directory; set `US33_RUNTIME_ROOT` to a writable scratch directory. Other input overrides are documented in prepare_validation.py. Defaults are the user's mounted Colab paths.

Copy these scripts into `${US33_DATA_ROOT}/US33_validation_20260927`. That private folder must also contain the frozen `sector_map_extended.csv` and `reference_prior_holdings_results.csv`. Run in a fresh scratch directory: prepare_validation.py → run_validation.py → run_sector_consistent.py → analyze_validation.py → audit_held.py. Dependencies: Python 3.12+, numpy, pandas 2.2.3, duckdb 1.3.2, pyarrow 23.0.1. Use approximately 12 GB RAM and enough scratch disk for the raw CSVs and DuckDB.

Primary output: consistent_validation_summary.csv and eight_strategies.csv. The `*_pit` datasets use historical exchange eligibility plus an approximate SIC crosswalk as supplementary controls. Their names do not imply complete point-in-time metadata. Primary `*_consistent` datasets preserve the existing v1.1 assignments and apply the same classifier to additional Yahoo records, then explicitly labelled provider proxies. Both have current/last-known industry limitations.

The corrected ledger requires positive-price, positive-volume execution quotes, locks unavailable holdings, and uses explicit cash. Known acquisition consideration is modelled as next-session cash equivalent, not a verified settlement date. Unknown terminal recovery is tested with locked-last-mark and zero-recovery alternatives. A zero-recovery scenario can alter subsequent holdings and is not a guaranteed lower bound for total strategy performance.

The scripts separate original-engine replication, feed/coverage changes, execution treatment, and same-source survivor-vs-full comparisons. Inspect held_security_audit.csv and held_terminal_assumptions.csv before interpreting results. `canonical_feature_inputs.parquet` contains auxiliary preliminary SIC classification; primary sector assignment comes from sector_map_extended.csv.
