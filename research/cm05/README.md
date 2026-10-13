# CM05 isolated research

This implements the approved 2026-10-13 Notion CM05 A–D study. It is an
exploratory historical-current-vintage comparison, not historical PIT certification
or live trading. It never changes operational screening or the CM06 workflow,
inputs, checkpoints, or candidate registry.

## Execution and isolation

`cm05-research.yml` uses its own GitHub-hosted Ubuntu 24.04 VM and concurrency
group, one worker and one BLAS thread. A job is bounded to 90 minutes. There is
no schedule, restart loop, public artifact or public dataset cache. A change to
`REQUEST.json` on main represents one explicit bounded request. Existing
repository Supabase secrets remain in Actions; they are never exported.

The resource probe observed four CPUs, 16,373,452 KiB physical memory and
approximately 90 GB free disk. A previous comparable CM06 batch used 87% of one
CPU on average and 1,585,808 KiB peak RSS. Those are process averages/peaks, not
live utilization. CM05 runs on a separate VM. Account concurrency and shared
Storage throughput remain shared limits.

## Private data and source identity

- CM monthly normalized inputs and reference-time archives are restored by the
  existing hash-pinned, safe extraction reader, read-only.
- KR's 29 canonical files use the existing adopted-full-period source catalog.
  The catalog identifier is NOT the byte hash of its derived transfer manifest.
  Each actual Parquet file is independently checked against its own SHA256.
- US uses the expanded 2015–2026 price partitions, not the survivor-only v0 set.
  Original byte hashes are recorded before calculating performance.
- The Drive r2 mapping is pinned by SHA256 in `CONTRACT.json`. Its one-file
  authenticated import endpoint was closed after verification. The older expanded
  mapping is retained only for a difference report.
- Outputs use immutable create-only objects under private `research/cm05/results`.
  CM05 has no write method for the upstream KR/US inputs. No service key is logged.

## Build and analyze

`build.py` executes source reconciliation, calendars, canonical index extraction,
sector mapping reconciliation, sector panels, frozen-rule candidate collection and
5/20/60-session candidate outcomes. It invokes the existing KOSPI confirmation,
KOSDAQ onset and A0 analysis functions on complete session cross-sections. It
collects candidates before holdings, capital and slot restrictions.

`analyze.py` consumes a completed build by its run ID and verifies every output
hash against the completion manifest. This allows statistical work to resume
without replaying source or signal calculations. Partial files are not a completed
build: only the create-last `completion.json` marks readiness. A failed build can
be manually retried under a new run ID; current build internals do not claim
cross-run row-level resume.

Analysis produces 56 registered C hypotheses and six D comparisons, maintaining
the family size when some sectors have too few observations. Primary inference
uses the reused 2022–2024 validation period, 63-market-session whole-date block
bootstrap (499 draws), and BH FDR. 21-session blocks are a sensitivity diagnostic.
Discovery, individual 2025/2026 and pooled reused histories are descriptive
checks, not previously unseen OOS. C includes local sector, market, FX and global
SPY controls; for US targets SPY is already its local benchmark and is not added
twice. D reports full observed baseline, common-source baseline, selected/rejected
outcomes, unavailable outcomes, missed outperformers and avoided absolute losses.

A request can use `build`, `analyze` (with a completed `build_run_id`), or
`build_and_analyze`. The last mode runs these two stages sequentially in the same
bounded job, and does not restart on error. US Parquet native dates and numeric
strings are normalized before calendar alignment. Unmapped original A0 candidates
remain in the baseline with source coverage missing; they are not silently dropped.

## Deliberate distinctions and limits

- KR C is a pooled stock-weighted sector basket. Each stock's excess uses its
  own KOSPI/KOSDAQ index. This resolution was registered before results.
- Daily basket compounding and median constituent factor values are distinct.
- No implicit zero return, forward-filled endpoint, deferred entry, or invented
  last-quote liquidation. Fixed-horizon missing endpoints remain censored. The
  existing last-valid-close liquidation exception belongs to portfolio E and
  requires a separately labeled path, not a fabricated fixed-horizon observation.
- D uses the next market open with positive volume. Delayed halt resumption,
  partial fills, position limits and portfolio exits belong to E.
- Latest sector classification remains static-vintage. Low-coverage sectors are
  unavailable, not zero. The source universe and ticker identity limits remain.
- Candidate effects are not portfolio CAGR or NAV. E requires a separate
  baseline-parity-tested portfolio adapter, so these scripts do not claim E done.

## Verification

Run `PYTHONPATH=research/cmresearchengine:research/cm05 python -m unittest
 discover -s research/cm05 -p 'test_*.py' -v` on one line. Tests cover no-future and
stale-source joins, open-entry compounding, missing observations, fixed market
session endpoints, duplicate keys, mapping priority, and fixed FDR family sizes.
All additions are research-only. Existing CM06 files remain untouched.
