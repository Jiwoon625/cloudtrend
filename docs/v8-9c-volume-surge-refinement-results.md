# CloudTrend V8-9c — Volume Surge Refinement 3-FOS

- Run: `34862495465`
- Code: `a7e95691afc6e288087dc77d317fe6495ecbf7db`
- Dataset: `manual-2026-09-11`, 613 stocks
- OOS: 3-FOS calendar folds 2018 / 2022 / 2025, with the existing 60-trading-day train/OOS purge metadata preserved.
- Baseline reconstruction check: 30,492 sampled score points, mismatch 0.
- Production score remains unchanged; this is research-only.

## Baseline

Current Volume Surge condition:

- today volume >= 150% of the **prior 20 trading-day average volume** (today excluded)
- CLV >= 0.70, where `CLV=(close-low)/(high-low)`
- contribution = +0.5 points

The baseline 10-point structure and Sector PL slot remain unchanged.

## Tested score variants

1. Current Volume Surge -> **-0.5**
2. Current condition + day return > 0 -> +0.5
3. Current condition + day return >= +2% -> +0.5
4. Volume contribution removed -> 0
5. Current condition + 0% < day return <= 5% -> +0.5
6. volume >= 200%, CLV >= 0.70 -> +0.5
7. volume >= 150%, CLV >= 0.80 -> +0.5
8. volume >= 200%, CLV >= 0.80 -> +0.5
9. volume >= 200%, CLV >= 0.80 plus positive-return / +2% confirmation variants
10. Separate entry-veto diagnostics using the current or stricter surge conditions.

## Primary result — KOSDAQ 80 Onset, future 20D

The current definition remains the best-supported common score definition. No tested replacement robustly beat it.

| Variant | Avg excess delta vs current | Positive folds | Worst fold | PF delta | Trades |
|---|---:|---:|---:|---:|---:|
| Current baseline | 0.000%p | — | — | 0.000 | 2,186 |
| **No Volume points** | **-0.817%p** | **0/3** | -1.530%p | -0.091 | 2,007 |
| Current surge -> -0.5 | -0.634%p | 1/3 | -1.588%p | -0.052 | 2,055 |
| + positive day return required | +0.001%p | 1/3 | 0.000%p | ~0.000 | 2,186 |
| + day return >=2% required | +0.008%p | 1/3 | -0.028%p | ~0.000 | 2,183 |
| volume >=150%, CLV >=0.80 | -0.013%p | 2/3 | -0.273%p | -0.008 | 2,146 |
| volume >=200%, CLV >=0.70 | -0.143%p | 2/3 | -0.463%p | -0.020 | 2,145 |
| volume >=200%, CLV >=0.80 | -0.190%p | 1/3 | -0.639%p | -0.033 | 2,115 |

### Fold detail: removing Volume points

- 2018: baseline avg excess +2.286% -> no-volume +0.757%, delta **-1.530%p**
- 2022: +0.452% -> -0.327%, delta **-0.779%p**
- 2025: +5.530% -> +5.388%, delta **-0.143%p**

Thus removing the +0.5 contribution worsened average market-excess return in **all three OOS folds**.

### Positive-return confirmation is mostly redundant

For KOSDAQ80 20D, requiring `day return > 0` changed only two onset identities across 2,186 baseline trades (1 new / 1 lost). Requiring `day return >=2%` changed only seven onset identities (2 new / 5 lost). The current high-volume + high-CLV condition, when combined with the rest of the 80-Onset score, already occurs overwhelmingly on positive/strong price days. Therefore explicit positive-return confirmation adds very little new information.

## KOSDAQ 80 Onset, future 5D

The same broad conclusion holds at 5D:

- no-volume: avg excess delta **-0.441%p**, 0/3 positive folds
- surge -> -0.5: **-0.413%p**, 1/3
- positive-return confirmation: essentially identical to baseline
- +2% confirmation: +0.005%p average but only 1/3 positive folds

This resolves the apparent tension with the earlier standalone V8-9 regression: Volume Surge can look like short-term overheat **in isolation across stock-days**, yet still be useful as an **interaction term / final confirmation component of a high-score Onset**. Its value is conditional on the rest of the 10-point momentum state, not a standalone directional factor.

## KOSPI 75 Onset

One narrower candidate appeared:

### volume >=200%, CLV >=0.70 -> +0.5

Future 20D:

- mean avg-excess delta **+0.041%p**
- **3/3 folds positive**
- worst fold +0.031%p
- PF delta +0.017
- trades 2,679 -> 2,549

However median-excess delta was **-0.130%p** and negative in all three folds, so the improvement is mainly in the positive tail rather than the typical trade. This is compatible with a momentum/positive-skew strategy, but is too small and market-specific to justify splitting the common 10-point score at this stage.

## Entry-veto diagnostics

Using Volume Surge alone as an entry veto is **not supported** for KOSDAQ80:

- current-surge veto, 20D: mean avg-excess delta **-0.745%p**, only 1/3 folds positive; 2,186 -> 1,352 trades
- stricter volume>=200% + CLV>=0.80 veto, 20D: **-0.433%p**, 1/3; 1,713 trades retained

Therefore the prior V8-9b improvement from the combined `short Q80 OR lending Q80 OR volumeRisk` filter should not be interpreted as evidence that Volume Surge alone is an adverse signal. The combined supply-risk filter has interaction/sample-selection effects; Volume Surge by itself is not a robust veto.

## Decision

1. **Keep the current Volume Surge +0.5 in the common 10-point model.**
2. Keep the existing definition: `volumeRatio20 >=150% AND CLV>=0.70`.
3. Do **not** invert it to -0.5 and do not remove the feature.
4. Do not add a positive-day or +2% condition; they are effectively redundant at KOSDAQ80 Onset.
5. Do not use Volume Surge alone as an entry veto.
6. Keep `volume>=200%, CLV>=0.70` as a KOSPI-specific research note only, not a production change.
7. In the separate Supply Risk overlay, treat Volume Surge only as a possible **interaction/context flag** with short-selling/lending risk, not as independently bearish.
