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

Do not run VF and this preview concurrently. Actual two-VM testing on 2026-10-14
proved that Drive flock does NOT exclude the second VM. The new runtime therefore
requires a database guard on shared filesystems and fails closed if unavailable.
`collector_run_locks.review.sql` is a review-only proposal; building this ZIP does
not apply it. Until the table and live two-VM verification are complete, do not
use this new bundle for Drive collection. Local filesystem locking remains local.

The database guard has one immutable owner token per user and collector, no TTL,
no automatic takeover, and token-conditional release. Tokens stay on the VM,
never in Drive. Same-VM crash restart may reuse its token under a local lock.
After a lost VM, confirm that the former VM is terminated before explicitly
releasing its exact token; never delete a lock merely because it is old. A paused
VM could otherwise resume writing after an automatic lease takeover. A release
attempt retires its token before the request so delayed deletes cannot unlock a
later attempt. This guard does not protect VF or older preview versions that do
not participate. Stop those before starting the guarded collector.

## Verification and remaining gates

### Actual verification update (2026-10-14)

- A real same-VM Colab restart resumed from 308 completed instruments and finished
  all 1,790 instruments; actual CSV parser/compaction preserved all dated values.
- A different VM read and verified 9,812 content-addressed blobs, the frozen plan
  and CSV. This is readback integrity, not a complete new-VM collection resume.
- The simultaneous Drive flock exclusion test failed; the proposed remote guard
  above is locally tested but not yet installed or certified across real VMs.
- Ten saved KR/ETF model runs for October 12 and 13 were reproduced exactly,
  including ETF and KOSPI confirmation from the original registered source bundle
  and archived full analysis. This does not re-certify upstream indicator creation
  or all historical point-in-time coverage. A reduced-input ETF diagnostic mismatch
  is superseded by exact original-input reproduction.
- New provider fetches can differ from preserved dated prices. Preserve versions;
  do not replace historical evidence with a current adjusted-price fetch.

### Browser-deferred follow-up (2026-10-14)

- Re-running only the execution cell now keeps user settings separate from
  legacy stages' derived globals. The same saved run ID/time is reused after a
  setup interruption; changes to selected tickers, KRX options or write mode
  fail identity validation.
- ETF_ONLY reads only the ETF predecessor; STOCK_ONLY excludes the ETF book.
  Saved predecessor evidence is reused without a new server query. A selected
  missing predecessor still blocks instead of inventing an empty portfolio.
- A partial KRX daily response can no longer label another symbol's estimated
  market cap as official. Only exact symbol/date values receive KRX provenance.
- The pinned external KR adapter uses preview-owned daily response caches. Dates
  after the frozen predecessor get a fresh cache per resume attempt, while
  requests within that attempt share the existing day cache. Prior responses and
  VF caches are preserved. The provider's original shared usage counter remains
  in place, so this does not reset API request budgets.
- Dispatch journal entries preserve REQUEST_ACCEPTED / REQUEST_UNCERTAIN /
  WAITING_INPUT rather than treating a caught preflight error as COMPLETE. A
  skipped market has no completed-stage marker.
- `test_external_kr.py` loads the exact hash-verified private KR ZIP and tests
  reference-only evening responses, next-attempt refresh, CSV field preservation,
  original-cache preservation, shared budgets and HTTP 401 failures using mocked
  HTTP. This is external-runtime integration, **not live provider/Colab E2E**.

Use `CLOUDTREND_KR_RUNTIME_ZIP=/path/to/preserved.zip` with the test command below
to run the private-dependency tests; without it those three tests are skipped.
The old preview's runtime-bound journal must not be relabelled with the new ZIP
hash. Keep it intact and inspect pending requests before starting a new plan.

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
