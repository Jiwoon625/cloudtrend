# CloudTrend V8-9b — Penalty Structure Validation

- Run: `34856323519`
- Code: `34c28e02fa106c8fb77c7c23afd2c97915d404cc`
- Dataset: `manual-2026-09-11`, 613 stocks
- OOS: 3-FOS calendar folds 2018 / 2022 / 2025. Supply features have usable coverage in 2022 / 2025 only; `VOLUME_SURGE` has all three folds.
- Baseline: current 10-point score with sector PL slot, GATED_80 behavior.
- Short feature: **short-selling volume-rate change only**. Short-selling amount/value feature is excluded.
- Supply transforms: 20D short-volume-rate change and 20D lending-balance % change.
- Thresholds: same-date, same-market Q70/Q80 cross-sectional cutoffs (minimum 30 observations).
- Missing values are never zero; model comparisons use only eligible stock-days.

## Main finding

Directly subtracting 0.25 / 0.50 points from the score is not supported for the main KOSDAQ80 model. The adjusted score creates many new `penalty-release onsets` when a prior penalty disappears, and these delayed/recovery onsets degrade performance. Therefore the 10-point technical score should remain unchanged and the supply variables should be treated as an **entry risk overlay / veto**, not as raw score points.

## KOSDAQ80, future 20D

### Direct adjusted-score onset

All tested models had non-positive fold consistency. Examples:

- `SHORT_Q80`: mean avg-excess delta **-0.570906%p**, 0/2 folds positive; 308 penalty-release onsets.
- `LEND_Q80`: mean avg-excess delta **-0.022764%p**, 0/2 folds positive; 139 penalty-release onsets.
- `ALL_Q80` (Short Q80 + Lending Q80 + VOLUME_SURGE): mean avg-excess delta **-0.758014%p** for -0.25, 0/2 folds positive; 368 penalty-release onsets.

### Entry-filter diagnostic

Here the baseline 10-point onset is generated first, and a trade is retained only if the adverse trigger is absent.

- `SHORT_LEND_Q80` veto (block when short Q80 or lending Q80 is active):
  - baseline trades 1,312 -> retained 929 (**70.8% retention**)
  - mean avg-excess delta **+0.129552%p**
  - 2/2 folds positive; worst fold **+0.001542%p**
  - mean PF delta **+0.009717**
  - median-excess delta **-0.399138%p**

- `ALL_Q80` veto (block when short Q80, lending Q80, or VOLUME_SURGE is active):
  - baseline trades 1,312 -> retained 559 (**42.6% retention**)
  - mean avg-excess delta **+0.179914%p**
  - median-excess delta **+0.506024%p**
  - mean PF delta **+0.117431**
  - 2/2 folds positive; worst fold **+0.149521%p**
  - 2022 avg-excess delta +0.149521%p; 2025 +0.210306%p

`ALL_Q80` is the strongest 20D KOSDAQ filter in this experiment, but it removes about 57% of eligible baseline onsets, so it is too aggressive to adopt blindly.

## KOSPI75, future 20D

- `SHORT_Q80` entry veto:
  - mean avg-excess delta **+0.131101%p**, 2/2 folds positive
  - worst fold **+0.130472%p**
  - PF delta **+0.044874**

- `SHORT_LEND_Q80` entry veto:
  - baseline trades 1,907 -> retained 1,351 (**70.8% retention**)
  - mean avg-excess delta **+0.108787%p**, 2/2 folds positive
  - worst fold **+0.098377%p**
  - PF delta **+0.093436**

- `ALL_Q80` entry veto:
  - baseline trades 1,907 -> retained 730 (**38.3% retention**)
  - mean avg-excess delta **+0.330128%p**
  - median-excess delta **+0.215521%p**
  - PF delta **+0.224232**
  - 2/2 folds positive; worst fold **+0.256644%p**

## Short-horizon timing

KOSDAQ future 5D showed a different pattern. Blocking baseline onsets whenever 20D short-volume-rate change was merely positive (`SHORT_POS`) improved average excess by **+0.153867%p**, with 2/2 folds positive and worst fold +0.102009%p. This supports using short-selling pressure as a short-term timing/risk overlay, but not as a linear medium-term score component.

## Decision

1. **Do not add short/lending/VOLUME_SURGE as negative points to the 10-point score.**
2. Preserve the existing 10-point score and Onset definition.
3. Add a separate supply-risk overlay built from:
   - `shortRisk20 = short-volume-rate 20D change >= same-market daily Q80`
   - `lendingRisk20 = lending-balance 20D change >= same-market daily Q80`
   - `volumeRisk = VOLUME_SURGE`
4. Best balanced research candidate: block or downgrade entry when `shortRisk20 OR lendingRisk20` is true. It retains about 71% of supply-eligible onsets and improves average 20D excess in both 2022/2025 folds for both markets, though KOSDAQ median improvement is not yet robust.
5. Best strict candidate: block when `shortRisk20 OR lendingRisk20 OR volumeRisk` is true. It improves average excess, median excess and PF in both available 20D folds for both markets, but retains only ~38–43% of baseline onsets.
6. Next refinement should test **risk-count gating** (`>=2 of 3` triggers) and/or ranking downgrade rather than `ANY` veto, to seek most of the strict-filter benefit without removing ~60% of opportunities.

Production scoring remains unchanged after V8-9b.