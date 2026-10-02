# Korean dashboard sector-limit labels

The dashboard keeps KOSPI/KOSDAQ entry-ready and KOSPI confirmation-pending signals visible and adds a separate sector-cap annotation. Signal scores, confirmation state, ranking, counts and actual-held/sold suppression are unchanged.

## Source and rules

- Read the existing owner-scoped `portfolio_ledgers.payload` once with the dashboard's actual-ledger query. The source is the saved **strategy ledger**, never actual executions.
- Count positive-share `OPEN` strategy trades from KOSPI and KOSDAQ together by exact `sectorCode`, without translating names or reclassifying sectors. Exclude ETF and US records.
- Use `STRATEGY_CONFIG[candidate.market].sectorCap` and the saved `settings.maxPositions`, matching the engine's `max(1, floor(maxPositions * cap + 1e-9))` rule. The legacy persisted `settings.sectorCap` is not the operational cap.
- At 30 slots the candidate's KOSPI cap is 3 and KOSDAQ cap is 6. A combined sector count of 6 blocks both markets; a combined count of 3 blocks KOSPI but leaves snapshot room under KOSDAQ's cap.
- Current, valid data at/above the cap shows `섹터 제한`, count/limit, and `추가 진입 제한`. Below the cap shows neutral `섹터 여유`, not an entry authorization.
- Missing strategy, malformed holdings/capacity, unknown sector mappings, a signal/strategy-date mismatch, missing generation timestamps, or a strategy calculated before the latest screening generation show `섹터 미확인`. For an otherwise valid but differently dated ledger, retain its count with its actual as-of date and the mismatch warning. Confirmed zero stays `0`, not `—`.
- Fresh screening generation metadata is overlaid on memory, in-flight, sidecar and fresh projections, even when the result digest is unchanged. The timestamp guard is conservative and does not prove atomic matching inputs during concurrent writes.
- The source date is `strategy.summary.latestDate`. The badge states `전략 장부 기준`, the relevant market cap, and domestic slot capacity.

## Timing and safety

The labels describe a saved snapshot, not future execution capacity. Scheduled exits are not deducted before they have closed in that ledger. Multiple same-day candidates are not allocated/reserved by this display. The explanation states these caveats and that room does not guarantee entry.

No replay, strategy sync, screening, backtest, broker order, database migration, cap change or actual-ledger mutation is introduced. The existing compact projection cache is versioned to include canonical sector codes; an old sector-less sidecar is not reused. Counts are recomputed from the freshly read ledger on each dashboard request, including when the screening digest is unchanged. ETF/US and EXIT views do not receive Korean entry-cap badges.

## Verification

- `npx vitest run --config vitest.dashboard.config.ts`
- `npx vitest run --config vitest.portfolio.config.ts`
- Changed-file ESLint and `npm run build`
- Cases cover cross-market counts, exact-code identity, changed operational caps/slot capacity, zero and unknown data, stale/future/invalid dates, pending exits, same-day candidates, pending confirmations, ETF/US isolation, unchanged counts and scores, and owner-scoped read-only server integration

The browser fixture is separate from the application and uses synthetic data. Local cloud-browser access was blocked (`net::ERR_BLOCKED_BY_CLIENT`); live interactive desktop/mobile visual QA is therefore unverified. Server-rendered component assertions verify the visible labels and existing horizontal-scroll/wrapping markup.
