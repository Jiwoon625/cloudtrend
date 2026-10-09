# KR and ETF final-strategy historical replay

Research branch only. This path fixes current strategy rules on real historical dates and reuses production scoring and executors. It never changes actual ledgers, CM research, source objects, frozen contracts or the operating registry.

- KR adopted result is one KRW 100,000,000 account with 30 shared KOSPI/KOSDAQ slots. Strategy baseline is main 847b998b38770e068f7812a9135ce089fab0a946 plus the explicitly approved annual-allocation research policy. Separate KOSPI and KOSDAQ 30-slot accounts are diagnostics; their returns cannot be added to obtain the combined account.
- Each year's first selected market session resets the new-entry budget to previous closing NAV / 30. Existing pending intents retain the budget from their signal/confirmation year. Existing holdings do not rebalance. First-year initial budget is initial capital / 30. No future mark enters a reset.
- ETF uses current V0.2: original onset, next-close confirmation, subsequent available open; 10 slots, the existing volatility weights multiplied by the annual prior-close asset base, confirmation-day trading-value priority, no replacement and MA60 exits. Each pending target is fixed at confirmation, including across year-end. A December onset confirmed in January uses the new year. This annual asset-base change is distinct from the old execution-prior-close NAV sizing.
- Integer positions, 0.15% one-way fees, exact cash, current carry/exception and H60 rules are retained. Open positions are marked without forced terminal liquidation.
- An independent Python Decimal check reconciles all fills to daily cash, fee rounding, NAV = cash + marks, annual budgets, CAGR and MDD. Failure blocks result upload.
- Metrics are historical CAGR and MDD, not a forecast. Smoke or missing/stale valuations withhold metrics. Current-universe and sector metadata applied retrospectively are not point-in-time or independent OOS evidence.

## Inputs and outputs

The source manifest and every input require exact byte/SHA pins. KR/ETF conversion preserves all fields, rows, duplicate order, zeros and empty observations; the existing parser retains its canonical merge policy. The located ETF long-history source is the 768-instrument study, not the current larger recent-only collection.

Prepared CSV gzip files are bounded to approximately 32 Mi characters and split only between complete records, preserving quoted newlines. Each part repeats the original header and is independently hashed. Original source ordering and within-source part ordering are retained. The canonical parser consumes a lazy iterable so all decompressed source texts are never retained together. This avoids Node's single-string limit without changing source data or merge semantics.

The private job reads existing Actions secrets, validates the private bucket, strips credentials from subprocesses and writes create-only results into a new run prefix with hash readback. Raw input, prices, daily NAV, positions and logs never enter public artifacts or caches. Only compact aggregate evidence is attached as private metadata to the completion manifest.

Run a 20-session real-data smoke and inspect actual time/RSS and source bounds before choosing full-period dates. A selected-range completion alone does not certify whole-market coverage. Earlier history remains available for indicators, including recursive ATR.

## Local checks

npx vitest run --config vitest.adopted-backtest.config.ts
python -m unittest discover -s tests -p 'test_adopted*py'
npx tsc --noEmit

Frozen runtime admission is deliberately unchanged. Shared-code research opt-ins alter the executable hash; do not amend production runtime allowlists to permit this branch. This branch is not a production-release candidate.
