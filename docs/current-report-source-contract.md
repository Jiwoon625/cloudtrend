# Current report source contract (2026-10-12 restart)

Current reports must use `loadCurrentReportContextForOwner` from
`src/lib/currentReportContext.server.ts`, or reproduce its exact identity and
integrity checks. This is a read-only reporting boundary, not a journal migration.
Existing Notion history, canonical executions, old model sessions, tax evidence,
and historical research remain preserved.

## Supported read-only entry point

With an existing trusted server environment and a verified owner UUID:

    npx vite-node --script scripts/read-current-report-context.ts --user-id <verified-owner-uuid>

The CLI uses the repository's existing trusted client. It only reads, prints a
compact JSON report, and never initializes a book, runs an engine, uploads data,
or writes to Supabase/Notion. Do not place credentials in command-line arguments
or commit its private output. The implementation can also accept an existing
owner-authenticated Supabase client. Read failures are errors, never permission
to substitute historical holdings.

## Four separate sections

- `marketSignals.US`: latest owner-scoped `us_screening_history` on or after
  2026-10-12, no later than the US local day. Signal rows are conditions, not
  actual executions, positions, intended orders, or a guarantee of execution.
  No portfolio snapshot, portfolio trade, or legacy holdings field is read here.
  Absent data is `UNAVAILABLE`; a signal date is not a holdings valuation date.
- `actual`: `actual-performance-2026-10-12-v1`. Read both existing actual source
  systems through `ledger_read_website_document` and its verified canonical
  projector. Apply `projectActualPositionContext`, which uses explicit reviewed
  `newActualPortfolio.assignments`. A post-start date alone does not include a
  trade. Partial assignments include only the assigned quantity/cost slice.
  Missing initialization is labeled, not asserted to be a funded zero-position
  account. This contract does not fetch prices: actual NAV/return are deliberately
  not inferred from raw holdings, old asset cards, Shadow, or screening quotes.
- `shadow`: exactly all eight IDs under `adopted-shadow-2026-10-12-v1:`:
  `KR_MIXED`, `KR_KOSPI`, `KR_KOSDAQ`, `US_A0`, `ETF_V02`, `US_A2`, `US_B3`,
  `KR_KOSPI_CONFIRM1_BEAR`. Use the existing verified summary and website boundary.
  Missing/unavailable/incorrect book sets fail closed. Waiting books retain their
  status; they do not imply fills. Keep each book's valuation/session date visible.
- `integratedShadow`: exactly `integrated-allocation-shadow-2026-10-12-v1:O1`
  and `integrated-allocation-shadow-2026-10-12-v1:S07`, read through
  `readIntegratedAllocationBook` integrity checks. These are prospective
  integrated books, independent of the eight books and historical CM research.

Never add actual, eight-model, and integrated positions/NAV together as one real
account: they overlap by design. Keep KRW and USD actual pools separate. Preserve
status and issue fields in prose reports; stale dates must not be called today's
holdings or performance without separate freshness validation.

## Connector/SQL deprecation manifest

`CURRENT_REPORT_SOURCE_CONTRACT` is the machine-readable identity/deprecation
manifest. For current holdings/performance, the following are deprecated sources:

- `us_portfolio_snapshots` and `us_portfolio_trades`, including A0/A2/B3 cumulative
  books and old SPY benchmark snapshots. Even an Oct 12+ row is not a new-series
  actual account or restart Shadow book.
- Raw `portfolio_ledgers` / `us_actual_portfolio_ledgers` documents, or raw
  canonical execution arrays without the reviewed new-actual assignment filter.
  The documents intentionally contain old and new records together.
- Oct 5 adopted series, generic latest-session queries, ticker/date-based joins,
  and legacy fallback endpoints used to fill unavailable current fields.

A SQL connector that cannot run the integrity projectors must not independently
claim current actual holdings from those raw tables. Request the read-only
contract output or report current holdings as unverified/unavailable. Scope every
query to the verified owner and every model query to the full exact series ID;
`strategy_id = 'A0'` or `date >= '2026-10-12'` alone is insufficient. Existing
history can still be researched when explicitly labeled historical; it must not
be mixed into today's report. This contract does not revoke raw database access
or automatically update external scheduled prompts: those consumers must adopt
this entry point and retire legacy current-holdings queries.

## Offline verification

    npx vitest run --config vitest.current-report.config.ts

Tests use mocked reads and synthetic fixtures, with no production calls/writes.
They cover owner scoping, exact series, explicit assigned slices, signal/holding
separation, missing data, and fail-closed behavior. Existing website-position
tests additionally cover malformed/future/new-series Shadow boundaries.

## Retiring the old writer and safe archive sequence

- Ordinary US dates on/after Oct 12 no longer read/write the September operating
  registries, snapshots or trades, and no longer recreate their SPY baseline.
  Restart Shadow must reach the requested date before the completion marker.
- Current gap recovery uses a separate restart-only prepared plan. Old recovery
  and continuation paths retain their historical semantics. The collector's
  current predecessor is the common date of screening completion and all three
  exact restart US books, not the old operating tables.
- The legacy order-preview endpoint refuses Oct 12+ snapshots. It must not turn
  a current-dated legacy pending position into a new portfolio order.
- Completed-date publication retries preserve immutable screening output and
  must not step a model again.

Read-only retirement inventory (no `--apply` option):

    npx vite-node --script scripts/plan-legacy-ledger-retirement.ts --user <verified-owner-uuid>

This reports exact legacy strategy scopes, row counts and hashes, actual document
revisions/hashes, new-assigned source IDs, and unassigned historical candidates.
It does not export payloads, create an archive, mark records inactive, or remove
anything. Re-run it immediately before an approved archive to detect races.

Do not delete actual source documents: old executions and new allocation metadata
share the same JSON documents. Preserve `newActualPortfolio`, all its source
execution IDs/audit, cash records, operating allocation/sizing/authority and every
unrecognized field. Canonical event/source/version/provenance records must remain
consistent. Removing source executions can generate canonical void revisions;
it is not an archival operation and must not be used as a shortcut.

The subsequent archive transaction requires a reviewed exact-target plan:

1. Verify deployed writer/reader separation, current daily and multi-day replay,
   same-date retry, and unchanged restart/actual identities.
2. With explicit archive approval, retain full owner-private source snapshots,
   schema/keys/constraints and a restore manifest. Preserve existing access; do
   not expose a public archive or add service-role credentials to files.
3. Read back archive counts/hashes and rehearse restoration in an isolated test
   database. Under a maintenance lock, compare the approved source hashes and
   revisions again. A new row/revision invalidates that plan.
4. Retire only the named old model tables/keys and old actual slices covered by
   that plan. Current source documents cannot be split by a generic date filter;
   handle canonical trigger/revision semantics in a separately reviewed migration.
5. Verify new series/session hashes, assigned actual slices, original market
   prices/ranks/screening/backtest/CM evidence and Notion access remain unchanged.
   Archive restoration is a separate explicit operation; no deletion is implied
   by generating this plan.

Database access is not revoked by this code patch. A direct SQL/admin connector
can still read the preserved legacy tables until that approved archival migration
runs; source-contract adoption is required in the meantime.
