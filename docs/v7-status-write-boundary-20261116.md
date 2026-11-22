# v7 data-status publication boundary fix (2026-11-16)

## Defect and observed impact
PR #421 added `cache/data-status/<publicationId>.json` and `cache/data-status/latest.json` writes without permitting them in the v7 transport boundary. Isolated stub transport reproduced `Drive validation blocked supabase-write` on current main 846588c. The publisher writes head/caches before status, then archive/receipt, so the defect can interrupt a partially published generation.

Latest observed production v7 run #59 / 43812381551 completed successfully on earlier commit315c9ee, before PR421. No post421 operational execution was observed during inspection. This is a demonstrated code defect, not a claim that the latest published result already failed.

## Narrow correction
The publisher passes its exact generated publicationId and calculated runId into a callback after preflight and immediately before its first write. The v7 guard permits only that owner's exact status artifact and pointer in addition to the previously approved output paths. Another owner/generation, arbitrary neighboring path, PATCH/DELETE and raw-source/database mutation remain blocked. Re-enabling a different run clears prior status grants.

No scoring strategy, raw source, actual trading ledger, or production result was recalculated or changed. No operational workflow was dispatched/retried. Deployment only changes application/code for future authorized runs.

## Verification
- Independent review of the callback boundary and negative permission coverage.
- Root TypeScript and drive-history-specific TypeScript checked separately (root excludes CLI scripts).
- 125 targeted v7 tests pass, including publisher callback order, rejection before any write, runner generation propagation and owner/generation/method negative tests.
- New regression test included in v7 pull-request CI.
- Existing concurrent gzip test compared completion order although uploads run concurrently. Changed assertion to the exact unordered path set, preserving cardinality/content protection.
- Build and deployment status are recorded in the private development note after release verification.

## Explicitly outside scope
PR421 P2s remain: compare status against current screening generation/digest; compute source quality from unfiltered journalDataset. This patch does not claim to fix them or make multi-object publication atomic.
