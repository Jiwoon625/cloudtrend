# Original preliminary screening evidence

The owner approved restoring the stored October 26 result as preliminary
evidence. `screening_recovery_evidence` is a separate, owner-readable table.
It is never consumed by the daily confirmed history writer, ledger writers,
Shadow replay, allocation, or performance calculation.

The history list and instrument detail select an explicit
`KR_ORIGINAL_RECOVERY` source. They verify the frozen date, calculation time,
strategy version, original object path, source SHA256, size, source commit,
publication phase and no-financial-side-effects flag. The existing compressed
snapshot reader also verifies its uncompressed SHA256. Both pages label this
source as preliminary; reading it cannot promote it to a confirmed signal.

Existing archived/daily records take precedence for the same identity. The
recovery detail cache has its own source key. Schema deployment precedes
the application release; permission or transport errors are shown explicitly.

For an insert, verify the original bytes against the pre-deletion receipt and
the original `analysis_runs` metadata/configuration. Stop if confirmed history
has appeared or the same recovery ID contains different evidence. Preserve
the original calculation time and let `created_at` record the actual recovery
registration time. Do not copy private source bundles into Git.

Validation uses the synthetic CI fixture by default. To validate the approved
private projection locally, set `CLOUDTREND_RECOVERY_SNAPSHOT` to its absolute
path and run `vitest --config vitest.recovery.config.ts`.

## Archive error typing review

The release's scoped TypeScript check exposed four TS4111 errors already on
main in `scripts/archived-storage.ts`. The fix changes `e.statusCode`,
`e.status`, `e.code` and `e.message` to the corresponding literal bracket
accesses. The receiver, property names, nullish fallback, conversions and
branch predicates are identical. Archive transport tests pass (31 tests).

The generated KOSPI runtime graph was compared with main: its only changed
raw source is `scripts/archived-storage.ts`. The exact regenerated digest is
recorded under `archive-error-typing-equivalence-20261107`. No calculation,
historical input, collector, freshness check or authorization branch changed.
