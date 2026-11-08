# Partial historical dashboard after an index-reference change

This is a read-only display improvement, not a new calculation or current trading signal.

## Admission

The certified prior/current cache version pair remains explicit. The first two reference snapshots are pinned by SHA-256. New reference dates must be valid, unique, ordered, and contain exactly the three supported indexes with unique constituent codes and matching counts. All source, configuration, and operational identity must still match the original fingerprint, and the complete original result digest must verify. Drive publications remain unsupported in this bridge. No projection is persisted.

When verified index membership changes, exclude changed symbols and stock rows whose saved official membership is unknown, dated differently, or different from the latest verified membership. Build the visible summary from the full remaining saved rows, retaining original scores and calculation date. Display exclusion count and reference date. Original market/sector values are historical full-universe values; visible stock counts are filtered. Current action panels remain off; strict screening admission is unchanged.

## Important limits

This is not generic per-stock isolation after a collection-source change. Such a change can affect market foreign-flow fallback, market turnover percentiles, sector breadth/synthetic returns, and cross-sector ranks. Existing cache stores whole-source fingerprints, not per-symbol dependency proofs. A source mismatch therefore still fails closed. A future engine/cache revision requires explicit compatibility certification. Equal-membership reference refreshes retain the previously certified historical display; they do not upgrade saved judgments.

No data collection, recalculation, ledger, source-registry, or stored historical result is modified by this change.

## Local verification (2026-11-08)

- Independent dependency-scope review and final code review: no blocking findings within this explicit scope.
- Dashboard integration 32 and scope/projection unit 7 tests passed (39 total).
- TypeScript and changed-file ESLint passed.
- Verified full original result immutability, unchanged strict reader, no compute and no storage writes in compatibility mode.
- Production publication/verification is a separate authorized step; this report does not claim deployment.
