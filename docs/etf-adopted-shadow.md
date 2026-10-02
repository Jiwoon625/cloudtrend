# ETF adopted Shadow executor

`src/lib/ledger/etfAdoptedShadow.ts` is an opt-in, pure daily executor for the new
`ETF_V02` MODEL series. It does not access or modify actual ETF holdings, historical
backtests, broker orders, a database, or a scheduler. Existing ETF strategy code is
unchanged. Production execution remains unwired.

## Boundary and existing policy

- Initialize with `initializeEtfAdoptedShadow(frozenSeries)`: KRW 100,000,000 cash,
  no positions, no pending raw setups, no pending entries or exits
- Accounting begins on 2026-10-05. The first trade-session date is obtained from
  the supplied complete KR market calendar, not inferred from weekdays
- `ETF_POLICY` and `etfEntryWeight` remain the source of V0.2 policy: confirm1,
  liquidity descending then symbol ascending, no replacement, maximum ten
  holdings, volatility entry weights, and held-position MA60 exits
- A raw onset must actually be observed after the new-series boundary. Its
  confirmation is accepted at the immediately following processed close. The
  resulting order is eligible only at the next regular session open. Therefore,
  a first-session raw onset can first fill at the **third** regular session open
- Pre-start prices may be used upstream for indicator warmup. Pre-start signals,
  holdings, and pending state cannot be imported into this executor

## Daily call

For journal integration, call `stepAdoptedEtfSeries(frozenSeries, input, previousRun)`.
It returns `{ status: "NEW" | "REUSE", run }`. The run contains MODEL identity,
receipt, predecessor hash, complete state/record result, and a hash over the full
run body. Every input field and the predecessor's full state/record hash are bound
into the receipt's source manifest. Identical same-date input is reused; changed
same-date input or a changed predecessor is rejected. The caller's declared source
hash alone cannot mask changed prices, signals, calendar, or timing. Each run keeps
its calendar. Subsequent calendars must preserve every session in already-declared
coverage; they may extend coverage but cannot remove a day to bypass sequencing.

The lower-level `stepEtfAdoptedShadow(frozenSeries, previousState, input)` remains
available for pure execution/testing. Supply either API with:

1. The exact session date, preceding processed session date, explicit open and
   close-decision timestamps, and a complete covered KR regular-session calendar
2. The unchanged frozen code/config hashes and this run's dated source hash
3. Open/close price evidence with exact as-of date, availability time, source
   hash, and an eight-decimal-or-shorter decimal string or explicit null
4. Dated existing-engine `EtfStrategySnapshot` values and their availability
   timestamps/source hashes

The lower-level function returns immutable `{ state, record }`, without mutating inputs.
The record includes the run receipt, fills, exact fees/cash movements, rejection
and missing-data reasons, pending intents, and closing valuation. Record and state
must be persisted atomically under a unique `(bookId, sessionDate)` key by a future
adapter. Trustworthy source/calendar acquisition, persistence,
scheduled execution, and any production activation remain caller responsibilities.
Repeated lower-level steps, backward, skipped, or mismatched sessions are rejected.
The journal wrapper supports verified identical same-date reuse instead of replay.
Session timestamps are interpreted in Asia/Seoul, including explicit UTC offsets.
Frozen model provenance and ETF policy are checked on every call.

## Open execution and missing data

- Only pending confirmations from the previous completed session can enter
- Held MA60 exits are attempted first using the current valid open; missing opens
  leave the liquidation intent pending, with `EXIT_DELAYED_MISSING_OPEN`
- Entry target budget is **previous close NAV × existing volatility weight**,
  capped by cash remaining after exits and higher-priority entries. Current-day
  closing prices/signals never affect that morning's fills
- Quantity is integer floor after allowing for a 0.0015 one-way fee. Each fee is
  rounded up only at the eighth decimal place. A same-price round trip costs
  0.003 of gross traded notional, subject to that explicit precision rule
- Missing, stale-dated, or not-yet-available open prices never fabricate a fill
- Entry eligibility expires after its one eligible open. In particular,
  `ENTRY_EXPIRED_MISSING_OPEN` records an unfilled entry; it is **not** silently
  executed at a later open using a stale confirmation
- Entries are also rejected for exhausted slots/budget or incomplete/stale prior
  NAV. They never force out another holding and do not use that day's closing
  recovery to repair the morning's unavailable sizing information
- A last known close may be carried for display, but its original date/source
  remains visible and valuation is `STALE`. If any held position has no known
  close, aggregate market value, NAV, and unrealized P/L are null, never zero
- Missing current held-position strategy data is recorded without forced sale

## Verification scope

The focused test suite covers start isolation, raw onset/confirmation/open timing,
calendar gaps, no lookahead, pre-start rejection, exact integer costs, volatility
sizing, cash cap, liquidity ordering/max10/no replacement, missing/stale marks,
entry expiration, MA60 delayed exits, explicit provenance, and input immutability.
It uses a declared fixture calendar; it is not a live market-calendar assertion.
This foundation does not itself acquire corporate actions or distributions.
