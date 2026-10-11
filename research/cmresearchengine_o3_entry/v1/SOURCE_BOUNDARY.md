# Frozen ENTRY observation boundary for O3

Prepared 2026-10-11 UTC. This is a local research deliverable. No historical strategy run, candidate submission, original-file edit, credential change, or external publication was performed.

## Conclusion

Portfolio-independent ENTRY counts are obtainable from the original frozen CM strategies and inputs. A separate observer can import the pure frozen functions and retain only market-observation state. Existing REF_K/E/U executable-demand logs cannot reconstruct signals already suppressed by portfolio constraints.

The frozen engine commit is `feb420594935151770a03f9bced171061799b59c`. [FROZEN_SOURCE_VERIFICATION.json](FROZEN_SOURCE_VERIFICATION.json) records the nine originally fetched source files and four supplementary files used to verify K scope. All listed files match the local checkout's bytes or independently verified Git blob identity. This is not an entire-tree equality claim.

## Source identity

The [frozen signal module](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L1) has SHA-256 `aafffa083285d25cd51b20791578e7c914b2ce8aa73e2a9f0c1af2a4d2014f8d` and Git blob `14276b2921f5c56430604489d8ed9ff797e113f3`.

The shared US analysis import and [us_session_analysis wrapper](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L164) already exist at feb420. The optimization was not introduced after this frozen commit.

