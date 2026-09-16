# V8-12 Priority factor test — Index membership & Market Cap

## Design

- Universe: current CloudTrend 613-stock historical reproduction convention; KOSDAQ trades used for V8 operating-rule comparison.
- OOS folds: 2018, 2022, 2025 (3-FOS).
- Entry: V8 adjusted technical score crosses 8.0 upward; next trading-day open.
- Exit: adjusted score crosses 9.5 upward or 2.5 downward; next trading-day open; otherwise max 60D close.
- Round-trip cost: 30 bps.
- Sector Price Leadership 0.5 slot retained inside the V8 technical score.
- Supply Risk kept separate from V8 Onset/Exit; short-selling share 20D increase and lending-balance 20D increase were recorded only as an overlay.
- Market cap: point-in-time signal-day `marketCap`, not a static/current market cap.

## Sample

- Total trades: 2,547
- 2018: 726
- 2022: 371
- 2025: 1,450
- Overall average net return: +3.6402%
- Overall median net return: +3.6350%
- Overall win rate: 58.4609%

## Market-cap buckets

| Signal-day market cap | N | Avg return | Median | Std dev | Downside dev | Win rate | PF | P10 | CVaR10 | Avg MAE | Avg MFE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| < 3,000억 | 888 | +4.9835% | +2.4736% | 39.9197% | 11.3913% | 56.5315% | 1.7631 | -20.5310% | -26.5207% | -12.5621% | +21.7996% |
| 3,000~5,000억 | 515 | +4.5766% | +4.7162% | 28.5705% | 9.7801% | 62.5243% | 1.8808 | -18.4269% | -24.3034% | -11.5996% | +17.6012% |
| 5,000억~1조 | 583 | +1.5787% | +3.2536% | 18.5897% | 10.7618% | 56.4322% | 1.2546 | -19.1944% | -25.5758% | -12.0880% | +15.3444% |
| 1~3조 | 430 | +2.9594% | +3.9139% | 19.8378% | 10.8712% | 58.6047% | 1.5078 | -19.2095% | -26.9869% | -12.7292% | +16.7061% |
| 3조+ | 119 | +3.5927% | +5.2018% | 16.3088% | 10.0245% | 67.2269% | 1.7137 | -17.6318% | -25.2083% | -13.2497% | +15.3461% |

## Current 3,000억 size-score threshold

| Group | N | Avg return | Median | Std dev | Downside dev | Win rate | PF | P10 | CVaR10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| < 3,000억 | 888 | +4.9835% | +2.4736% | 39.9197% | 11.3913% | 56.5315% | 1.7631 | -20.5310% | -26.5207% |
| >= 3,000억 | 1,647 | +3.0221% | +4.1414% | 22.3661% | 10.4413% | 59.6843% | 1.5298 | -18.7736% | -25.5703% |

Interpretation: the >=3,000억 group did not have a higher raw average return. It had materially lower return dispersion, a higher median and win rate, and modestly better lower-tail metrics. The <3,000억 average was lifted by a stronger right tail; its average MFE was +21.7996% versus +16.4057% for >=3,000억.

Exploratory iid tests (not a substitute for clustered OOS inference because signals overlap): Welch mean test p=0.176, Mann-Whitney p=0.338, median-centered Levene variance test p=0.000254. Thus the return-location difference was not significant under these simple tests, while the dispersion difference was much clearer.

10% trimmed mean return was approximately +1.11% for <3,000억 and +1.72% for >=3,000억, showing that the raw small-cap mean is sensitive to extreme upside winners.

## Fold consistency

For the exact >=3,000억 threshold comparison:

| Fold | <3,000억 avg / std | >=3,000억 avg / std |
|---|---:|---:|
| 2018 | +0.68% / 22.77% | -1.94% / 15.82% |
| 2022 | -3.17% / 22.62% | -2.54% / 16.94% |
| 2025 | +12.80% / 55.30% | +5.77% / 24.57% |

The >=3,000억 group had lower total return dispersion in all three folds. It did not consistently produce higher mean returns. Small caps were much more sensitive to the 2025 strong-upside regime.

Bucket-level equal-fold average return / worst-fold average return:

- <3,000억: +3.4374% / -3.1667%
- 3,000~5,000억: +3.1279% / -3.1323%
- 5,000억~1조: -0.3875% / -3.5181%
- 1~3조: -1.2577% / -8.9773%
- 3조+: -1.9366% / -11.9681% (small 2022 sample; pooled result is dominated by 2025 observations)

No monotonic market-cap return premium was observed.

## Index membership: not yet testable without point-in-time data

The 102-column historical source does not contain point-in-time KOSPI200/KOSDAQ150/KRX300 constituent flags. A historical KRX/pykrx probe was attempted, but the current KRX endpoint requires authenticated KRX credentials in the GitHub runner and could not be queried anonymously.

More importantly, the current manual CSV parser assigns `indexMemberships: ["KOSPI200", "KRX300"]` to every stock. Therefore the current priority-score index-inclusion +2 points are not based on actual membership and have no cross-sectional discrimination in uploaded-data runs. Current membership must not be backfilled into history because that creates look-ahead bias.

## Working conclusion

1. Market-cap >=3,000억 should be interpreted as a stability/liquidity-style priority factor, not an expected-return alpha factor.
2. The 3,000~5,000억 bucket had the best pooled balance of return and downside stability in this run, but the relationship is not monotonic and should not be converted into a multi-tier cap score from this test alone.
3. Keep Sector Rotation separate as incremental-return context and Supply Risk separate as an entry-risk overlay; neither was mixed into the market-cap factor decision.
4. Do not use the current index-inclusion +2 points as evidence-based priority scoring until point-in-time constituent data is added and the parser hardcoding is removed.
