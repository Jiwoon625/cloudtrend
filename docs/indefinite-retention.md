# Indefinite record retention

The daily Korean screening records in `screening_history` have no age/count
expiry. The homepage still queries the newest 90 dates. This is a display limit,
not a database retention limit. Apply
`supabase/migrations/20261003011711_indefinite_screening_retention.sql` after the
historical schema to remove `keep_90_snapshots` and its deletion function.

The migration does not delete or rewrite records, backfill unknown history,
change RLS/grants, touch actual portfolios, or run any screening/model engine.
It has short lock/statement timeouts and no cascading object deletion. Unexpected
dependencies stop the migration. A repeat application is harmless. Rollback must
not restore automatic pruning of accumulated records.

## Source and result boundaries

- Korean registered source files use unique `source/<type>/<source-id>/...`
  objects with upload replacement disabled. Source replacement changes registry
  status to `superseded`; it does not delete that source object.
- US prospective collector inputs use `source/us-screening/<date>/<hash>.csv`,
  replacement disabled and verified readback. Daily US result/manifest paths and
  the KOSPI Shadow journal retain prior dates without a TTL.
- Korean screening result bundles use per-run result paths and contain source,
  code, configuration, and result provenance. They have no age cleanup job.
- `latest` caches, merged raw caches, and legacy input pointers are mutable
  serving copies, not archives. Keeping the authoritative source/result records
  does not require preserving every overwritten cache byte.
- Existing same-date Korean snapshot replacement and explicit user-requested
  deletion remain unchanged. This policy removes automatic age/count expiry; it
  does not claim an immutable revision audit of every legacy UI operation.
- GitHub Actions diagnostic artifacts still expire at their existing 14/30-day
  limits. They are not the canonical Supabase source/result/journal store.

No storage-tier upgrade is performed. Capacity limits can stop future writes;
such a failure must be reported, never resolved by silently deleting old records.
New adopted/alternative model-series initialization and daily execution are a
separate integration task. This migration does not activate those models.

## Verification

```
npx vitest run --config vitest.history.config.ts
python3 tests/retention-postgres.test.py --pg-bin-dir /path/to/postgres/bin
```

The PostgreSQL test initializes a disposable loopback-only cluster, uses
synthetic owners, and proves preservation beyond 90 dates, unchanged existing
rows/RLS/grants, owner isolation, same-date behavior, bounded homepage reads, and
idempotent migration. It never accepts a production database connection.

For production, compare row count/date span/content checksum before and after;
verify the deletion trigger/function are absent and ACL/RLS definitions are
unchanged. Do not insert artificial trading-day records into production to test
retention. Record production application status and timestamp separately from
code/test completion.
