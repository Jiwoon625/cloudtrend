# KR and ETF final-strategy historical replay

Research branch only. This path fixes current strategy rules on real historical dates and reuses production scoring and executors. It never changes actual ledgers, CM research, source objects, frozen contracts or the operating registry.

- KR adopted result is one KRW 100,000,000 account with 30 shared KOSPI/KOSDAQ slots. Strategy baseline is main 847b998b38770e068f7812a9135ce089fab0a946 plus the explicitly approved annual-allocation research policy. Separate KOSPI and KOSDAQ 30-slot accounts are diagnostics; their returns cannot be added to obtain the combined account.
- Each year's first selected market session resets the new-entry budget to previous closing NAV / 30. Existing pending intents retain the budget from their signal/confirmation year. Existing holdings do not rebalance. First-year initial budget is initial capital / 30. No future mark enters a reset.
- ETF uses current V0.2: original onset, next-close confirmation, subsequent available open; 10 slots, the existing volatility weights multiplied by the annual prior-close asset base, confirmation-day trading-value priority, no replacement and MA60 exits. Each pending target is fixed at confirmation, including across year-end. A December onset confirmed in January uses the new year. This annual asset-base change is distinct from the old execution-prior-close NAV sizing.
- Integer positions, 0.15% one-way fees, exact cash, current carry/exception and H60 rules are retained. Open positions are marked without forced terminal liquidation.
- An independent Python Decimal check reconciles all fills to daily cash, fee rounding, NAV = cash + marks, annual budgets, CAGR and MDD. Failure blocks result upload.
- Metrics are historical CAGR and MDD, not a forecast. Smoke or missing/stale valuations withhold metrics. Current-universe and sector metadata applied retrospectively are not point-in-time or independent OOS evidence.
- Execution follows the existing daily-bar convention: observed open and final daily volume validate tradability. This is historical reconstruction, not certification of intraday data-arrival timing. Independent verification recomputes arithmetic, annual sizing and cash timing from outputs, not the source prices or signal engine.

## Inputs and outputs

The source manifest and every input require exact byte/SHA pins. KR/ETF conversion preserves all fields, rows, duplicate order, zeros and empty observations; the existing parser retains its canonical merge policy. The located ETF long-history source is the 768-instrument study, not the current larger recent-only collection.

One pinned source requires a verified identifier recovery for KODEX 200커버드콜액티브 (0219E0), confirmed against the existing public mapping and issuer listing. A source-hash, product-name, period and row-count guard appends a derived `code` column; all original cells, including the damaged identifier, remain present. The established parser's later alias wins. There is no general scientific-number conversion or ticker guessing. The prepared manifest records the identity evidence and affected count. The unchanged ETF eligibility function permits both equity and option-overlay products; the mapping's rotation-source label is not an eligibility exclusion. Eligibility and sufficient history must be evaluated by the actual strategy engine.

Prepared CSV gzip files are bounded to approximately 32 Mi characters and split only between complete records, preserving quoted newlines. Each part repeats the original header and is independently hashed. Original source ordering and within-source part ordering are retained. The canonical parser consumes a lazy iterable so all decompressed source texts are never retained together. This avoids Node's single-string limit without changing source data or merge semantics.

The private job reads existing Actions secrets, validates the private bucket, strips credentials from subprocesses and writes create-only results into a new run prefix with hash readback. Raw input, prices, daily NAV, positions and logs never enter public artifacts or caches. Only compact aggregate evidence is attached as private metadata to the completion manifest.

For evaluation after 2026-09-11, an additional preserved private screening source is resolved by exact owner, file SHA-256, byte count, source type and preserved status. Its original object is read-only. Only actual Korean STOCK and KOSPI/KOSDAQ INDEX observations after the base cutoff are appended; earlier dates and all ETF rows from the extension are excluded. The original base catalog stays unchanged, and the extra source hash is recorded separately. Observed index/stock dates extend the replay calendar without constructing weekdays or holiday assumptions. This remains observed-session evidence, not an independent exchange-calendar certification.

Run a 20-session real-data smoke and inspect actual time/RSS and source bounds before choosing full-period dates. A selected-range completion alone does not certify whole-market coverage. Earlier history remains available for indicators, including recursive ATR.

An explicit request mode `symbols` runs only a source-column classification audit. It stores a bounded private summary of non-six-character ETF identifiers, counts and source-order numbers. Its status is `INPUT_CLASSIFICATION_ONLY`, never performance completion. It does not remove, rewrite or normalize any source beyond reporting the existing parser's normalization alongside the original identifier.

## Local checks

npx vitest run --config vitest.adopted-backtest.config.ts
python -m unittest discover -s tests -p 'test_adopted*py'
npx tsc --noEmit

Frozen runtime admission is deliberately unchanged. Shared-code research opt-ins alter the executable hash; do not amend production runtime allowlists to permit this branch. This branch is not a production-release candidate.

The pinned September join also requires 6,160 overlap rows, at least 6,150 exact OHLC comparisons and 20 compared index rows. At most 10 unmatched rows from a single stock with no pre-cutoff base history may remain as explicitly unmatched evidence; these old extension rows are never replay inputs. Missing dates for an already observed base symbol fail closed.
