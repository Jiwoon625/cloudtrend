# Atomic screening source-set cutover

## Status and scope

The migration `20261006155556_atomic_screening_source_compaction.sql` was created
by discovered Supabase CLI 2.119.0 using `migration new`. It is a new, additive
function only. It has **not** been applied to production. No existing activation
RPC, table, policy, grant on a table, Storage object, or raw source file is changed
by the migration. Only `service_role` receives execution permission.

The RPC changes source-registry statuses and adds provenance during an explicitly
requested cutover. It never deletes rows, uploads/deletes objects, or rewrites raw
bytes. Parent `created_at`, `activated_at`, paths and hashes stay unchanged.

## RPC contract

`public.compact_screening_source_set(p_user_id uuid, p_operation_id uuid,
p_expected_sources jsonb, p_candidates jsonb, p_verification jsonb) returns jsonb`

Use `READ COMMITTED`, a trusted `service_role` client, and one operation UUID kept
unchanged through retries. A non-null JWT subject must match `p_user_id`.

Both descriptor arrays must contain **exactly** these keys for every element:

- `id`, `user_id`, `source_type`, `original_filename`
- `storage_bucket`, `storage_path`, `content_type`, `canonical_format`
- `file_size_bytes`, `normalized_size_bytes`
- `file_hash`, `data_hash`, `schema_hash`, `row_count`, `upload_source`
- `min_date`, `max_date` (required keys; nullable values)
- `created_at`, `activated_at`
- `storage_object_id`, `storage_object_version`

Registry descriptors are compared as typed PostgreSQL values. Timestamp spellings
are normalized to UTC. `storage_object_id` and `storage_object_version` must be
lowercase UUID strings matching the existing `storage.objects` row at the exact
bucket/path. The confirmed production types are `objects.id uuid` and
`objects.version text`; both carry UUID values. These columns and existing
service-role SELECT/UPDATE permissions were inspected read-only on 2026-10-06.
The existing `cloudtrend-data` bucket was confirmed private.

Parents must be the complete ordered active screening set, ordered by
`activated_at NULLS FIRST, created_at, id`. Duplicate parent activation/creation
timestamps are rejected because legacy readers do not have the final ID tie
breaker. Candidates must reduce the file count, have status `valid`, have never
been activated, have origin `migration`, and use canonical uncompressed CSVs.
Their validation must say `valid: true` and bind all three hashes. Both recorded
sizes must be positive and at most 47,185,920 bytes (45 MiB). Paths must have the
exact owner/source/screening/record-ID/filename.csv structure. Candidate array
order becomes activation order using one-microsecond timestamp offsets.

The verification object requires exactly these keys:

- `schema_version: 103`
- `algorithm: "screening-compaction-v1"`
- `source_fingerprint`, `candidate_fingerprint`
- `dataset_before`, `dataset_after`, `analysis_before`, `analysis_after`
- `timing_before`, `timing_after`
- `effective_rows_before`, `effective_rows_after`
- `config_hash`, `code_version`

Every hash uses `sha256:` plus 64 lowercase hex characters. Dataset, analysis,
and timing before/after hashes must agree, as must the positive integer effective row
counts. Candidate row counts must sum to the effective row count. Here 103 is the
actual canonical source column count; the original notebook's 102 input columns
are a different contract. Code version is a nonempty string of at most 200
characters.

**Trust boundary:** SQL checks exact registry and Storage-generation descriptors,
but does not download CSVs or run the TypeScript analyzer. The trusted caller
must verify every raw byte hash, canonical schema/data hash, all effective rows,
and full before/after analysis under the same code/config before invoking it.
Storage generation must be unchanged across those reads. Fingerprints use the
caller's canonical serializer and are stored in the receipt; SQL intentionally
does not hash `jsonb::text`, whose serialization differs.

## Transaction and retry behavior

The function takes a brief `SHARE ROW EXCLUSIVE NOWAIT` registry-table lock to
close direct-write/phantom-insert races, the same owner/screening advisory key as
`activate_analysis_source_file`, and ordered registry row locks. Storage object
rows are locked `FOR UPDATE NOWAIT`; the private bucket is locked `FOR SHARE
NOWAIT`. This prevents metadata overwrite/deletion and privacy changes during
the transaction without changing any Storage permissions. It does not make
Storage objects permanently immutable after commit.

The brief registry write barrier serializes registry writes across owners. Busy
locks produce SQLSTATE `55P03`; retry the identical request after the competing
transaction ends. The try-lock/NOWAIT pattern avoids waiting in the existing
activation RPC's opposite row-first/advisory-second lock order. Any failure,
including an update constraint or trigger failure after partial internal work,
rolls back the entire call.

All candidates store `validation_result.screeningCompaction`, including the
entire normalized request, parent IDs and all parent hashes/generations, candidate
IDs, commit timestamp, and candidate order. Parents retain prior validation and
receive `screeningCompactionSuperseded`. Their single `superseded_by` foreign key
points to the first candidate; the receipt carries the complete many-to-many
lineage, so that single FK is not the full provenance.

