# CloudTrend V8-13 — Priority Index Weight Portfolio 3-FOS

## Design

- Folds: 2018 / 2022 / 2025
- Market: KOSDAQ
- V8 entry: adjusted technical score 8.0 upward Onset → next trading-day open
- Exit: score 9.5 upward / 2.5 downward crossing → next open; otherwise max 60D close
- Round-trip cost: 30 bps
- Portfolio limits: 10 / 20 / 30 positions
- Allocation: equal fixed slot = 1 / max positions, no automatic rebalancing, cash allowed
- Priority score used only to rank simultaneous entry candidates:
  - KOSDAQ150 point-in-time membership: +0 / +0.5 / +1 / +2 experiment
  - market cap >= 300B KRW: +1
  - signal-day excess return vs KOSDAQ >= 2%p: +1
  - Sector Rotation Score / 100: +0~1
  - Supply Risk: 0 / -0.5 / -1
- Tie-break: priority score desc → V8 technical score desc → signal trading value desc → symbol
- KOSDAQ150 membership comes from KRX point-in-time history supplied by the user.

## Data / coverage

- Candidate signals: 2,547
  - 2018: 726
  - 2022: 371
  - 2025: 1,450
- Sector Rotation coverage: 2,547 / 2,547
- Relative-return coverage: 2,547 / 2,547
- Market-cap coverage: 2,535 / 2,547
- KOSDAQ150 member candidates: 793 / 2,547
- Historical Sector Rotation map: 32,858 date-sector points

## Equal-fold summary

| Index points | Positions | Mean fold return | Median fold return | Worst fold | Ann. vol | Mean Sharpe | Mean MDD | Worst MDD | Index-member trade share |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 10 | 37.13% | -21.28% | -32.45% | 29.19% | 0.44 | -32.50% | -39.13% | 37.99% |
| 0.5 | 10 | 23.82% | -12.15% | -30.50% | 31.93% | 0.43 | -33.55% | -41.61% | 46.29% |
| 1 | 10 | 25.47% | -3.42% | -30.50% | 31.42% | 0.50 | -32.12% | -39.59% | 48.93% |
| 2 | 10 | 28.58% | -5.98% | -32.72% | 31.19% | 0.48 | -33.46% | -41.63% | 50.03% |
| 0 | 20 | 33.30% | -1.23% | -21.52% | 24.84% | 0.72 | -26.01% | -29.72% | 35.68% |
| 0.5 | 20 | 48.16% | -8.11% | -21.94% | 26.09% | 0.80 | -26.04% | -31.30% | 39.63% |
| 1 | 20 | 20.02% | -12.42% | -21.94% | 24.93% | 0.43 | -26.04% | -31.29% | 42.81% |
| 2 | 20 | 15.43% | -19.21% | -21.94% | 25.25% | 0.30 | -27.73% | -35.49% | 44.49% |
| 0 | 30 | 31.78% | -0.56% | -20.55% | 21.70% | 0.57 | -22.74% | -26.15% | 34.23% |
| 0.5 | 30 | 33.61% | -5.47% | -20.55% | 21.76% | 0.56 | -23.10% | -27.24% | 37.10% |
| 1 | 30 | 23.31% | -5.73% | -20.55% | 21.22% | 0.45 | -23.10% | -27.24% | 38.59% |
| 2 | 30 | 22.74% | -6.71% | -20.55% | 21.23% | 0.44 | -22.86% | -27.25% | 39.40% |

## Fold returns

| Positions | Index points | 2018 | 2022 | 2025 |
|---:|---:|---:|---:|---:|
| 10 | 0 | -21.28% | -32.45% | +165.10% |
| 10 | 0.5 | -12.15% | -30.50% | +114.12% |
| 10 | 1 | -3.42% | -30.50% | +110.33% |
| 10 | 2 | -5.98% | -32.72% | +124.43% |
| 20 | 0 | -1.23% | -21.52% | +122.66% |
| 20 | 0.5 | -8.11% | -21.94% | +174.52% |
| 20 | 1 | -12.42% | -21.94% | +94.42% |
| 20 | 2 | -19.21% | -21.94% | +87.43% |
| 30 | 0 | -0.56% | -20.55% | +116.46% |
| 30 | 0.5 | -5.47% | -20.55% | +126.84% |
| 30 | 1 | -5.73% | -20.55% | +96.22% |
| 30 | 2 | -6.71% | -20.55% | +95.48% |

## Findings

1. The index weight works mechanically: higher points raise the share of accepted KOSDAQ150 trades. The effect is strongest in the 10-position portfolio (about 38% at 0 points → 50% at 2 points).
2. The individual-trade result that KOSDAQ150 members have lower dispersion does **not** translate into a monotonic portfolio volatility/MDD benefit. Portfolio timing, capacity constraints and displacement of non-member signals matter more than the standalone trade distribution.
3. For 20 positions, 0 points has better median fold return, worst-fold return, annualized volatility and worst MDD than +0.5/+1/+2. The +0.5 result has a higher mean return only because 2025 rises to +174.5%; 2018 and 2022 are both worse than the 0-point case.
4. For 30 positions, 0 points is also the most robust on median return and drawdown. +1/+2 slightly reduce mean annualized volatility (~0.47~0.48%p) but lower returns and do not improve worst MDD.
5. For 10 positions, +1 improves 2018 and the median fold return materially, but does not lower volatility or worst MDD; +2 adds no further robustness. This is a concentration-specific ranking effect, not a general index stability premium.
6. Every tested scenario is positive in only one of the three folds (2025). Therefore arithmetic mean returns are dominated by the 2025 bull regime. Median fold return, worst-fold return, volatility and MDD should receive more weight than the mean when choosing the priority design.

## Working implementation conclusion

- The current +2 index-inclusion weight is not supported as a general portfolio-stability factor.
- For 20–30 position operation, the 3-FOS evidence supports removing the index points from the primary priority score rather than keeping +2.
- For a concentrated 10-position portfolio, index membership may still be useful as a secondary tie-break / concentration-control feature, but the current experiment does not show a clean volatility or drawdown benefit from a full +1 or +2 weight.
- Market-cap +1 remains a more direct stability/liquidity component based on V8-12; index membership appears redundant with size and can displace higher-upside non-members under capacity constraints.
