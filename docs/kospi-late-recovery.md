# Isolated KOSPI late execution

This adapter appends only to the existing validated correction namespace. It does not initialize a series, change frozen engines, replace past sessions, or touch actual/adopted ledgers.

The next regular Korean market open is the input cutoff, not a substituted computation time. Every historical source must be present in an exact-date persisted screening result's ordered manifest and in the pre-cutoff registry membership. Raw bytes, logical data, schema, aggregate dataset version and configuration are verified before computation. Ambiguous later registry edits, missing bytes or an incomplete manifest fail closed. Only the existing policy's morning source window is admitted.

## Manual recovery

1. Dispatch KOSPI Shadow with `recovery_mode=dry-run`, ascending comma-separated `recovery_dates`, no `as_of`, and initialization disabled.
2. Review `KOSPI_LATE_PLAN_VERIFIED`: authoritative predecessor, exact dates, source/runtime digests, state hashes and bounded trade/NAV summaries. The dry-run uses a memory overlay; it never writes storage.
3. Dispatch `recovery_mode=apply` with the same dates and the reviewed `expected_plan` digest. The publication runtime must still be admitted. A request-only commit and changed actual clock do not change the economic plan digest.
4. Require `KOSPI_LATE_PUBLICATION_VERIFIED` and successful authoritative journal/latest readback. A failed run is not proof of no write. Inspect the journal before retrying.

Writes are sequential and append-only, not a multi-session transaction. If one session was stored before a later failure, the old plan is rejected because the authoritative predecessor changed. Run a fresh dry-run against the current journal and review its new digest. Existing identical sessions are reused, never duplicated. Do not initialize or bypass continuity to repair a partial run.

## Automatic late runs

After the normal decision window closes, the ordinary runner selects the exact persisted pre-open source set for the latest closed session and uses the same verifier, memory simulation, predecessor check and append-only publication. It never uses the current later source set as historical evidence. Missing dates still block publication and require ordered recovery; automatic late execution does not backfill unknown sessions.

Snapshots retain actual execution SHA and actual `computedAt`, input `dataCutoffAt`, historical evidence run, ordered source manifest and runtime digests. The reader displays the retrospective label and both clocks. Logs contain compact diagnostics, not private source rows or secrets.
