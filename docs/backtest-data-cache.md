# Backtest data and egress

Supabase holds the authoritative compressed source and results. Web screening uses only active `screening` sources and its screening/dashboard caches. The retired browser backtest loader rejects execution; registration no longer creates redundant legacy backtest JSON copies.

## Storage

`backtest-canonical-migration.yml` converts each active CSV into a ZSTD Parquet table (every original field retained as a string) plus a byte-exact `.csv.gz` transport for the existing TypeScript CSV parser. Parquet is available for column-oriented analysis; the current scoring engine intentionally continues to consume the identical CSV bytes after local decompression. This avoids a change in numeric, blank-value, symbol or scoring semantics. New CSV backtest registrations are immediately gzip-compressed; run the migration workflow to add their Parquet companion.

The migration verifies the source SHA-256, every Parquet cell through a roundtrip, registry row count, and both uploaded object hashes before conditionally switching the registry and deleting the raw CSV. Each file is independently resumable. The logical data/schema hashes and original filename remain unchanged. Only active registered sources are processed; unregistered ETF uploads are untouched.

## Actions cache

All long backtest workflows use `.github/actions/backtest-source-cache`. It queries registry metadata, computes an ordered key from source id, `data_hash`, `schema_hash` and logical CSV SHA-256, restores the exact or previous cache, verifies all local bytes, downloads only missing/corrupt objects and saves before experiments start. Physical gzip/Parquet conversion does not change the key. A new source can reuse existing verified files. Legacy file-hash caches can be reused during migration.

A warm run still queries small registry metadata and uploads results, but downloads zero source bytes from Supabase. Cache eviction, branch visibility restrictions or expiration can cause a compressed download. `downloadedStorageBytes` in the materialize log measures this explicitly. Actions Cache is not durable backup. Production backtest workflows share a concurrency group to avoid simultaneous cold fills; use the batch workflow for several experiments because GitHub concurrency keeps only one pending run.

## Batch

Run **CloudTrend V8 research batch** with comma-separated allowed script paths, for example:

```
scripts/run-v8-kospi-rsaccel-stage3-3fos.ts,scripts/run-v8-kospi-rsaccel-stage4-portfolio-3fos.ts,scripts/run-v8-kospi-rsaccel-stage5-regime-3fos.ts
```

The runner reads and verifies one pinned manifest, parses the dataset once, reuses the signal context for the same universe limit and runs selected studies sequentially in one process. Only experiment results are uploaded. `analysis-runs/batch-summary.json` records completion/failure; the job stops on the first failed study while preserving prior outputs and the source cache. Individual research workflows are now explicit manual dispatches rather than automatically re-running expensive experiments when code changes.

## Verification

- `npx vite-node --script tests/backtest-cache.test.ts`: gzip integrity, cold/warm cache, zero-download execution without Supabase credentials, physical-migration key stability, changed-data invalidation, corruption repair and same-instance data/context reuse.
- `python tests/parquet-roundtrip.test.py` with `pyarrow==21.0.0`: blanks, Unicode, embedded quotes/newlines, leading-zero/alphanumeric symbols and decimal precision.
- Stage 3/4/5 batch outputs were compared with pre-change individual runners on a generated multi-year fixture and matched completely after excluding generation timestamps.
- Web production build passed. Repository-wide `tsc` has pre-existing errors outside this change.