The response contains `operation_id`, `user_id`, `source_type`, `parent_ids`,
`candidate_ids`, `committed_at`, `verification`, `original_source_evidence`, and `reused`. An exact retry is
read-only and returns the same receipt with `reused: true`. Modified payload,
changed object generation, changed committed candidate order, partial state,
unexpected active rows, or reuse of an operation ID with different candidates
fails closed. A later legitimate append also means this old cutover can no
longer be treated as a current exact retry.

## Original source timing provenance

A candidate's new `activated_at` is the compaction order marker, **not** a new
collection or source-registration time. Readers must use
`validation_result.screeningCompaction.original_source_evidence` for source timing.
The same array is returned in the RPC response. Every entry contains exactly
`id`, `min_date`, `max_date`, `activated_at`, and `created_at`.

For a raw parent, these values come from its authoritative registry record.
For an already compacted parent, the function expands that parent's existing
original-source evidence instead of substituting the compaction activation time.
Repeated origin IDs are deduplicated in first-encounter parent/evidence order;
conflicting evidence for the same origin fails closed. Every inherited entry is
typed/UTC-normalized and checked against its retained original registry record,
with a NOWAIT lock, the same owner, and screening source type. Compacted rows
cannot appear as original leaf evidence. Missing/empty inherited evidence,
missing/cross-owner original records, changed timing values, or malformed evidence
are rejected. Null dates/activation stay null; `created_at` remains the original
fallback. No timestamp is inferred from this operation's commit time.

The trusted caller checks timing-projection parity and sends equal timing digests.
SQL binds those digests into the exact request receipt and checks authoritative
provenance. It does not reimplement the reader's timing projection or recompute
its digest. The timing reader changes and their integration tests must be deployed
with this RPC before a real cutover.

## Rollback plan

No cleanup or deletion is part of this operation. Preserve the manifest,
verification evidence, all parent bytes, and all candidate bytes.

1. Read the committed receipt from every candidate and verify they agree. Re-read
   the original raw files, verify their preserved hashes/generations, and rerun
   the original effective dataset/analysis checks before changing anything.
2. Prepare a separately reviewed rollback transaction with the same registry
   write barrier, advisory key, and NOWAIT registry/Storage locks. It must compare
   the complete current active set to exactly these committed candidates, compare
   every original and candidate descriptor/generation to the receipt, and reject
   any intervening ingestion or changed file. Never restore a stale manifest over
   newly ingested data.
3. In that one transaction, mark candidates `superseded` and restore the original
   parent statuses to `active` with `superseded_by = NULL`. Do not overwrite parent
   `activated_at` or `created_at`; preserving them restores the original source
   precedence. Keep all receipts and add explicit rollback provenance to both
   sides rather than erasing the cutover evidence.
4. Verify the exact restored active list and original analysis after commit.
   Retain both sets of bytes for inspection. Do not roll back by calling the
   single-file activation RPC repeatedly, because that exposes partial sets.

There is intentionally no new unrestricted rollback RPC or new audit table.
Production application, cutover, and any rollback remain separate from these
local implementation/test results.

## Executed verification

`python3 tests/screening-compaction-postgres.test.py --pg-bin-dir <postgres-bin>
--pg-share-dir <postgres-share>`

The test runner initializes a new loopback-only PostgreSQL cluster and accepts
no production URL or existing data directory. It replays the authentic source
registry and current activation migrations on synthetic auth/Storage fixtures.
The Storage fixture uses the production column types verified above.

45 real PostgreSQL 17.11 test groups passed, covering:

- SECURITY INVOKER, service-only execution, unchanged table ACL/RLS
- Atomic multi-candidate cutover, preserved originals, explicit activation order
- Stable read-only retry and changed-payload/current-state rejection
- Invalid hashes, verification, schema, counts, IDs, ownership, paths and sizes
- Storage generation changes/deletions, public bucket and concurrent object locks
- Injected late candidate-2 failure and silently skipped candidate update with complete rollback
- Real multi-session advisory, row-first activation and table-writer contention
- Old-set visibility before commit and complete new-set visibility afterward
- Direct/legacy writes, Storage version changes and bucket-public changes blocked
  during an uncommitted cutover
- Ambiguous legacy source ordering and malformed provenance rejection
- Repeated compaction lineage, deduplicated original evidence, authoritative
  timestamp verification, missing/cross-owner provenance rejection, and null timing fallbacks
- Repeatable additive migration application

These are real database transaction/concurrency tests, not merely static SQL
checks. They do not verify hosted PostgREST transport, the production dataset, or
remote Storage byte behavior; the independent orchestrator rehearsal must do so.

References: [Supabase database functions](https://supabase.com/docs/guides/database/functions)
and [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html).
