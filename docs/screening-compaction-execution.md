# Verified screening source compaction

This is a one-time physical-source reorganization. It does not delete original
objects, change strategy formulas, run trades, or republish model journals.

## Invariants and scope

- The explicitly approved active ID/raw-hash snapshot must match before apply.
- Authenticate with the existing server credential in its existing runner only.
- Bind each raw byte hash to fresh Storage object ID/version before and after the
  origin read. Every download uses a unique cache nonce and `cache: no-store`.
- Validate source file/data/schema hashes with the current normalizer. Reuse a
  local proof only if generation, hashes, normalizer dependencies, Node/locale,
  proof version, local raw hash and canonical data hash all still match.
- Retain all 103 current canonical fields (the notebook's raw input has 102),
  latest nonempty enrichment and first-seen instrument metadata/order.
- Produce 38 MiB target chunks, never over 45 MiB, on real CSV row boundaries.
- Separately execute the real parser/full market analyzer/onset-profile layer
  for both original and candidate sets, under identical default configuration.
  Require dataset, sector dataset, full analysis, config and statistics parity.
- Also preserve original source collection evidence across all date ranges and
  repeated compactions. Physical activation is not new market-data collection.
- Upload candidates as inactive `valid` rows, verify their stored bytes, then
  invoke one exact-set transactional cutover. Retain originals and all receipts.

The verified calculation is the current screening engine and onset profiles.
It does not execute downstream history/cache/journal publication. Those normal
readers preserve collection provenance through `sourceTimingEvidence`.

## Preferred execution: existing GitHub Actions runner

The `CloudTrend screening source compaction` workflow is manually triggered only.
It requires the repository owner on `main`, and accepts either a validated manual
dispatch or the exact approved command in existing control issue 16. It has no
schedule or pull-request mutation path. Only the final execution step receives
the existing Supabase secrets; dependency installation and tests run beforehand.

The executable checks that the reviewed RPC is installed before large reads,
then checks the expected active snapshot. All validation/parity must finish before
staging. An intervening ingestion, object replacement or metadata change causes
the exact-set cutover to fail closed.

No raw or canonical CSV, detailed source manifest, or receipt is exported as a
GitHub artifact. Only aggregate progress is printed. Detailed metadata and exact
retry arguments are saved under the same owner's private
`results/compaction/<approved-snapshot-hash>/` prefix. On runner restart, those
arguments are restored only after matching owner, snapshot, operation, parents
and candidate IDs. Restore alone never authorizes a write.

## Local/Colab fallback

Use the same code through `scripts/run-screening-compaction.ts` with the isolated
`vitest.compaction.config.ts`. Do not use `vite-node --script`: the installed
version discards the provided Vite configuration in that mode. Use explicit
`node --max-old-space-size=4096`; analyzer children forward only the validated
heap flag and a small non-secret environment allowlist.

`--apply` requires `--expected-source-hash`. A run without `--apply` prepares and
verifies locally without remote writes. `--retry-cutover` requires the same
expected hash and replays only the saved exact arguments. A prepared/staged
operation preserves candidate IDs across retries; candidates are never silently
overwritten or deleted.

The optional Colab launcher is released separately with a pinned code-only ZIP
hash. It uses the existing Colab Secret, installs lockfile dependencies before
reading that secret, retains CSVs only on local disk, and saves only sanitized
logs/allowlisted metadata to the user's existing private Drive folder. The source
template deliberately refuses to run until its release ZIP hash is filled in.

## Storage accounting

Reducing active files reduces repeated input work. It does not reclaim retained
original storage: physical usage temporarily increases by the candidate size.
Never describe this operation as deleting old files or freeing disk space.

## Validation limits

Synthetic parser/full-analysis parity, guarded command/restore behavior, local
launcher tests, and real PostgreSQL rollback/race tests are separate from the
eventual production-data proof. Completion requires the hosted job's actual
before/after digests and a readback of the exact new active set, with original
objects still retained. Do not infer success from upload progress alone.
