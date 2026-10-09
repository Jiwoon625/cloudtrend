# Current-rule US A0 historical replay

This research branch resumes **US A0 only**. KR/ETF backtests, operating-rules UI
metrics, production publication, and existing Colab notebook pins are not resumed.
The original source data, CM inputs/checkpoints, actual transactions and frozen
Shadow series are read-only and are never changed by this workflow.

## Contract and limits

- Shared current production `runUsProspectiveAnalysis` and
  `stepUsProspectivePortfolio`, with an explicit isolated research context so real
  historical dates do not disable today's fixed-slot policy.
- Initial research NAV USD 74,671.44; fixed new-entry principal USD 3,733.572
  (initial capital / 20), integer shares, fees constrained by remaining cash.
  This is a model normalization, not the user's actual account value.
- One-way cost 0.15%; no quarterly/yearly rebalance, no financing partial sells,
  no forced terminal liquidation. Entry Core 20 / Beta 10 / TK 20 and exit
  Core 30 or three consecutive observations outside Beta 40 use the unchanged
  current A0 signal/execution bodies.
- Source: original adjusted daily prices, 11 annual partitions from 2016-01-04
  through 2026-09-23. The fixed 5,032-symbol universe and sector map describe the
  later current universe. This is **survivor-only exploratory research**, not a
  point-in-time historical universe, unbiased market return, independent OOS
  evidence, certified dividend/corporate-action ledger, or a future return promise.
- Selected evaluation: 2017-01-03 through 2026-09-23, 2,444 observed SPY sessions.
  The stock source starts in 2016; earlier benchmark-only observations cannot be
  counted as stock feature warmup. At least 252 genuine earlier source sessions
  and nonempty ranked stock rows on the first selected session are required for
  full results. First-session rank state initializes the strategy; pre-start
  signal or holdings are not invented.
- Execution ordering includes PR #234 (main `5faca228`) signal-day
  Core/Beta/TK/symbol priority. The isolated research opt-in applies that same
  shared comparator to historical dates while preserving production date guards.
  Trading `coreRank`/position `entryCoreRank` remain execution-close metadata;
  frozen pending `signalPriority` alone determines the next-open buy order.
  Do not interpret execution-close metadata as a signal-time rank.

## Input and output integrity

`prepare-adopted-us-backtest.py` imports the same pure feature function used by
Lite runtime, preserving OHLCV values and calculating one year plus a 400-session
carry window at a time. Only explicit master metadata may enrich the output;
frozen/old feature columns cannot overwrite dated computations. The historical
benchmark's forward labels are never exported to strategy input.

The private job verifies the bucket remains private, the exact transfer manifest
SHA-256 and the catalog digest, pinned source hashes where available, annual
byte counts, schemas, dates, duplicate keys and the frozen source policy. Annual
2017–2026 hashes are observed at download, not independently pre-pinned; their
weaker evidence is retained in private provenance. Credentials are stripped from
preparation/replay child environments. No raw input, positions, daily NAV, secret,
private URL, or subprocess log is placed in Actions logs/artifacts/cache.

Every run writes only allowlisted generated files into a new private research
run path using create-only uploads and read-back SHA-256 verification. Completion
is written last. Bounded aggregate summary metadata enables a connected read-only
check without exposing raw history. No new credentials, permission changes,
public objects, schema changes or database record updates are required.

A full request first performs an actual-source 20-session smoke. A smoke cannot
publish performance. A full result also requires exact session coverage and no
missing/stale NAV marks. CAGR uses actual calendar days / 365.2425; cumulative
return is a separate field; MDD includes the initial-cash baseline. Inspect
`quality.json`, source provenance, trades and daily NAV before presenting a result.

## Execution

The Actions workflow `Adopted full-period backtest` runs isolated code checks on
research-branch changes. Ordinary pushes do not run the replay. A manual dispatch
or exact `run(adopted-backtest): smoke` / `run(adopted-backtest): full` commit title
on the fixed research branch must match the seven-field request JSON. The CLI
refuses KR/ETF modes while that work remains on hold.

The workflow reuses only the repository's already configured private-storage
secrets. It does not generate keys or modify any existing notebook's commit/ZIP
pin. The Lite ZIP change extracts the production US feature function to share
with research; it has no effect on fixed-version notebooks or production main
without a separately authorized promotion.

