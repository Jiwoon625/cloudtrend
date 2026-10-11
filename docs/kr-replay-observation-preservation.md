# KR replay: preserve execution observations independently of scores

The October 12 restart retains a dated observation with a usable open and volume even when its close is missing. The common KR executor already supports that contract. Replay must not discard the symbol before the execution archive or adapter sees the observation.

## Separation

- The replay execution dataset retains current symbols from valid-close bars or observed bars.
- The scoring dataset contains only symbols with a valid current close. Historical prices remain available for execution/archive integrity, but cannot create a stale current score or close signal.
- Restart ETF price observations are built from the execution instruments independently of scored rows. Overall KRX batch-pending checks still defer publication, including when individual or all ETF closes are missing.
- Beta behavior before October 12 is unchanged.

## Verified regressions

`src/lib/shadowReplayObservations.test.ts` runs through the existing October Shadow CI aggregate. It covers missing-close observations for KOSPI, KOSDAQ and ETF through all five KR books, pending fills, existing holdings, exact cash, unavailable NAV, observed holding-day counts, truly absent rows and zero-volume liquidation, the ETF batch boundary and the future decision-time guard.

Complete-input golden fixtures were independently evaluated using pristine commit `524597bb` and the corrected implementation. Holding runtime provenance constant for semantic comparison, beta 10-session and restart 15-session registry/session/archive hashes are identical. Separate replay tests exercise actual generated runtime admission.

The reviewed runtime is recorded separately from the unchanged frozen contract identity. Unknown runtime hashes continue to fail closed. No completed session, original source, CM checkpoint, research result or production ledger is rewritten by this change.
