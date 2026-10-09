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