[UPSTREAM_SOURCE_MANIFEST.json](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/UPSTREAM_SOURCE_MANIFEST.json) records an earlier upstream signal hash, `82716e3d67634fec29f4da8cebce52bbaaa486fab2ea5ba77bb7becbc9adcf03`. That matches the separate local `resumable_allocation/runtime/cm06_comparison_signals.py`, not the optimized vendor module. The upstream manifest must not replace the actual [runtime.code_hashes()](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/cmresearchengine/runtime.py#L41) identity.

AST comparison against that upstream file found identical definitions for finite, positive, percentile_rank, us_analysis, normalized_us_row, kr_operational_signals, kospi_confirmation, etf_confirmation, and etf_entry_weight. Differences are in adapter behavior and optimization plumbing.

The module's `FROZEN_SHA=a844945...` identifies the original strategy source. Record that separately from engine commit feb420 and the extension identity.

## K scope: actual execution and input evidence

K is the mixed Korean sleeve in this frozen runtime. This conclusion follows both dispatch code and the prepared input evidence; it is not inferred from the mere presence of KOSDAQ helper functions.

1. [Execution module line 20](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_execution.py#L20) maps `K` to `KR_MIXED`. [Lines 75–92](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_execution.py#L75) construct that adapter with historical_policy=True for the ordinary K/E/U structure.
2. [PreparedResearch.factory lines 55–62](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/cmresearchengine/prepared.py#L55) loads the full K manifest. It creates separate P=KOSPI and Q=KOSDAQ panels only when candidate initial weights contain P.
3. [normalized_day_panels lines 123–133](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_panels.py#L123) applies market restrictions only to structural_split P/Q. The ordinary K panel has expected_market=None and is retained intact.
4. The frozen adapter's [lines 254–277](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L254) uses each actual row's market: KOSPI follows confirmation/RS/bear logic; KOSDAQ follows kosdaq80Onset. Both feed the same K sleeve.
5. The [preparation source lines 195–219](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_prepare_comparison.py#L195) preserves the market column, writes both markets, and explicitly requires readiness for both KOSPI and KOSDAQ before completing the K input manifest.
6. The existing verified full-input inventory contains **613 K symbols: 288 KOSPI and 325 KOSDAQ**. It contains **647,131 KOSPI rows + 646,570 KOSDAQ rows = 1,293,701 K rows**, including warmup.
7. That inventory is `checkpoint_launcher/full_universe_sweep/verified_final_20261004/symbol_inventory.json`, SHA-256 `f7d482068c1f2c446d7f57c9b826cf7b003aa18d164e00a9e602dc8d337f68f1`. Its hash was rechecked against the stored DOWNLOAD_VERIFICATION.json receipt.
8. The matching scan_contract.json has SHA-256 `048631ef9d41337a62ee1aa8d78fd6f266555049f84c4fa61cbea55f21715055`. Its 122 K monthly units also sum to 1,293,701 rows. The contract pins K/manifest.json to `1274b050bf71443cf72d818afceb74f54c2485d07ecad996b1527f4ce301a684` and PREPARATION_RESULT.json to `c6983d4057d8b73175aa4e52dbf65eb2d4decbbddef96a1228aa6ba5faf9d885`.
9. [Frozen ingestion lines 25–27](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/cmresearchengine/ingest.py#L25) pins the CloseadjInputsV2 stage to that same preparation fingerprint. This connects the verified inventory's prepared dataset to the frozen engine's input contract.

Thus a descriptor label such as KR_KOSPI_CONFIRM1_BEAR does not impose KOSPI-only execution. Counting KOSPI only would discard the KOSDAQ entries that the actual original K adapter processes. The inventory is existing diagnostic evidence, not a newly executed historical strategy run; no original parquet dataset was rescanned here.

## Exact intrinsic-entry boundaries

### U: original A0

Observe every analyzed row with `a0Entry=True` immediately after [signal line 220](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L220), before holdings/order filtering.

The [pure formula, lines 41–79](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L41), preserves full-universe percentile ranking, original common/exchange/status/price/return eligibility, core crossing from below 0.8 to at least 0.8, active20 and ADV requirements, beta/liquidity/Amihud thresholds, and TK aggressive confirmation. Bootstrap rank state does not create an onset. Preserve [normalized_us_row's signal_close selection](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L155).

[Lines 222–245](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L222) later derive retained holdings, pending reservations, exiting symbols, ranking order, and the 20-position cap. Those must not enter independent ENTRY counts.

### KOSPI: original confirmation/RS/bear rule

Observe `kospi_confirmation(..., historical_policy=True)` where eligible=True and state='confirmed', immediately after [line 266](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L266).

The [pure function, lines 92–125](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L92), preserves adjacent observed scores, origin and confirmation eligibility, the 8-point crossing/confirmation, no confirmation-day U9.5 exit, positive RSAccel, and complete non-risk-off market gates for both origin and confirmation. A simple raw 8-point crossing is not an equivalent signal.

Portfolio-based blocked-origin and holding-span checks start at lines 267–270; current-holding suppression is at line 274. Exclude those from independent counts while retaining the original research-start origin boundary.

### KOSDAQ: original E8 onset

Observe `kr_operational_signals(...).kosdaq80Onset` from [line 257](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L257) before held suppression at line 274. The [pure onset at lines 81–90](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L81) uses current eligibility and adjacent finite scores crossing 8. The held argument changes exit selection, not this onset boolean. This is a same-day ENTRY without KOSPI's one-session confirmation.

### E: original ETF V02

Start with `etf_confirmation(...).onset` at [line 281](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L281). Preserve [the pure confirmation rules, lines 127–137](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L127): eligible adjacent observations, M0 crossing 80, next-session score at least 80, positive underlying close and MA60, and underlying close at least MA60.

For a data-qualified original ENTRY, also preserve the [non-portfolio prerequisites at lines 288–294](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L288): no krx_batch_pending, valid nonnegative annual volatility through etf_entry_weight, and finite nonnegative average_trading_value20. The frozen predicate permits zero ADV; silently requiring positive ADV would change it.

Exclude holdings, origin_blocked/holding spans, prior portfolio NAV completeness, NAV sizing, cash, and slots. Preserve research-start origin restrictions. Prefer recording pure confirmation and data-qualified ENTRY separately for audit: pure confirmation alone is less restrictive than the adapter's non-portfolio data requirements.

## Minimum observer architecture

A separate observer is sufficient; original signal and execution modules need no edits.

- Consume the same normalized complete session records and verified calendars, with full original warmup.
- Preserve U's date/identity filtering. [Fresh host line 223](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/checkpoint_launcher/s05_fresh_policy_v11/cm06_fresh_host_v1.py#L223) composes DatedActionPanels(DocumentedQuotePanels(...), registry), independently of holdings. These filters affect the ranking universe.
- Keep only K/E two-session histories, U market-rank state, and event deduplication. Do not supply cash, holdings, pending orders, slots, fills, demand amount, or NAV.
- Insert missing individual observations exactly as [signal lines 247–253](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L247) do; do not forward-fill scores.
- Preserve whole-session gaps. [ResearchReplay lines 183–203](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/cmresearchengine/replay.py#L183) clear U rank state and insert missing K/E observations. Skipping a missing calendar session would manufacture adjacency.
- Preserve session uniqueness, monotonicity, and data-availability checks from [signal lines 204–213](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_signals.py#L204).
- Record engine, actual market, symbol, rule version, origin date, confirmation/session date, availability timestamp, and source identity. Group KOSPI/E by confirmation month; KOSDAQ/U use their same-day signal month.
- Use market + symbol + origin date as the semantic deduplication key, retaining engine as provenance. Count each signal once regardless of orders, retries, or fills.
- Warm up before the evaluation start but reject evaluated KOSPI/E origins earlier than that start. U/KOSDAQ origins equal their signal dates.
- An empty-holdings FrozenIntentAdapter is not an equivalent observer: U still imposes its 20-position and pending-reservation constraints.

The [shared US analysis helper](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_shared_us_analysis_v1.py#L29) reuses results only after validating identical date, raw rows, and prior market state. Treat the analysis result as read-only and deep-copy the next state.

## Existing demand logs are downstream of the required boundary

[Comparison execution lines 289–294](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_execution.py#L289) explicitly record executable, non-cash-gated demand after price/volume, zero target/budget, held-name, slot, sector-slot, KOSPI execution gate, holding-window, and capacity checks. Cash checking is later, but earlier portfolio constraints have already removed candidates.

The exact entitlement branch repeats this boundary at [cm06_exact_units_execution_v1.py:96–104](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/checkpoint_launcher/corporate_action_handlers_20261005/exact_units/cm06_exact_units_execution_v1.py#L96).

The [ordinary result export, lines 426–429](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_execution.py#L426), exposes demands and order diagnostics, not every suppressed intrinsic ENTRY. A new observer dataset and extension identity are required; this is not a reaggregation of REF demand logs.

## Source-session completeness and local implementation review

A receipt named COMPLETE must mean that the original hash-bound source session was fully consumed. It does not certify historical point-in-time universe completeness or prove the source provider omitted no instrument.

The original [MonthlyDayPanels loader](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_panels.py#L30) validates the manifest hash/status. Its [month loader at lines 61–90](https://github.com/Jiwoon625/cloudtrend/blob/feb420594935151770a03f9bced171061799b59c/research/cmresearchengine/vendor/resumable_allocation/runtime/cm06_comparison_panels.py#L61) checks monthly bytes, row count, required schema, symbol/date uniqueness, expected session coverage, and missing-value normalization. The observer's caller must retain that verified loading path.

A received source session can have no ENTRY after original per-row gates. A missing source session is a separate fallback condition; it must not become a known zero-signal observation.

The delivered observer uses nonempty verified source sessions for coverage and never adds comparison_close as an ENTRY requirement. Empty whole cross-sections remain MISSING and reset state.

The reviewed direct pure-function calls, K/E market-only history, U state copying, KOSDAQ same-day onset, and ETF non-portfolio prerequisites match the original boundaries. No implementation changes were made by this investigation.

Audit enhancements remain useful: emitted records currently omit actual market and rule version, and ETF pure-confirmation versus data-qualified-entry status is not separately emitted. These are provenance improvements, not demonstrated formula deviations in the corrected version.

## Limits of this verification

This is source inspection and artifact reconciliation. It does not supply new O3 signal counts or performance results. Synthetic parity and resume tests remain the implementation owner's responsibility before any authorized execution. The original current-vintage research-universe limitations remain; the observer does not create historical PIT certification.
