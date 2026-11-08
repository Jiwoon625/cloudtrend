# CloudTrend P1–P3 R3 — 2026-11-08

This branch contains research code only. Never merge it into an operating
strategy to interpret an unvalidated candidate as an adopted rule.

The private Drive delivery includes bounded evidence, frozen legacy engine
sources, all completed R3 results, an HTML report and a Colab notebook. It needs
no Supabase credential, and the offline pipeline has no operational write API.
The separate read-export workflow was used only to recover bounded dated inputs.
It has no schedule; no results are uploaded to public Actions artifacts.

## Versions and dependencies

- Latest main checked at start and finish: `66a55464235ea8be078ceedfd97b2245d0b42e4d`.
- Historical KR frozen original engine: `38da620ced597eaae4e07b54f36a2173c70d9640`;
  exact overlay sources and their hashes accompany the input package.
- Python 3.12, numpy 2.3.5, pandas 2.2.3, pyarrow 26.0.1; Node 24.22.1.
- `protocol.json` was frozen before new candidate results. No threshold grid or
  new US index-membership rule was introduced.
- `SOURCE_PROVENANCE.json`, `DELIVERY_MANIFEST.json` and each `COMPLETE.json`
  bind input locations, file hashes, experiment IDs and outputs.

## Reproduce

Extract the private ZIP once into a new directory. Keep its relative paths.
The supplied Colab mounts Drive, verifies every delivery hash, and runs with all
logs, intermediate accounts and checkpoints in a new Drive reproduction folder.

```bash
python cloudtrend/research/p123_r3/test_research.py
python cloudtrend/research/p123_r3/run_all.py \
  --workspace /absolute/path/CloudTrend_P123_R3_20261108 \
  --run-dir /absolute/Drive/path/R3_reproduction_20261108 \
  --node /absolute/path/to/node24
```

Reusing the same run directory verifies and resumes completed steps. A changed
code/input hash requires a new run directory; it cannot silently resume the old
experiment. The historical KR runner additionally checks each scenario's output
hashes. Read `*.log` after a failed step, correct the input issue, and use another
run directory if an identity-bound input changed. Existing R1/R2 source outputs
are never edited by these commands.

## Interpretation boundaries

- `runs/p123-r3-recent`: exact original 75 checks, R2 key reproduction and an
  observed price extension through November 6. KR signal November 6 is unknown;
  October 26 remains preliminary exit-only. US October 6 remains a partial
  original-source reconstruction, not a stored complete journal; October 8 is
  missing. These are conditional signal models, not the user's actual account.
- `runs/p123-r3-long-kr`: eight actual reruns on the same frozen 325-symbol
  2017-08-21–2026-09-11 input and engine, with the baseline byte-identical to
  eight original economic files. The legacy universe/sectors are not certified
  point-in-time. This is a conditional historical diagnostic, not independent OOS.
- `runs/p123-r3-long-analysis`: annual and exposure controls; US 1,031 closed
  original-entry episodes from the existing CM05 E account logs. It is not a new
  fully reallocated US long backtest; 20 terminal open episodes are excluded and
  10 proxy-liquidation episodes have a separate exclusion sensitivity.
- `runs/p123-r3-official-analysis`: 16 full engine accounts with fixed common flat
  starts; US October 12–November 6, KR October 14–November 6. KR retains the partial
  October 26 and unknown November 6. Previous ADV, integer quantities, slots,
  fees and sector limits are engine-controlled. Entry sets are checked against
  the dated stored source, without a latest-sector fallback.
- `runs/p123-r3-diagnostics`: retained save-time availability sensitivity. A late
  retained timestamp does not prove there was no earlier publication. This must
  not be described as the actual investor account or as a certified historical
  executable track record. The open-gap rejection is also a counterfactual
  diagnostic until an implementable auction/after-open execution method exists.
- All used intervals have already been examined. None is new independent OOS.
  The earliest new forward signal date is November 9, with next-open execution
  from November 10. No monitoring, orders or operational changes are scheduled.

HTML reports and Notion notes contain conclusions and aggregates, not raw
universe files or credentials. Private reproduction inputs remain in Drive.
