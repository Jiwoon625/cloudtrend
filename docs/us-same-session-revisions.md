# US same-session reference revisions

## Scope and invariants

A repeated collection of the latest completed US trading date may produce revised OHLCV and derived screening features. This path publishes a **reference-only** latest screener and instrument view. It never changes `us_screening_ingest`, `us_screening_history`, dated original results/manifests, prior model state, Shadow books, actual trades, holdings warnings, saved entry plans, order previews, notifications, or execution requests.

The original canonical `cache/us-screening/*` remains the operational source. Only the screener and instrument-detail pages opt into the new reference loader. Those pages label revision signals as reference-only and export `operationalSignalEligible=false`. Existing actual plans must not be inferred to have adopted the revision.

## Collector contract

Store immutable objects in the existing owner-private `cloudtrend-data` bucket:

- `{owner}/us-screening-revisions/{date}/{revision SHA256 hex}/input.csv`
- same directory `source.json`

The source has version `us-same-session-source-v1`, userId, date, originalDataHash, revisionDataHash, collectedAt, rowCount, symbolCount, and metadata. Hashes use `sha256:<64 lower-case hex>`; the manifest hash is over its raw bytes. No new credentials or sharing grants are introduced.

`collectedAt` is fixed across retries (collector uses the frozen run start as a conservative collection-order timestamp, not the later upload/retry time). Reusing the same CSV hash reuses the exact original manifest. Collection time does not assert vendor data finality.

Allowed source changes are OHLCV, dollar volume, ret120/252, beta60_spy, ichimoku_tk_gap, relvol1_20, adv20_usd, amihud20 and active20. market_cap may additionally change only to the new close multiplied by the **unchanged original shares_outstanding**, within 1e-10 relative tolerance. Identity, listing status, source shares, FX and other fields stay original. Lifecycle exclusions must equal the already-reviewed original set. New lifecycle policy changes use their separate review path, never this one.

All active rows require valid positive OHLC, correctly ordered high/low and nonnegative volume. Explicit missing-price quarantines retain blank price/return fields; scoring holds retain blank long-return fields. Any exclusions or holds require `sourceCoverageComplete=false` and validated evidence. The current completed original date/hash/manifest and original prior-session rank-state must exist. No earlier revision becomes a model predecessor.

## Publication and atomic selection

Dispatch `us-same-session-revision.yml` with `supabase_user_id`, `source_manifest_path`, `source_manifest_hash` after immutable upload and readback. The configured owner must match. The workflow is main-branch only, serialized with ordinary US runs by the existing `us-prospective` concurrency group. The CLI refuses execution outside that workflow.

The pure screening engine produces three compact views in one immutable artifact:

`{owner}/results/us-screening-revisions/{date}/{revision SHA256 hex}/bundle.json`

After exact readback, original identity and pointer are rechecked. One mutable pointer commits the selection:

`{owner}/cache/us-screening-revisions/latest.json`

Pointer version `us-same-session-pointer-v1` contains userId, date, originalDataHash, revisionDataHash, collectedAt, bundlePath and bundleHash. Bundle version is `us-same-session-bundle-v1` with the same identity plus view, screening and summary. No engine state is included. Bundle bytes are content-hashed. Same-hash retries are no-ops; older timestamps and same-time conflicting hashes are rejected. If write status is uncertain, read the exact pointer/bundle before retrying.

This is **serialized publication, not database/storage CAS**. All permitted writers must use the named workflow. It does not claim protection against unrelated privileged storage writers bypassing the application.

Browser readers validate owner/path/hash, all view projections, dates/rules and original identity. A canonical newer trading date always wins. Missing/corrupt/stale revision data falls back visibly to the canonical original without presenting it as the latest revised result. Failure before pointer commit preserves the prior selection.

## Review and release

Run `npx vitest run --config vitest.us-revision.config.ts` and `npx tsc --noEmit -p tsconfig.us-revision.json`, plus affected US UI/replay suites. Collector upload/dispatch is released only together with the deployed workflow and reviewed browser code. This PR itself does not publish a revision, rerun models, change production data, or merge/deploy automatically.
