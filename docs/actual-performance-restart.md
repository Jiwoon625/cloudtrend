# Actual new-capital performance restart, 2026-10-12

## Approved measurement boundary

The owner’s latest decision is **newly allocated real cash and new trades from 2026-10-12 only**, starting with no held securities. This replaces the earlier proposed complete-account opening NAV. The actual starting amount, reporting currency and FX remain unconfirmed; neither MODEL’s KRW100m nor its exchange rate is a default for ACTUAL.

The existing ACTUAL journal, original trades, holdings and acquisition/tax basis remain unchanged. Existing positions and unallocated broker cash stay outside the new performance interval. The eight `adopted-shadow-2026-10-12-v1` MODEL contracts, CM research and held-back backtest CAGR/MDD work are untouched.

The page defaults to **준비 중 · 배정 현금 확정 대기**. Missing baseline means unknown NAV, P&L and return, not zero. Existing account cards retain their separate **기존 원장 누적손익** labels.

## Minimal storage and entry path

One optional `actualPerformance` property in the existing owner-scoped `portfolio_ledgers.payload` stores the reporting interval. There is no new table, migration, trade-generating action, automatic Notion sync or valuation scheduler. The existing canonical document reader, authenticated owner identity, compare-and-swap revision and exact readback are reused. No settings, original execution or MODEL field is replaced.

The portfolio page’s **실제 성과 자료 대조·확정** section accepts reviewed JSON or a local JSON file. **대조용 원장 버전 확인** reads only. **검사 후 미리보기** checks the same rules as saving without a write. The preview includes the new allocated scope, source records, cash, quantities, prices, FX, flows and execution allocations. Only a separate explicit review checkbox enables **검토한 자료 확정 저장**. Editing the input or an uncertain save response clears the preview and approval. A fresh read/review is required before retrying.

This is a safe reviewed-input entry point, not a finished automatic daily operations workflow and not a request that the owner manually prepare a complex file every day. Verified cash, account mapping, settlements and external-flow connections will be decided during reconciliation. Market-data uploads alone cannot establish those facts.

## Opening contract

`PerformanceBaseline.scope` must equal `POST_START_ALLOCATED_CAPITAL`.

- Every account/currency row represents only cash explicitly assigned to this new interval, never the full bank/broker balance by default.
- Opening positions must be empty and opening unsettled cash must be zero. Pre-start holdings or pending sale proceeds cannot become newly invested assets through the opening input.
- Opening allocated cash is nonnegative, fully evidenced, and total converted NAV is positive. An unknown or zero unfunded opening remains pending.
- Shared KR/ETF cash appears once per account/currency. Actual amount, reporting currency and dated FX evidence must be expressly reviewed.
- Logical opening date is 2026-10-12, immediately before its first included event. Weekend confirmation may use known prior-session FX, with explicit date and availability evidence.
- Both current KR and US source revisions and a frozen evidenced beta summary are retained. Missing historical daily NAV is not invented.

The old proposed carried-position baseline is rejected rather than silently reinterpreted. No production baseline was written under that proposal.

## New trades, mixed holdings and cash reconciliation

Each observation requires `allocationConfirmed: true`, `tradeAllocations` and `cashAdjustments`, including explicit empty arrays when none occurred.

Each trade allocation references an existing actual `sourceSystem` + `executionId` and supplies the reviewed date/order, account/currency, security ID, side, quantity, price, allocated gross, allocated fee and Notion/broker evidence. Security IDs are `market:symbol`, e.g. `KOSPI:005930`, `ETF:069500` or `US:AAPL`. The server checks every referenced current source fill, including earlier observations; missing, pre-start, changed or contradictory source facts block a new write. It never creates a real fill to satisfy a performance input.

