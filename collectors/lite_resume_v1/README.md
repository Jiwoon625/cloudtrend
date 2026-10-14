# Lite resume v1 — review preview

This is a separate, opt-in collector bundle. It preserves `lite_r3`, its published
ZIP, external KR reference ZIP and all strategy/registry contracts. It is **not a
production replacement** until the remaining integration checks below pass.

The bundle adds a content-addressed Drive run journal, frozen start time and
configuration, independently hashed stage dependencies, persistent KR frame
caches, exact-day KRX stock/ETF enrichment, US dated atomic inventory and explicit
31-session dispatch batches. Current US metadata is saved once per request and
never fetched on a later calendar day to complete an earlier partial snapshot.
Missing historical roster/non-price evidence remains WAITING_INPUT. Existing
server DATED_ROSTER_RECONSTRUCTION validation is retained; no new historical
provider or automatic schedule is introduced.

`ALLOW_OPERATIONAL_WRITES=False` is the notebook default. It suppresses KR publish
and US upload/archive/dispatch. Read-only operational status queries and private
Drive collection/checkpoint files are still used. Setup stages run again to
reconstruct Python state; valid provider checkpoints are reused. A stage-finished
journal entry alone never certifies a server calculation or publication.

## Run and resume

Use an exact published commit and the ZIP SHA256 in `release.json`. Never load
from a moving branch. Keep settings unchanged and leave `RESUME_RUN_ID` blank to
continue the active run, or select its saved ID. `NEW` explicitly creates a new
plan without deleting previous state. Do not use NEW to bypass a pending request.
Changing runtime/configuration fails closed; source revisions require a separate
review. A stopped Colab must be started by the user.

Do not run VF and this preview concurrently. A local advisory lock prevents two
processes from changing one journal; Drive/FUSE cross-runtime lock behavior has
not been verified. Do not infer a distributed lock guarantee from local tests.

## Verification and remaining gates

- Unit tests cover state corruption, interrupted atomic writes, configuration and
  runtime identity, lost-response readback, calendar/holiday/DST planning, exact
  daily stock/ETF joins, frozen metadata, and same-filesystem process locking.
- Existing US replay, October Shadow and allocation suites remain the authority
  for model ordering, partial model retry, publication-only recovery and boundary
  protection. This package does not change model stepping or any golden contract.
- A clean ZIP-only import is not a clean Colab end-to-end run. Actual authenticated
  KR/ETF/US collection, reset/restart and evening-to-morning refresh remain open.
- The US inventory is wired into collection. KR date expansion is wired into the
  existing supply probe and exact-day enrichment; complete per-model KR input
  readiness and historical universe audits remain a server/real-data gate.
- The generic calendar and allocation planner is tested, but is not a replacement
  for the existing server calendar or allocation orchestrator.
- No new loader for a historical non-price provider is supplied. Saved atomic
  inputs work through existing contracts; missing historical evidence cannot be
  recovered using today's roster.
- Component fault tests do not establish all end-to-end interruption points:
  actual CSV interruption, Colab reset, Drive synchronization, dispatch transport,
  live partial-model persistence and all connected UI views still require a
  controlled integration exercise.
- Same-day lifecycle/price changes are fail-closed or explicitly revisioned; a
  complete automatic dependency invalidation flow is not yet certified.

Keep using the existing VF as the default. Before approving any operational run,
specify dates, markets, request IDs and immutable input hashes. No database reset,
replay deletion, original overwrite, schedule, merge or deployment is part of
this preview. Rollback means stop the preview and return to the unchanged VF;
preserve pending receipts and review them before any resend.

## Local commands

```sh
python -m unittest discover -s collectors/lite_resume_v1 -p 'test_*.py'
python collectors/lite_resume_v1/build_release.py
```

The deterministic ZIP embeds the unchanged base runtime and separate overrides.
`resume-manifest.json` checksums every embedded Python file. The private notebook
and private source evidence must not be committed to the public repository.
