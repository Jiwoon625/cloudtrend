# Date-effective KR ETF collection evidence

The optional `krLifecycle` source contract records three exact, reviewed ETF
closures from [ACE's official notice](https://www.aceetf.co.kr/cs/notice/7022):
261920, 280320 and 465620 stopped trading on 2026-10-28 and were delisted on
2026-10-29. The stated redemption payment date is 2026-10-30; it is not a
tradeable-price date.

The contract does not classify arbitrary missing candles as delistings. It does
not delete old sources, alter old models, modify the strategy, or fabricate bars.

## Contract

`kr-etf-lifecycle-v1` has exact keys `version`, `sourceUniverseSymbols`,
`requestedCollectionDates`, `events`, `requestedSymbols` and
`latestExpectedSymbols`. Arrays are sorted and unique. Events must exactly match
the maintained official registry, including names, dates and citation.

- The source universe remains recorded, including ceased instruments.
- A mixed window must retain all requested pre-halt observations for those ETFs.
- No new source may contain an affected ETF row on or after its trading halt.
- Every other requested instrument must still have a latest-date observation.
- Both market indices, source keys, actual session dates and instrument identity
  are checked. Requested sessions must match actual market observations within
  the requested window; calendar weekdays are not used to invent sessions.
- The metadata is bound to exact file, logical data, schema and as-of identities.
  Reusing identical input cannot silently discard or change that evidence.
- The optional metadata participates in source-set fingerprints. Legacy sources
  without the field keep their original fingerprint representation.

This contract is independent of KRX publication readiness. FINAL and PRELIMINARY
sources may carry it; neither publication phase waives a missing active symbol,
invalid candle or past official-data gap.

## Interfaces

`registerSourceBytes({ krLifecycle: plan, ... })` validates canonical source rows
before registration. The CLI accepts `--kr-lifecycle <plan.json>` for screening
registration or validation; the authenticated upload finalization endpoint accepts
the same optional plan. Stored metadata is under `validation_result.krLifecycle`.

The private pinned collector must be updated separately and must bind its exact
Node ingest commit. Updating main alone does not change that notebook. A runtime
identity upgrade starts a new execution; an old execution's identity is not
rewritten. Prior checkpoint/source bytes remain preserved. New-version repeated
runs keep normal checkpoint and at-most-once publication/dispatch behavior.

The ETF strategy already rejects an entry when its latest price is not from the
current session. The regression test proves that preserved pre-halt history does
not become a current entry, without globally setting a historical instrument
inactive. Existing source observations that conflict with a later official
notice require separate review, not automatic historical deletion.

## Verification

Run source-pipeline, ETF strategy, October Shadow, KOSPI Shadow tests, TypeScript,
changed-file ESLint and the normal full build. The added pure validation dependency
changes the KOSPI executable manifest, so the exact new digest is independently
reviewed and admitted; the runtime guard itself is unchanged.

A passing fixture/build is not evidence that a provider currently serves an old
instrument. If a bounded pre-halt request still fails, preserve that failure and
review existing verified historical evidence separately. Never mark missing
required history complete merely because the instrument later ceased trading.
