# Exact Nov3 retrospective recovery

This separate continuation is fixed to the existing revised KOSPI Shadow's
2026-11-02 predecessor and the single absent 2026-11-03 session. It does not
change ordinary admission, economic rules, the original journal, completed
sessions, source registration, or actual trades.

Nov3 sources were registered after the following morning's opening cutoff.
The plan therefore preserves real source/capture/computation clocks and marks
`historicalAvailabilityClaim: false`. The completed Oct30/Nov2 capsule, approval,
and terminal receipt establish lineage only, never authority for Nov3.

The pure certificate authenticates that completed historical proof and replays
its full tagged Oct30/Nov2 prefix under the current engine. It binds those outputs
to the live captured journal, validates the Nov2 economic boundary, and compares
the complete Nov3 continuation against both reconstructed boundaries. Only
priority-cache differences with full continuation equality are admissible.
Anything else returns BLOCKED with no approvable plan.

## Controlled official workflow

- PLAN: captures all active owner-scoped source bytes with hash and before/after
  generation checks, full journal objects, source/model/actual preservation
  snapshots, and referenced KR archives/vintage rows. Raw files remain in the
  runner's private temporary directory. Computation runs without credentials
  or network. Only the compact private capsule (or blocked diagnostic) is
  archived. PLAN reports the proposed authority hash but does not archive it.
- AUTHORIZE: after independent review, dispatch the exact capsule and proposed
  authority hashes. It rematerializes/reproduces the plan and archives that
  separately reviewed authority. It cannot write a Shadow journal.
- VALIDATE: reproduce again and check all live boundaries, without journal writes.
- APPLY: only after verifying a successful official VALIDATE run for the exact
  commit/capsule/authority. It revalidates independently, appends only Nov3 plus
  its latest projection, reads back the result, preserves all old objects, and
  archives a completion. A partial or uncertain write stops immediately.

The VALIDATE-before-APPLY sequencing is an operator requirement, not a stored
prior-run gate. Keep the successful VALIDATE run ID with the reviewed plan. No
mode automatically invokes APPLY. All modes share the existing serialized
`kospi-prospective-shadow` concurrency group.

No raw CSV, credentials, private owner data, or full plan is printed in logs or
uploaded as a public artifact. Workflow logs contain fixed statuses and hashes.
The shared source capture can also feed a separately reviewed KR companion
planner without fetching source bytes twice; that planner has its own write
allowlist and cannot expand this KOSPI writer's scope.

## Verification

Run `npx vitest run scripts/kospi-nov3-recovery`,
`npx tsc --noEmit -p scripts/kospi-nov3-recovery/tsconfig.json`, and
`node scripts/build-kospi-nov3-recovery.mjs`. The build binds actual writer bytes,
including the workflow and lockfile, and rejects network-capable pure bundles.
Synthetic tests are not production proof. Completion requires the authenticated
production plan, successful exact validation, apply readback, and preservation.
