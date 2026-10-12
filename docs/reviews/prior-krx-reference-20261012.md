# Prior KRX reference display (2026-10-12)

## Scope
Show read-only KRX context in the existing evening-candidate table and stock/ETF instrument detail. Use a shared native disclosure, without new dashboard cards. The summary and every fact show their actual reference dates; unavailable fields say “미수신 / 기준일 미확인”. Each field independently uses the latest valid exact observation at or before the review date. Older observations are marked “직전 참고”; same-day arrivals replace the displayed value/date for that field.

Stock: market capitalization and listed shares. ETF: trading value, market capitalization, NAV, total net assets, listed units, underlying index name and close.

No previous observation substitutes into strategy bars, market-cap eligibility, ETF M0, signal origins, candidate ranking, allocation, quantity, cash or ledgers. Existing October 12 operational-origin guards remain unchanged. No October 8 signal becomes an October 12 candidate.

## Verified date provenance
The deployed Korean collector bundle `cloudtrend_kr_v3_3_3_runtime.zip` has SHA-256 `91d4992be9a2d06916ee2e425cb43d210350eed5e73a83429dbb4d041c8b7aba`.
- `step_06.py`, `official_normalize`: rejects a response unless BAS_DD equals the requested date; normalized date is that verified day.
- `step_11.py`: stock cap/share enrichment merges on date and symbol, then sets KRX_STOCK source.
- `step_12.py`: exact-date enrichment merges without forward filling; exact ETF/stock values are tagged KRX_ETF/KRX_STOCK. Price data has separate Toss provenance.

The display parser requires these exact source tags. It does not infer KRX provenance from a row date alone or use close-times-volume proxies. ETF product fields can be retained when exact KRX trading-value provenance exists even if market cap is missing. Zero trading value is an observed value; nonpositive capitalization, NAV, assets, shares/units or index close is unusable. Invalid/future dates and nonfinite values are excluded.

## Architecture and preservation
- Original `manualDataset` executable parser and frozen calculation pipeline are unchanged.
- A separate presentation parser scans only relevant columns and retains at most the latest usable fact for each field, avoiding a second full history in memory.
- The read-only context is attached after calculation in browser, server-screening and CLI display payloads, and preserved in compact dashboard projections.
- Type-only additions to dataset/row interfaces do not alter executable engine provenance.
- Existing Shadow engine hash remains `sha256:6d17bcaf79a6d0f224fce32030a6daf7e2e6a8bbaf4041fe8f90b8f817bcc424`, with 44 calculation sources. Frozen manifests are unchanged.
- All existing screening/dashboard/instrument and sidecar cache versions remain unchanged. A display release must not trigger automatic server screening, history updates, portfolio synchronization or Shadow replay.
- Cached results lacking the new reference object say “KRX 참고값 준비 전 · 새 스크리닝 후 표시”, not “미수신” or zero. Facts appear naturally after the user's next authorized screening with changed inputs. No enrichment request fetches raw history or triggers a hidden backtest on page load.
- A cached legacy-detail page regression asserts the write-capable server screening function is never called.
- No r4/vf collector changes, stored-source edits, raw-data uploads or remote publication are part of this patch.

## Verification
- Reference model/parser/render tests: 7 passed. Coverage includes October 8 to October 12 holiday/weekend gap, absent/null/zero/nonfinite/future values, individual field date replacement, partial ETF provenance, bounded retained observations and original-engine dataset equality.
- Full analysis excluding display context, snapshot output and deterministic portfolio ledger output remain equal, including policy/score/ranking/quantity/cash fields.
- Dashboard config: 607 passed, including cached legacy-detail reads without server calculation calls. ETF date-label copy changes were followed by 17 passing ETF UI tests.
- Engine contracts: 648 passed.
- Portfolio config: 140 passed.
- Source-pipeline config: 103 passed.
- October Shadow: the initial 105/106 result had a pre-existing date-dependent fixture failure, reproduced in the released checkout. The test uses the October 5 series but omitted requestedVersion; from October 12 the production loader correctly selects the restarted series. Passing the fixture's existing series.version at that one test call restores its intended error-path coverage without changing production or assertions. Final suite rerun follows this fix. Frozen-manifest tests pass (37).
- Screening freshness: 56 passed; compaction: 54 passed; memory regression: 328 passed. Existing publication mocks were connected to the new presentation-wrapper boundary while keeping the original parser mock for legacy Shadow tests.
- Automated review found one P2: compaction could replace new reference-only facts with unavailable sentinels. Fixed only display-only fields (listedShares, ETF NAV/AUM/units/index name), with eight sentinel cases proving pre/post-compaction reference equivalence and unchanged engine datasets. No actual compaction was executed.
- Changed-file ESLint and TypeScript no-emit checks passed.
- Production build (`npm run build`) passed; final ETF copy-only change was also rebuilt.
- Independent review: no blocking defects; 69 independent regression tests and TypeScript check passed.

An unconfigured broad Vitest invocation also encounters Node-test files and router/server mocks intended for separate configurations; the project-specific configurations above are the meaningful regression runs.

## Release boundary
Publication and review/CI/merge/deployment verification are authorized; PR #268 is under review. A live post-deployment UI check has not been performed. Today’s technical preliminary candidates can only appear after today’s screening actually supplies them.

The old ETF `krxReferenceDate` display was also corrected: it represented a strategy previous-session comparison, not independently verified fact availability. Product pages now label that date as the strategy comparison date and direct KRX fact-date checks to the shared reference disclosure.

## Conservative limitation for existing calculation fields
The existing calculation merge deliberately preserves finite zero/negative values in ETF market capitalization and underlying-index close. If a later duplicate of the same date overwrites an earlier positive value with one of these invalid-for-reference numbers, compaction can remove the earlier usable display fact. After compaction, the reference disclosure conservatively omits it rather than showing a false zero, date or repaired trading input. Four explicit regression cases freeze this distinction and verify unchanged engine datasets. Fixing this by changing calculation merge rules is outside the display-only scope; no archived source history is silently reintroduced.

The date-dependent legacy Shadow fixture correction subsequently passed the full 106-test suite. Final cache-preserving dashboard suite passed 607 tests; screening memory passed 328; final compaction suite includes the four limitation cases in addition to the eight new-field sentinel cases.
