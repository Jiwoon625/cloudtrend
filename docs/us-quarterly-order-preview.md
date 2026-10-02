# US model order previews

## Scope

The dashboard and US model portfolio show display-only quantity estimates for the next
regular session and the next quarterly equal-weight adjustment. The existing frozen A0/A2/B3
execution engine, strategy registry, historical trades, NAV and actual execution ledger are
unchanged. A preview never creates a broker order or a model trade.

Model quantities are not actual-account recommendations. The actual ledger's default
$100,000 capital is not verified account cash; this feature deliberately does not size actual
orders from it. Model names that the user excluded from their actual account remain model names.

## Dates and holiday behavior

Plans are anchored to the last completed **US session date**, not the viewer's local calendar
quarter. A December 31, 2026 snapshot therefore continues to show 2027 Q1 on January 1,
with planned execution January 4, 2027. A January 4 completed snapshot moves the upcoming
quarter to April. A December 30 snapshot visible at midnight January 1 in Korea remains a
provisional scenario until December 31's completed result is available. No collector, timed
screening job or January 1 background task is needed.

`PROVISIONAL` means the current holdings, pending signals and close prices are assumed to
remain unchanged until the quarter boundary. `READY` means the final scheduled prior session
is available, not that the next open's price or filled quantity is known. The UI flags a plan
whose scheduled date has passed while its source snapshot is still old. Missing data is not
an empty order list. The actual engine still waits for the next observed US session's data.

The date-only NYSE holiday helper is display-only. Recurring holidays, Good Friday, Saturday
New Year non-observance, and the 2025 Carter closure are represented. 2026–2028 were checked
against [NYSE holidays and hours](https://www.nyse.com/trade/hours-calendars) on 2026-10-02.
Other years carry a calendar warning. Exceptional future closures can change the displayed
schedule; this helper does not control model execution. UTC date arithmetic avoids DST and
browser-timezone changes to session labels.

## Sizing

Only matching completed-session close quotes are accepted. Future opening prices and later
quotes cannot enter the estimate. Preview sizing follows the frozen engine's sequence:

1. Pending exits first, excluding these symbols from equal-weight targets
2. Post-exit NAV for target holdings, including any unfilled exit residual
3. Target reductions first, then buys in the engine's stable delta order
4. Integer shares, prior ADV20 × 1% participation, 0.25% one-way cost, available cash,
   maximum model holdings and applicable shadow sector caps

Rows distinguish ideal target holdings, estimated transaction shares, unfilled transaction
shares, and unchanged holdings. They show reference close/date, target weight, reason and
limiting factor. Prices at the future open, affordability, partial fills, intervening signals
and portfolio changes can all change actual model quantities. Pending
`ENTRY_MINIMUM_PROPORTIONAL_FUNDING` reductions are visible without changing entry/exit counters.
If the next session is the quarter boundary, quarterly targets supersede ordinary pending
targets exactly as in the engine and the UI displays the plan once.

## Persistence and read-only compatibility

New completed-session runs save `state.orderPreview` with the model snapshot. This presentation
field is not read by execution logic. The completed-date shortcut is unchanged: deploying this
feature does not replay or rewrite historical model results.

Reads verify the owner, frozen rule version, snapshot date, state date and completed screening
history marker. A valid saved projection needs no quote file. Legacy snapshots are projected
server-side from the immutable `results/us-screening/<session>.json` for the exact same date,
with matching rule version. There are no storage writes, engine reruns or mutable latest-price
fallbacks on that path. An incomplete latest snapshot fails closed rather than resurrecting an
old plan. Full engine state is never returned to the browser.

Portfolio preview errors are isolated from the existing holdings view. Dashboard preview
failures are explicitly labelled `US 주문 미리보기` and do not change actual portfolio summaries
or signal counts. Preview refresh only reads saved data.

## Verification

- `npx vitest run --config vitest.dashboard.config.ts`
- `npx vitest run --config vitest.portfolio.config.ts`
- `npm run test:us`
- `npm run build`

Core tests cover year/quarter boundaries, Jan 1, Good Friday, observed holidays, leap days,
DST, zero/sub-lot orders, cash and liquidity limits, pending exits, reserved entries,
shadow sector caps, malformed/stale inputs and flat-price parity with the frozen engine.
Transport tests cover completion gating, owner scope, saved and legacy projections, errors,
and mismatched dates. Component tests cover provisional, ready, overdue, blocked, empty,
compact and duplicate-quarter presentation.