The source fill’s date, order, side, instrument, currency and eight-place canonical price representation must match. The original full-precision price is never changed. Gross is preserved separately: full allocation must match the existing canonical eight-place representation of original price × original quantity, rather than rounded price × quantity. Partial allocation requires an explicitly reviewed positive gross no greater than the original gross; the tool does not invent a proportional fill allocation. The allocation’s price is the original aggregate fill price, not a claim that it equals partial gross divided by allocated quantity. Allocated quantity is a positive integer and cannot exceed the original fill. Allocated fee cannot exceed the original actual fee; allocating the complete fill requires exactly its original fee. Partial quantities require an expressly reviewed actual fee allocation, not a new inferred transaction-cost assumption. An execution cannot be silently reused twice in the series.

New-scope quantities are replayed solely from those allocations, beginning at zero. A sale deducts only the explicitly assigned new-scope quantity and cannot exceed the new-scope quantity then held. **No automatic FIFO, pro-rata allocation, or import of the legacy position occurs when old and new shares use the same symbol.** The reviewed ending position quantities must match this subledger exactly.

For each account/currency, ending cash plus unsettled cash must equal prior allocated cash plus unsettled cash, plus flow legs, plus allocated trade cash, plus evidenced income/cost adjustments. Buy cash is minus the separately verified gross and fee; sell cash is gross minus fee. Ending cash plus unsettled cash cannot be negative in any allocated pool: borrowing unallocated legacy cash is not an approved source of funding. Intraday funding order is not inferred from date-only evidence. This catches unexplained full-account cash or legacy proceeds being counted as gains.

- Assigning proceeds from the sale of an excluded old holding is a new **external DEPOSIT** into this measurement scope; the old trade itself remains excluded.
- Unallocated money is not part of NAV. Additional allocation from outside the measured scope is an external contribution, even if it remains in the same physical broker account.
- Balanced transfers between already included account/currency pools and movements between asset buckets within the same pool are not external performance gains.
- Evidenced `cashAdjustments` cover DIVIDEND/INTEREST income and FEE/TAX costs belonging to the new scope. They must not repeat an already allocated execution fee or include income attributable to excluded old holdings.
- Original acquisition cost is retained in the actual journal. New performance uses the scoped economic cash flows and market values, not a reset of tax basis.

## Valuation and return rules

Existing eight-place fixed decimals are used throughout. NAV is scoped cash + scoped unsettled cash + scoped marked holdings. Duplicate pools/positions, missing scope, unexplained cash or quantity differences block persistence.

Daily marks match the observed date or explicit reviewed prior-session dates for a local holiday. Required FX has matching dates, verified source and availability no later than the recording cutoff. Daily dates and used price/FX dates cannot follow the UTC recording date; confirmation cannot precede evidence recording. Independent intraday publication timestamps for each price/cash item are not available in the existing account snapshot contract, so this route requires explicit reviewer reconciliation rather than claiming automatic publication-time verification.

P&L = ending NAV − prior NAV − net external contributions. Verified beginning/end flows adjust the compounded return factor `(ending NAV − end flows) / (prior NAV + beginning flows)`. Unknown intraday flow timing or an undefined denominator leaves the percentage unavailable rather than invented.

Observations append with their exact predecessor. Each supplied trade, adjustment and flow belongs to its observation date; a skipped day with one of those events needs its own reviewed observation. Multi-day flow weighting across skipped event days is not implemented. Incomplete facts reject before writing and can be repaired; accepted same-date facts are immutable and identical retries reuse them. Correcting an accepted day requires a separately reviewed correction path, never silent rebaselining.

KR and US evidence revisions are checked with separate reads, not an atomic lock across both source documents. App-level validation does not imply arbitrary direct database changes are impossible.

## Verification boundary

Synthetic tests cover empty allocated openings, excluded old holdings, scoped buys/sells including a mixed original sale, source-fill linkage, over-allocation and oversell rejection, cash reconciliation, legacy proceeds as contributions, shared cash, transfers, dates, auth/owner isolation, read-only preview, CAS/readback and immutable retries. They are not investment results.

Run focused actual-performance, ledger, portfolio, UI, Shadow, TypeScript, changed-file ESLint and production build checks against the final patch. Static component rendering is not authenticated click/file-change/retry browser QA. Production write tests must not use invented owner money or trades.
