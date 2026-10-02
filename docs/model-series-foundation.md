# Adopted comparison-series foundation

This module is additive. It does not deploy, migrate, reset a historical book,
rewrite A2/B3/KOSPI research history, or alter unconfigured production callers.
All examples in tests are synthetic fixtures, not strategy performance evidence.

## Frozen new series

`src/lib/ledger/modelSeries.ts` creates only these five new model books under
`adopted-shadow-2026-10-05-v1`:

| Kind      | Independent opening allocation     | Adopted allocation rule                                             |
| --------- | ---------------------------------- | ------------------------------------------------------------------- |
| KR_MIXED  | KRW 100,000,000                    | Shared 30 positions; candidate-market sector cap KOSPI 3 / KOSDAQ 6 |
| KR_KOSPI  | KRW 100,000,000                    | Independent 30 positions; KOSPI sector cap 3                        |
| KR_KOSDAQ | KRW 100,000,000                    | Independent 30 positions; KOSDAQ sector cap 6                       |
| US_A0     | KRW 100,000,000 converted as below | Existing A0 quarterly allocation                                    |
| ETF_V02   | KRW 100,000,000                    | Existing v0.2 volatility sizing                                     |

Every new series declares a 0.003 round-trip model cost and 0.0015 one-way cost.
Only the three KR equity books use initial capital / 30 during the first year:
2026-10-05 inclusive through 2027-10-05 exclusive. The helper rejects later
sizing because no later allocation rule was supplied. This is not a new rule
for US A0 or ETFs, and there is no CM allocator implementation.

Mixed-book sector capacity follows the existing candidate-market convention:
count all held positions with that sector code, then apply the incoming
candidate's market limit. Both markets share the same overall 30-position limit.

## Official FX and residual

The verified baseline is SMBS USD/KRW 매매기준율, published date 2026-10-02,
1 USD = KRW 1,359.60. Its source is
https://www.smbs.biz/ExRate/TodayExRate.jsp.
The screenshot was verified at 2026-10-02T15:36:09Z; the publication timestamp
is unknown and remains null. A non-secret evidence key is retained in `VERIFIED_INITIAL_FX`. The original
private screenshot locator must be linked in private deployment records and is
not included in this public repository.

Conversion floors the USD balance to cents and retains the unconverted KRW:

- USD cash: 73,551.04
- KRW converted: 99,999,993.984
- KRW residual cash: 6.016

The residual is cash, never a transaction fee. Missing or mismatched initial
FX fails closed. No live, stale, secondary, or undocumented FX fallback exists.
Future combined KRW valuation must value USD holdings/cash with a separately
verified mark and include the KRW residual. The US engine's own numerical
return remains denominated against the converted USD opening balance.

## Time, isolation, and reuse

- Accounting starts 2026-10-05 in cash, with no positions or pending orders
- The first regular market session is derived separately from a supplied complete,
  source-hashed exchange calendar; holidays do not change the accounting start
- Earlier observations are indicator warmup only
- An onset before the new series start cannot become an actionable confirmation
- Signals must have the same signal/as-of/availability/decision exchange-local
  date; delayed information cannot schedule a retroactive next-session trade
- US A0 execution enforces consecutive regular sessions and fails closed on gaps
- ACTUAL, another new series, and legacy/alternative engine state cannot be reused
- Configuration, code, initial source manifest, and contract identity are hashed
- Each US run additionally hashes actual analysis, calendar, availability, and
  predecessor state; a declared source hash alone is insufficient
- Identical same-date calls reuse the saved result; changed same-date payloads,
  code, configuration, or source manifests cannot overwrite it

Callers supply truthful code/source manifests and complete exchange calendars.
These hashes provide deterministic integrity checks, not cryptographic proof of
external data authenticity. Persisted `FrozenModelSeries` values should be
checked with `verifyFrozenSeries` on load. Storage must atomically enforce a
unique `(bookId, date)` run key; a pure function cannot provide database locking.

## Safe engine reuse

`stepUsProspectivePortfolio` accepts an optional `UsModelExecutionPolicy`.
Without it, legacy USD 100,000 and 0.0025 one-way costs remain unchanged.
The opt-in path is restricted to the existing adopted A0 strategy config,
initializes the requested frozen capital, uses the frozen model cost on buys,
sells and quarterly rebalances, and carries exact eight-decimal cash/fees.
Integer affordability uses the shared exact-decimal budget helper. Fees round
up only at the eighth decimal place; this prevents a fractional fee from
creating an overdraft. Selection, target-weight logic, quarterly timing,
preceding-day participation capacity, and Anchor exits are reused.

`stepAdoptedUsSeries` wraps that engine with immutable model/run provenance and
session guards. It is a pure reusable executor, not a production scheduler or
exchange/broker integration. Its cash/fees are exact fixed-point values; NAV and
strategy weights retain the existing engine's numerical representation.

`quoteEtfModelEntry` reuses the existing v0.2 volatility formula and its entry
eligibility checks, then conservatively truncates the weight to eight decimals
at the exact-money boundary. It is a single-candidate sizing adapter, not a
replacement for ranking, holding-count checks, order sequencing, or an ETF
execution state machine.

`quoteKrModelEntry` supplies fee-inclusive integer quantities without rounding a
share up. KR engine integration is maintained separately from this module;
legacy round-to-nearest replay must not be assumed to satisfy this contract.

## KR and ETF execution adapters

`stepAdoptedKrSeries` reuses `simulateStrategy` with an explicit prospective policy.
It accepts only complete consecutive declared sessions, preserves already frozen
historical input prefixes, ignores pre-start onsets and applies fee-inclusive
integer floor to initial capital / 30. Omitted policy arguments retain the old
replay behavior. The new KR path carries exact eight-place cash, fees and realized P/L in
modelAccounting. Legacy summary numbers remain display projections.

`stepEtfAdoptedShadow` implements the existing v0.2 next-open execution contract,
including separately dated pending confirmations, volatility allocation, liquidity
ranking and MA60 exits. See `etf-adopted-shadow.md` for missing-data rules.

`appendFrozenModelRun` uses a service-only PostgreSQL transaction with one lock
for all dates of a series. `persistModelRun` is an alternate object-store contract
requiring an exclusive cross-process lease, insert-if-absent and readback. It introduces no automatic
workflow or schedule. Concrete store writes still require authorized activation.

## Verification and remaining integration

Focused tests cover frozen versions, isolated opening cash, exact FX residual,
first-year/sector sizing, holiday separation, pre-start and delayed-information
exclusion, deterministic reuse, source/state tampering, optional US cash/fees,
quarterly behavior, and retained legacy US/order-preview behavior.

No production migration, deployment, scheduler, user-facing journal projection, or
end-to-end operational run is performed by these modules. No generated result
should be represented as observed strategy performance.
