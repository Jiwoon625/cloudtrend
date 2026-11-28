# Manual security master cutover (draft, not active)

2026-11-28: The user superseded the runtime Notion API approach with a manually editable visible CloudTrend table. After recording actual transactions in Notion, manually edit the aggregate fields or paste a table and save. No Notion token or transaction replication is required. All cost/aggregate monetary amounts including US average acquisition cost are KRW; the listing currency is the quote currency, not the cost currency.

## Implemented on this review branch

- `/portfolio?master=1` and main navigation: visible table with the 18 value columns from the Notion master, owner displayed as authenticated account. The relation to individual transactions is intentionally excluded. Direct cell editing, add row, filters, tab-separated cell/whole-table paste, preview, explicit confirmation, save/readback. Existing portfolio remains unchanged. No personal data included.
- `manualMaster.ts`: strict schema validation, string IDs preserving leading zeros/alphanumeric ETF tickers, fractional quantities, dates, zero vs missing, no duplicate identity, decimal inputs, preview diff, holding and recent-sale projection. No missing value fabricated as zero. No legacy ledger fallback.
- `manualMaster.functions.ts`: authenticated owner only, revision CAS and readback. `manualMaster.server.ts` validates every read. The additive schema and DB guard migrations were installed; owner-only RLS, no anonymous or delete rights, revision and row validation enforced. The private initial seed has 53 rows and remains pending review.
- `manualMasterSignals.functions.ts` and `manualMasterSignals.ts`: separate candidate preview for an explicitly selected saved revision, using current saved KR/US screening projections and the existing marketSignals policy. Explicit recent-sale aggregate argument, no synthetic executions. Existing call sites use the default empty aggregate argument. Held score exits/H60, raw conditions, entry confirmation, sector context and manual non-entry decisions reuse existing code. The master asOf is the last holdings change date, not an expiry. A confirmed snapshot remains valid across newer screenings without daily saves. Missing/unconfirmed/invalid snapshots remain unknown. Each market's screening availability is independent; the position-context read does not depend on screening availability. Missing quote/selection limits remain pending; preview is not final trade advice.
- Previous isolated Notion API code remains unreachable in draft for comparison; superseded and not required for this approach. No production Notion configuration changes.

## Cutover gates remaining

1. Run unit, PostgreSQL RLS/CAS, existing screening/history and dashboard regressions, typecheck, lint, build, authenticated browser QA. Generate/verify migration, including DB-side guards for direct API writes and owner isolation. The editor table is installed; do not switch the production signals until owner review and parity gates pass.
2. Populate the full owner-confirmed table with actual aggregate values from Notion; preserve sold rows, compare all quantities, dates, codes, currency and costs. Missing/blank recent-sale dates do not automatically prove never-sold. Do not copy placeholder or fabricated holdings. Review Notion cost conventions and fees.
3. Integrate all current dashboard, screener and details signal consumers with the saved master rather than legacy ledgers. Save invalidation and screening-time snapshot revision must be verified. Entry gates/sector and slots, missing holding coverage, long-term ETFs vs strategy universe, H60 dates, K4/E4, latched exit intent and multi-buy lots remain explicit parity gates. KRW cost cannot be directly compared to USD prices. No unapproved change of stop methodology.
4. Only after verified end-to-end behavior: retire actual, strategy, Shadow and integrated allocation operational writers, approval endpoints and old automation references; preserve historical and research data, all original screening rows and strategy versions. No automatic order.
5. Verify raw signal parity, before/after archive counts/hashes, regression tests, authenticated production QA and rollback before final cutover. Only the additive private master schema and pending seed have been installed. Original ledger and screening data/writers have not been changed.

## Validation

The previous Notion adapter tests remain for historical comparison. New manual master unit tests, manual-master signal projection and PGlite owner isolation/CAS tests are included in PR CI. Full integrated validation remains required; CI status is tracked on the draft PR.

Prior decision: [screening-only operation](./screening-only-signal-history.md), [current report source contract](../current-report-source-contract.md).

## Reversible legacy operational retirement gate (rehearsal only)

`CLOUDTREND_LEDGER_ARCHIVE_ONLY=1` is a server-only rollout switch. It is not set in production by this change. With the switch on, mixed load/write legacy portfolio endpoints (including loads that initialize or persist price-exit evidence), old position-context fallback, capital/allocation edits, integrated initialization, actual performance preview/save, manual ETF membership writes, assistant proposal/approval operations are rejected. MCP continues to expose source registration; archived proposal listing and existing pure archive readers remain available. No old rows, storage objects or research functions are deleted.

This is an application-ingress barrier, not a claim that all database RPCs, direct Data API writes, or explicit CLI/research commands are revoked. Before activating it, inventory those paths, provide a read-only archive view for the mixed legacy portfolio endpoints, and verify backup/restore, K4/E4 parity, confirmed master, and authenticated QA. Keep daily screening and immutable history outside the barrier. The switch remains off until those requirements are met.
