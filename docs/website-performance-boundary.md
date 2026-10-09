# Website performance boundary

The website displays only the `adopted-shadow-2026-10-12-v1` model series and the existing separately reviewed actual-performance series beginning 2026-10-12. This is a presentation/request boundary, not a ledger reset or migration.

## Preserved data

- Beta model contracts, sessions, state hashes, replay evidence and legacy research snapshots remain available to internal verification and reproduction.
- Original actual fills, holdings, acquisition costs and Notion evidence remain unchanged. Neutral holdings/price/cost and execution management remain on the portfolio page; these records are not automatically included in the new performance scope.
- The private operating capital plan is not confirmed cash or opening NAV. Market allocation, actual baseline and integrated portfolio initialization remain pending until explicitly reconciled.
- New verified historical backtest research is separate from beta-period live/Shadow performance and is not removed by this change.

## Website surfaces

- Shadow has no beta-series selector or mounted legacy KOSPI/US research subtree. Its server function accepts only the October 12 version, including before that date.
- The display projection rejects an entire book if its identity, scheduled start, session dates, holdings, history or trades cross the boundary. It does not clip a beta curve while retaining a beta inception return.
- Replay notices before the new start are hidden. Date inputs cannot select the beta period.
- Portfolio and dashboard remove original cumulative P&L/return/aggregate NAV and tax performance cards and per-holding/per-trade P&L. Operational original holding quantities, costs, prices, execution records and controls remain.
- The actual-performance panel and reviewed-evidence preview do not display archived beta summaries. Preview serialization omits `betaArchive` from a display copy only; validation, immutable evidence and the save payload retain it.
- Initialization without a recorded session remains waiting, with no fabricated return. A missing actual baseline stays pending rather than showing zero performance.

## Archive and verification

A separately authorized private Notion development-note archive records verified beta summaries, source dates/revisions, eight model identities and their 19 stored daily NAV points. Where actual historical daily NAV or current ETF/US marks were not verified, the archive states this limitation; no replacement curve or last-fill-as-market valuation is invented. Financial amounts and owner identifiers are not committed to this document.

Regression checks cover the version/date boundary, stale beta payload rejection, input preservation, preview exclusion, mounted public routes, dashboard and portfolio P&L exclusion, and existing ledger-write safety. Static rendering and in-process component callbacks are not authenticated production browser click/PDF/CSV QA. No production data is written by the display patch.
