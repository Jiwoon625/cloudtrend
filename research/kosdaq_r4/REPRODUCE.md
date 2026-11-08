# CloudTrend KOSDAQ R4 — high-score exits and index gates

Run date: 2026-11-08 KST. This branch adds research files only. It does not change
the collector, operating screening, actual ledger or adopted strategy settings.

## Frozen tests

`protocol.json` fixes 14 conditions before their outputs: baseline; high-entry-score
≥9 additional H3/H5/H10 closes; closing-peak trailing 5/8/10%; trailing 8% armed
after +3%; H5+trailing8%; all-entry trailing8% control; KOSDAQ SMA20 entry stop,
risk-off held-name cap5/cap10; and a fixed trailing8%+cap10 combination. Primary
conditions are H5, trailing8%, stop and cap10. No threshold grid optimization.

The holding clock includes the entry session. H5 signals after the fifth close
and executes at the subsequent observed positive-volume open. A trailing trigger
uses max(entry open, observed closes), confirms at a close and fills the later
observed open; gaps are not clipped to the threshold. Original DOWN30/UP90/H60
exits remain, so the earliest executable exit wins in the primary experiment.

`protocol_exploratory.json` is separately labeled AFTER the primary outcomes. It
tests replacing only held high-score UP90 exits with the already fixed H5 or
trailing8% rule, keeping DOWN30/H60 and all lower-score rules. It is exploratory,
not a pre-registered or independent validation result. `runner_exploratory.ts`
also evaluates these exits on every fixed original baseline entry.

The market gate uses the actual KOSDAQ index, not an ETF proxy. The previous
completed market session close is compared strictly to its 20-session SMA.
Below SMA20, cap5/cap10 means maximum held distinct names before another buy;
existing positions are not forcibly sold. Above SMA20 the normal 30-slot limit
returns. Per-name budget remains annual prior-close NAV/30. Gate-blocked Onsets
are cancelled rather than carried indefinitely into a later market regime.

## Execution definition

The legacy engine contains synthetic prior-open liquidation on missing/zero-volume
data. The original baseline had 14 such exits. Its eight economic files are
reproduced byte for byte against R3, but it is a legacy model comparison.

The strict research copy removes this synthetic exception plan. It retains the
same annual allocation, score exits, ordinary H60 and observed price/fee rules.
Unresolved positions remain held; exits require observed tradable prices.
The final report prioritizes the strict results and separately retains legacy
definitions. Cash/NAV and missing/zero-volume held marks are audited explicitly.

## Inputs and limits

- Latest main pinned at `66a55464235ea8be078ceedfd97b2245d0b42e4d`.
- R3 code: `1798e3ed5dc30469d007af32f459dc8552a1dffe`.
- Frozen historical engine original: `38da620ced597eaae4e07b54f36a2173c70d9640`.
- Long: 2017-08-21–2026-09-11, same frozen 325-symbol roster; NOT PIT certified.
- Recent ticket replay: same R3 observed signals and prices through 2026-11-06.
- Complete-classification account window: 2026-10-14–2026-11-06, flat 30m KRW start.
- KR signal gaps 9/8 and 9/14, preliminary exit-only 10/26 and incomplete 11/6
  journal are preserved. Retained-save-time sensitivity is not the actual account.
- Historical index has warm-up from 2016; missing 9/14–9/21 index rows were
  recovered from a verified archived package and object, not interpolated.
- Python 3.12, numpy 2.3.5, pandas 2.2.3, pyarrow 26.0.1; Node 24.22.1.

## Reproduce from the private Drive ZIP

Extract `CloudTrend_KOSDAQ_R4_20261108.zip` into a new directory and verify the
companion SHA file and `DELIVERY_MANIFEST.json`. The delivery is self-contained
and contains bounded inputs, original/modified research engines and R3 economic
references. No Supabase or other credential is needed.

```bash
python research/kosdaq_r4/run_all.py \
  --workspace /absolute/path/CloudTrend_KOSDAQ_R4_20261108 \
  --run-dir /absolute/Drive/path/R4_reproduction_20261108 \
  --node /absolute/path/to/node24
```

The supplied Colab mounts Drive and uses the same command. Logs, per-scenario
COMPLETE markers and step manifests are saved directly in the run directory.
Reusing its run ID verifies and resumes saved scenarios. Changed code or input
requires a new run ID. Interrupted engine copies are renamed and preserved.
No prior R1/R2/R3 result is overwritten or deleted.

All used intervals are reused research data. There is no independent OOS or
adopted operating candidate. New future signal validation starts with signals
first generated on or after 2026-11-09; already inspected 11/6 signals do not
become new OOS merely because a later open executes them. No automation or
orders are created by this delivery.
