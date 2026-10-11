# S06 actual portfolio and integrated O1/S07 Shadow

## Approved operating contract

Effective from 2026-10-12; no prior holdings, queued orders or original signals migrate.

- Actual S06 allocation plan: KRW 30,000,000; Korea 40%, ETF 20%, US 40%.
- O1 model initial target: Korea/ETF/US each one third. The historical seed was selected from the verified 2026-09-11 research endpoint; it is not a current October signal.
- S07 model: 60/20/20 static initial allocation. Each integrated model starts at KRW 30,000,000; existing eight independent market books retain their own contracts.
- New live O1 uses delivered entry-condition signals by the market confirmation date's previous calendar month. It does not recompute independent reference books or use executed BUY counts. Active markets receive equal weights; one active market gets 60% and central cash 40%; no active markets retain cash. Missing market observations retain the prior target.
- October 12–31 is explicitly a partial first observation month that determines November. Signal identities are deduplicated by market, symbol and original signal date. Delivery must be available before a review can be published.
- O1 changes move idle cash only. A zero target cancels unfilled entry reservations and retains existing holdings. No forced rebalancing sales.
- Korea/US new-position budgets use complete year-opening market NAV divided by 30/20 slots. Already pinned budgets remain fixed across retries and year boundaries. ETF uses the confirmation day's completed closing sleeve NAV times the existing volatility weight. Missing valuation remains unknown.
- Shadow uses the approved KRW/USD 1,339.2 comparison conversion. Actual dollar cash and sizing require actual funding evidence; allocation plans never create cash or a conversion event.
- Adjusted market prices are used under the existing source contract. No synthetic dividend cash is added. The previous annual-NAV ETF research and original reference/20-session O1 research are clearly historical, not results of this new live policy.

## Actual workflow

The dashboard preserves condition-qualified rows at zero cash. Actual-held, consumed-signal, exit and fresh reentry states use only the new actual execution journal. Screener union-held information remains a separate context. Shadow holdings never consume actual entry signals.

The same canonical actual document supplies holdings and cash. Korea/ETF share one KRW pool with explicit market cash claims; US uses a separate USD pool. Shared spendable cash, claims, reservations, actual slots and sector counts are checked together. Pending reservations and partial fills occupy one symbol slot. A changed or missing sector classification fails closed.

The UI previews a source-verified fixed signal budget, explicitly confirms it, then separately previews and confirms a cash reservation. These are bookkeeping actions, not brokerage orders. Server CAS protects the document revision; a review fingerprint binds a budget approval to its signal/NAV evidence. Recorded actual fills invalidate derived queries. A changed funding/cash source requires reconciliation before further reservation, while release remains available.

## Integrated model workflow

Shadow has Korea, US, ETF and Allocation categories. Owner-authenticated registration creates two empty future-start registries and no fake session. Normal market processing stages the shared prepared daily evidence as owner-scoped JSON; it does not run a second reference strategy. A complete union-session batch feeds unchanged market signal adapters and the new allocation ledger.

Storage failure retains the exact prepared payload plus hash in the existing append-only owner audit table. Recovery restores those bytes, not a later recomputation. Integrity conflicts do not fall back. Original market audit summaries exclude allocation outbox records.

Interactive append uses the bounded owner RPC. Scheduled trusted collectors use the existing service append RPC after loading the exact owner registry and preparing the verified publication. No new role, credential, grant, RLS policy or service function is introduced. Service mode does not initialize books. Both paths have synthetic PostgreSQL parity, nonzero holdings/cash/receipt, duplicate retry and access checks.

## Validation and limits

Local coverage: actual allocation/annual NAV/UI, actual portfolio, dashboard, core KR/ETF/US differentials, staged-input recovery, owner endpoint authentication, and disposable PostgreSQL owner/service publication tests. Full repository lint, type checking and production build are required before release. Separate independent review found and verified fixes for annual-budget UI reachability, service routing, stale candidate previews and corrected-sector reservations.

The verified calendar currently ends 2026-12-31; unverified special hours and dates beyond its coverage remain blocked. A reviewed compatible calendar/runtime update is required before those dates. Synthetic 2027 annual-budget tests do not establish a live 2027 calendar. The first actual October 12 session is still in the future at release preparation.

PGlite validates SQL contracts and sequential/idempotent races but does not establish independent live PostgreSQL connection lock contention. No synthetic trading rows are inserted into production to test this. Real brokerage execution is not part of the application.

Deployment SHA, migration application/readback and authenticated UI evidence are recorded in the private development note after completion.
