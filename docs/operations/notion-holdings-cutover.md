# Notion master holdings cutover — phase 1 (not active)

This branch prepares the approved holdings-only cutover. It does not change the existing UI, writer, production schema, or signal history. No data migration or deletion is authorized by this PR. No personal source ID, token, positions or account values are committed.

## Read-only contract

`src/lib/notionMasterHoldings.mjs` reads Notion's 2025-09-03 data source query via an injected server-side fetch. The caller must authenticate the Supabase user and resolve that owner's Notion person/source/token from trusted server configuration, never the browser. Query all pages, require exactly one matching person per row, preserve alphanumeric domestic codes and leading zeros, and separate listing market from security type. The three confirmed Notion property names are 보유시작일, 최근매도일, 종목구분. 종목구분 options are 주식 and ETF.

The adapter rejects missing or null holding-quantity formulas, negative/nonfinite quantities, unexpected property types, conflicting identifiers, future or invalid dates, and potential truncated relations (25 or more). A complete set of zero holdings is distinct from an empty or failed query. It stores no individual trade payload. Positive holdings only are projected, and sold-symbol dates are retained separately for suppression. Missing sell dates are not assumed to prove no previous sale. Reported average/amount do not prove their currency; cost-dependent signal use requires independent basis validation.

The pure candidate projection does not alter input raw signals. It classifies holdings as HELD / NOT_HELD / UNKNOWN, and returns CANDIDATE or PENDING, not final order signals. It requires a verified fresh snapshot; downstream strategy gates remain mandatory. It is deliberately not connected to production.

## Remaining cutover gates

1. Verify real Notion integration access and all-page formula results against Notion and broker evidence. Notion documents relation/formula limits; do not assume numbers returned by a query are correct. A missing or incomplete read must never replace the last verified snapshot. Establish trusted owner-to-Notion mapping and credential storage.
2. Implement private latest snapshot persistence with atomic replacement, ownership/ RLS, freshness, concurrent sync protection, explicit error status, and last-good read. Keep a recent-sell index even when quantities reach zero. Decide separately how to establish never-sold evidence.
3. Integrate actual signal projection using the existing rule functions and latest immutable screening inputs, not raw signal-only classification. Preserve market gate, confirmation, slot/sector constraints, manual non-entry decisions and recent-sell suppression. Missing prices, stale holdings, missing basis, insufficient historical data or unknown strategy applicability must not become actionable exit or entry. Preserve the original signal journal. In particular, H60 uses the exchange calendar; K4 pooled basis evolution and E4 per-lot peak/latched evidence cannot always be reconstructed from aggregate cost and current cycle dates. Do not silently replace these rules.
4. Change read paths in `websitePositionContext.server.ts`, `portfolioLedgers.functions.ts`, `dashboardOperations.server.ts`, the US position/detail paths, operating allocation and portfolio UI. Ensure all current actual holdings are from the master, never legacy/Shadow. Separate real holding status from raw signals. Keep manual non-entry decision functionality unless explicitly retired.
5. After end-to-end verification, retire actual write and proposal approval routes (including MCP), model/Shadow/integrated runtime writers and scheduled/explicit operating paths. Keep research and historical reproduction code, archived data and screening v7 publication. Do not revoke/delete old storage before safe archive inventory and verification. Update reporting consumers and archive navigation. No automated orders.
6. Required verification before merge/deploy: full screening/identity/immutable-history regression, old vs new raw signal parity on identical input, private access/owner isolation, actual Notion sync and position reconciliation, H60/K4/E4 parity, portfolio/dashboard/screener/detail browser QA, build/typecheck, writer-path inventory and before/after history count/hash. Verify failed/stale sync and rollback. Production remains untouched until these gates are passed.

## Phase 1 tests

`node tests/notion-master-holdings.test.mjs` exercises synthetic mapping, zero/null, sale dates, market classification, duplicates, ownership, date validity, incomplete pagination and raw signal preservation. No network or private data are used. These checks do not certify live Notion data or full strategy parity.

Relevant existing contract: [screening-only operation](./screening-only-signal-history.md), [current report source contract](../current-report-source-contract.md).
