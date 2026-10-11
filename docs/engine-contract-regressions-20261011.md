# Engine regression contracts, 2026-10-11

## Scope and result

Repaired the 19 pre-existing failures in `scoring.test.ts` (14), `vf.test.ts` (4), and `backtestV4.test.ts` (1). Changed these tests and this explanation only; no production engine, research result, frozen policy, runtime manifest, calendar, or database was changed by this repair. No tests were skipped or removed.

The affected files previously had 53 tests, with 19 failing. They now have 84 passing tests:

- `src/lib/engine/scoring.test.ts`: 59
- `src/lib/engine/vf.test.ts`: 15
- `src/lib/engine/backtestV4.test.ts`: 10

## Why the contracts changed

### Configurable helpers versus current defaults

The old scoring tests implicitly used current defaults while asserting the V4 7-point technical and 8-point priority models. Commit `031a0b5` contains those historical configuration values. The complete technical/priority helper cases now run twice: once with an explicit historical V4 configuration, and once with the current defaults and independently stated expected weights/boundaries. The historical model is tested as an explicit helper input, never reintroduced as the live model.

Current helper defaults are a 5-point technical sub-score and an 8.5-point legacy priority input. Neither is the final stock operating score: production uses strict V8 10-point technical scoring and the separate 5-point V8 priority projection. V8 adoption is recorded in commit `d949f48`; the integration assertions distinguish these layers.

Saved versions 3, 4, and 7 must migrate to version 8, while current-version custom thresholds remain intact. Migration also verifies a fresh configuration object and no mutation of the old input. The old 45/20/25/10 weighted-total behavior remains tested with explicit historical weights. Current stock weights are 100% technical, with no substitution from auxiliary scores when technical data is missing.

The general market-gate label helper is display-only and does not override the current grade label. Actual KOSPI regime entry vetoes remain covered by the separate market-gate and operational-strategy suites. ETF integration asserts the adopted `ETF_POLICY` output and 62.5/7.5/15/15 weight contract instead of the superseded ETF health-row text; adoption history includes `589a150` and `ad303e7`.

### Seven-feature Vf base versus strict V8 operation

`vfStockScore` intentionally preserves the 9.5-point, seven-feature research base. Its partial-data normalization and legacy feature parity remain covered. The eight-feature `VF_FEATURE_WEIGHTS` total is 10 because live V8 adds a separate 0.5-point sector slot; the legacy backtest feature list must not acquire that slot accidentally.

Added literal boundary cases for Stock PL 80 and KOSPI ETF PL 84, including equality and missing PL. Missing PL awards no extra points while retaining the 10-point denominator. Missing core features instead make the strict live/history score null, even when generic normalization would misleadingly yield 100. Screening/history integration checks dated sector PL and raw-score parity, including a missing foreign-flow day that cannot produce an entry.

### Cross-sectional statistics need an actual paired cross-section

The previous fixture gave both symbols the same Onset states. A non-null daily cross-sectional spread was therefore an invalid expectation. It now explicitly asserts null spread/uncertainty and zero paired observations.

A second deterministic fixture generates five separated foreign-flow Onsets in one symbol and none in the control. The test independently computes next-open to horizon-close returns, each symbol's market adjustment, and a Bartlett-kernel covariance-matrix oracle for the HAC t-statistic and 95% interval. It checks exact paired counts and numeric results, plus missing-benchmark behavior. Persistent signal days cannot inflate the five-event count.

## Verification

- Focused files: **84/84 passed**; no skip/todo.
- Complete current engine tree: **464/464 passed in 29 files** after separating the pending membership change. The frozen baseline had 433 tests in 29 files; this repair adds 31 tests.
- Scoped ESLint on the three changed test files: passed.
- Repository `tsc --noEmit`: passed at verification time.
- `git diff --check` on owned files: passed.

The full engine run uses `vitest.engine-contracts.config.ts` with the `@` alias and `test.include = ["src/lib/engine/**/*.test.ts"]`; the existing repository-lint workflow also runs it on pull requests and main pushes. This avoids unrelated Vite application plugins and the repository's separate `node:test` suites; it is not a claim that every repository test runner passed.

## Calendar boundary observed, unchanged

Stored exchange evidence covers 2026-10-05 through 2026-12-31. KR special-session hours for 2026-11-19 remain pending; session-time helpers deliberately throw rather than guess. The [NYSE official calendar](https://www.nyse.com/trade/hours-calendars), checked on 2026-10-11, confirms the stored Q4 2026 US holidays and early closes and also publishes later years. The linked [KRX rules page](https://global.krx.co.kr/contents/GLB/06/0602/0602010201/GLB0602010201T1.jsp) supplies general holiday and regular-session rules, not the specific CSAT notice. No speculative holidays or hours were added. Extending stored coverage or clearing pending KR hours requires a separately reviewed exchange notice.
