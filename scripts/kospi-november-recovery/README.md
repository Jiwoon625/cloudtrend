# Exact November KOSPI retrospective continuation

This separate repair is bounded to the existing dedicated KOSPI Shadow revision's
2026-10-29 state, followed by 2026-10-30 and 2026-11-02, in that order. It is not a
collector change, a new capital baseline, a strategy change, or a general fallback
that accepts late data as pre-open evidence.

The ordinary pre-open admission path remains unchanged. Both missing dates lack
the required morning refresh. Any approved append is explicitly retrospective,
retains the actual source and computation clocks, and sets
`historicalAvailabilityClaim: false`.

## Evidence and computation

The private preparation binds the complete ordered registered source manifest,
exact file bytes and logical identities, current source object generations, the
entire original and corrected journal, and the prior October 28/29 plan, approval,
and completion. The old approval establishes historical lineage only.

The pure core replays the stored October 28/29 inputs under the current unchanged
economic engine, validates the new October 29 boundary, and compares complete
October 30/November 2 snapshots and projections from original and reconstructed
predecessors. A priority-cache-only difference is accepted only when the existing
economic guard and all continuation outputs prove equivalence. Historical tags
are removed only from disposable comparison copies after lineage verification.
The actual append always begins with the full original tagged October 29 state.

Missing, changed, ambiguous, or non-equivalent evidence blocks preparation. A
blocked result has no operational approval path. General adopted KR/ETF, US,
integrated, and actual ledgers are outside this repair's write scope.

## Publication and retries

Only a separately approved exact preparation, output plan, writer commit and
writer runtime may be used by the manual, serialized recovery workflow. The
writer uses the existing `kospi-prospective-shadow` concurrency group. VALIDATE
does not publish. APPLY permits only the two absent immutable snapshots and the
recoverable latest projection in the existing private revision namespace.

Writes are sequential, not a transaction. Every existing prefix must match the
approved plan exactly. An uncertain write gets one exact readback and then stops;
it is never blindly retried. A later explicit retry may reuse an identical prefix
or repair its projection, but cannot overwrite a different session or skip ahead.
Before/after checks preserve the original journal and all unrelated ledgers.

## Verification

- `npx vitest run scripts/kospi-november-recovery`
- The build and startup smoke test validate the executable transport separately.
- A synthetic test pass is not evidence that the production plan is equivalent or
  that the live append completed. Production completion requires authenticated
  readback of both exact snapshots, the final projection, and preservation checks.

Do not commit private capsules, source rows, owner identifiers, credentials, or
production plan payloads to this public repository.