Research checks are not admission of a new runtime to a frozen Shadow series.
Do not update historical runtime allowlists or production-generated manifests
just to make a research branch pass frozen-integrity assertions. Main merge and
production deployment require a separate review and authorization.

## Expanded US replay (2026-10-09 corrected source selection)

The earlier legacy `research/us/v0` 5,032-name run is preserved for reproducibility
but is **not** the requested expanded-universe result. New US execution reads the
hash-pinned original CM `CloseadjInputsV2` input archives read-only and extracts
only the US monthly market inputs, preparation receipt, verified US calendar and
SPY benchmark into a new private temporary directory. It never reads CM strategy
results/checkpoints, changes CM inputs, or looks up individual corporate events.

The expanded raw 2015-01-02–2026-09-25 source contains 12,568 price identities and
18,195,650 observations. SPY adds 2,950 observations; normalized US inputs preserve
26,353,637 rows including explicit gaps and 12,569 identities including SPY. The
20,989-name master describes the longer original source; that is not the count
of stocks with observations during this stored research period. Literal ticker
`NA` is preserved. No latest ACTIVE, delisting-status or broker-list filter is
used. Current common-stock category and reconstructed as-of exchange eligibility
remain a research proxy, not certified point-in-time historical membership.

Existing verified CM price-dependent `closeadj` features and adjusted comparison
OHLC are reused without recomputation. Original dollar volume and ADV are retained.
The A0 TypeScript scoring, onset/exit tests, signal-priority order, integer units
and 15bp one-way fee remain shared with the operating implementation. The user
subsequently approved `US_A0_ANNUAL_ENTRY_BUDGET_PRIOR_NAV_V1`: the first year uses
USD 74,671.44 / 20 and each later year uses the preceding observed session NAV / 20.
Only new signals receive the new budget. Existing quantities and prior-year pending
intent budgets are preserved; no funding-only sales or rebalancing are introduced. Comparison units are not claimed
to be actual historical share quantities or a separately verified dividend ledger.

The user explicitly chose `US_A0_ALL_HELD_LAST_VALID_CLOSE_EXIT_V1`: at the first
verified source session with no finite positive held-stock close, sell at the
last already observed valid close. Recognition and immediately reusable A0 cash
occur at that missing session's close, after its open orders. Past cash/NAV is not
rewritten. No 27-event exceptions, stock-right conversions, fractions or T+5
corporate-action treatment are applied. This is a retrospective price proxy and
may be optimistic for bankruptcies, suspensions and unexecutable disappearance.
A zero-volume valid close can value a position but cannot execute an ordinary
trade. Incomplete market input, absent SPY or dates after the final verified
source session stop the run instead of triggering mass exits. Final available
positions are marked, not forcibly sold merely because the dataset ends.

The converter writes compressed daily atomic CSVs, retains all warmup source
months, verifies every original partition hash, and records the approved calendar
and source policy in the contract. Full evaluation requires at least 252 actual
prior sessions and usable first-session ranks. Historical performance is not an
expected or guaranteed future return.

The expanded research contract also explicitly enables
`US_A0_COMPARISON_PRICE_8DP_LEDGER_V1`. Sharadar synthetic adjusted opens can have
more than eight decimal places. Only trade-journal execution prices are represented
with the existing eight-place money formatter; original source prices remain in
trade detail and original feature/close valuation prices are unchanged. Quantity,
cash and fees all use the same journal execution price. Values represented as zero
fail closed. Production defaults remain strict.
An extreme comparison quote that provably exceeds the exact remaining entry
budget/cash or one-share participation capacity produces zero quantity before
journal conversion. The source quote is neither capped nor replaced; executable
prices still require the strict ledger representation. Source metadata with LF
inside a CSV field fails closed rather than silently shifting price columns.

Full expanded replay also runs an independent Python arithmetic check of CAGR,
MDD, yearly returns, buy/sell counts, 15bp fees, cash/quantity conservation, annual
budget provenance and same-date SPY comparison before publishing completion. The
full audit stays private; only bounded numeric aggregates appear in private
Storage object metadata. This does not certify historical source completeness or
turn a retrospective exit proxy into an actual executable fill.
