# 2026-09-30 screening OOM: diagnosis and regression evidence

The main-branch runs [36669546074](https://github.com/Jiwoon625/cloudtrend/actions/runs/36669546074) (`fdf6e7450cff39d916276b1c15db768141dcd84b`) and [36670802381](https://github.com/Jiwoon625/cloudtrend/actions/runs/36670802381) (`aabc2d82cf8048c629b728e807cd6fd7c3e50a8b`) exhausted Node's default approximately 4 GiB heap and exited 134 in `Run screening and dashboard snapshot`.

## Measured cause

[Baseline instrumentation run 36672981090](https://github.com/Jiwoon625/cloudtrend/actions/runs/36672981090) reproduced exit 134 on the unchanged input-loading path, before `inputs-loaded`, parsing, analysis, or bundle serialization. The failure therefore was not caused by the final bundle serialization in these executions.

For one 33,836,342-byte input, `heapUsed` rose from 120,786,272 bytes before validation to 795,587,552 after record parsing, 1,183,480,552 after normalization and 1,445,023,448 after generating both canonical and sorted CSV. The parallel loader retained each completed input's 102-column normalized rows and canonical text while validating additional files. The last GC reported approximately 4,046.5 MiB live heap. Later serialization was an additional avoidable allocation risk, not the observed first failing stage. Expanding ETF coverage and forcing a cache miss exposed this existing allocation pattern; scoring/mapping formulas need no change.

## Changes

- The screening CLI opts into compact source loading: validate registered files sequentially; keep all existing file/data/schema hash checks, canonical normalization and activation order; discard normalized validation rows after each file.
- Compact CSV validation visits rows directly rather than retaining the delimited table and raw record-object array. JSON/XLSX and default registration-validation behavior remain compatible. The same normalizer produces the same rows, hashes, warnings and statistics.
- Raw cache merging keeps encoded canonical rows keyed by symbol/date. It preserves all 102 columns, first-key insertion order and latest-source whole-row replacement without rebuilding a market-wide set of 102-property objects. The 45 MiB raw-cache cutoff and kr.json metadata are unchanged.
- A scoped analysis helper releases the raw parsed-dataset reference after full-universe analysis. Source texts and canonical payload references are cleared after cache publication and before chart preparation.
- Write a compact, chunked JSON bundle to disk, then stream that same file to the existing result object path. The schema version, JSON values, key names, single bundle, latest pointer and run record remain unchanged; whitespace is reduced. Cache digest algorithms and cache publication behavior are unchanged.
- Optional `SCREENING_MEMORY_PROFILE=1` emits stage memory checkpoints and process `maxRSS`. No heap-limit expansion, dependency changes, mapping changes or scoring changes.

## Actual Actions verification

[Fixed run 36673749668](https://github.com/Jiwoon625/cloudtrend/actions/runs/36673749668) completed `--upload --force` on Node 22 with the default heap. It processed 14 registered sources, totaling 268,971,564 bytes, including the full 1,171-ETF universe.

| Check                                   | Evidence                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Maximum process RSS                     | 3,455,752 KiB = 3.296 GiB                                                                                      |
| Highest heap checkpoint                 | 1,595,326,552 bytes = 1.486 GiB; this is a checkpoint maximum, not a claim of continuous heap-peak measurement |
| Latest data date                        | 2026-09-29                                                                                                     |
| Screening universe                      | 1,785 = 614 stocks + 1,171 ETFs                                                                                |
| Passed / failed                         | 1,179 / 606                                                                                                    |
| Grade A / B                             | 13 / 24                                                                                                        |
| Summary entry/priority onsets           | 0 / 0; exact existing result digest matched                                                                    |
| Cache regression                        | `regressionMatched: true`                                                                                      |
| Stored cache round trip                 | `roundTripVerified: true`                                                                                      |
| Result digest, identical to prior cache | `07c5ccb2f921d9af640f01e209b819057507799cb78ec75dccdcbc6b89c76a8c`                                             |
| Input fingerprint                       | `8b09b3a571c797e9cb9efa99ca21e3cb317610bc51d3bc38a9f8afd3206dc292`                                             |
| Raw-cache cutoff                        | `rawPath: null`, raw bytes 0; existing over-45-MiB behavior retained                                           |
| History/run/result publication          | Upserts and streaming bundle/latest uploads completed before chart preparation                                 |
| Charts                                  | Price publication and warming completed without an isolation warning                                           |

Screening cache, dashboard cache and kr.json metadata were published; the full result was re-downloaded and hashed with the unchanged deterministic digest algorithm. Matching the prior full-result digest is stronger than matching candidate counts alone.

## Regression tests

`npx vitest run --config vitest.screening-memory.config.ts`: **99 tests pass**. Coverage includes legacy/streaming validation equality (quoted multiline CSV, BOM/tab aliases, duplicates/conflicts, invalid data, header-only/empty/malformed input and JSON fallback), loader ordering and hash rejection, 102-column raw merge parity, full analysis/candidate/cache digest parity, chunked serialization/file upload, 1,171 ETF mappings, operational strategy, history as-of behavior, dashboard contracts and card/chart parity.

CLI failure-injection tests verify that both price-publish and warming failures are isolated after history/cache/result/run publication. Cache publication failure remains fatal; completed identical runs reuse without recomputation.

`node --test tests/cloudtrend-command.test.mjs` and `node tests/workflow-contract.test.mjs` pass. Repository-wide `tsc --noEmit` remains blocked by **67 existing diagnostics**: baseline and fixed diagnostic lists are identical after normalizing source line numbers, with zero new diagnostics. This is not reported as a clean repository typecheck.

PR-only live verification is restricted to the same-repository owner-authored `fix/screening-oom-20260930` branch. It uses the existing Actions secrets; they are not copied locally or exposed in logs. Main has not been merged or deployed by this repair task.
