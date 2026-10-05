# CMresearchengine

Research-only CM06 orchestration for the existing preregistered allocation plan.
This directory does not change the production app, production strategies,
Supabase tables, account permissions, or deployments.

## Scope and status

- Original evaluation: **2017-08-21 through 2026-09-11**, initial **KRW100m**
- **52 base candidates**: 40 unique static allocations and 12 dynamic policies
- **286** three-engine/cash 10% simplex candidates
- KOSPI/KOSDAQ split comparisons: **70** quarter-grid and **1,001** 10% grid candidates
- Each candidate has its own ledger, orders, reservations, settlements, exact-unit holdings and checkpoint chain
- Code and synthetic tests are provided here. **No historical completion or performance claim is made by this PR**

`plan.py` calls the original `cm06.registry` enumeration rather than inventing
strategies. K-split uses P=KOSPI, Q=KOSDAQ, E=ETF, U=US, C=cash and only the
preregistered static split grids. Dynamic split policies are not generated.

## Uniform exception convention

The known 27 reviewed events run first: 25 direct recipes and two deferred
stock-entitlement bridges. Their source-bound references, exact comparison
units and US cash-merger **T+5 trading-session** payment convention remain.

For other held securities, the first verified trading-session close with no
finite positive comparison close invokes `RETROSPECTIVE_LAST_VALID_CLOSE_EXIT_V1`.
The sale value uses the latest valid close observed by then. Every exit records:

- The missing-session trigger date and its close-availability timestamp
- The reference-price date, timestamp and value
- Quantity, **0.15% sell-side fee** and settlement/cash-availability timestamp
- `retrospective_exit_proxy=true` and `actual_historical_fill=false`

Recognition is at the missing session's close. Existing snapshots are never
rewritten, cash is never backdated, and ordinary sale settlement is counted from
the trigger session. Weekends/holidays are not missing trading sessions. A valid
positive zero-volume close is still a valuation, never an ordinary executable
fill. Missing entire market days do not extend expiring orders or bridge signal
history across the gap. Unknown legal rights are recorded as unmodeled; no
merger terms or extra distributions are invented.

This is a deliberately retrospective research approximation. It is not causal
historical execution, complete point-in-time data, full-tax wealth, or a claim
that one could have transacted at the old close. Raw archive/hash/calendar/
identity corruption still stops the run rather than manufacturing data.

All candidates use **0.15% per side / 0.30% round trip**, with no additional
assumed FX spread in this comparison. Ordinary buys remain whole comparison
units; approved mandatory stock entitlements retain exact rational balances.

## Private inputs

The existing private `cloudtrend-data` bucket is used under:

`<SUPABASE_USER_ID>/research/cm/`

Upload the **26 original files directly into `inputs/`**, preserving filenames:

1. `cm06.batched.stage.CloseadjInputsV2.json`
2. 23 `cm06.batched.CloseadjInputsV2.<sha256>.tar` archives
3. `cm06.batched.stage.Stage2_reference_time.json`
4. One `cm06.batched.Stage2_reference_time.<sha256>.tar`

The source stage JSON and all archive/member hashes are verified. Internal TAR
paths are preserved, restoring 389 normalized files plus 12 calendar/FX
reference files. Stage 1 source archives are not required. Users do not handwrite
a manifest or individually upload the 401 normalized files. The engine creates
an immutable `manifest.json` after validation.

Upload the prepared data-only evidence overlay to:

`evidence/CM06_runtime_private_evidence_20261005.zip`

It contains the locked known-event recipes, evidence receipts, original
experiment specification, and 19 verified reference chunks. It cannot supply
executable code. Its expected SHA256 is
`b3b28b08ef4be32c07c1f50c3e37a35daa5ce3b656b5027931888fe2c891a100`.
No raw prices, user holdings, credentials or private evidence are committed here.

## Dynamic references

Before any dynamic candidate can run, REF_K, REF_E and REF_U must independently
complete. Each reference starts with its own fixed **KRW100m** and has no
inter-sleeve cash transfers. US capital converts using start-observable FX;
its initial native USD budget is then frozen. Reference NAVs are normalized by
their own initial KRW capital; O2 eligible demand divides by each reference's
frozen native budget. Cutoff grids must match exactly, with no filling or
interpolation. References never consume an allocation candidate's NAV, orders or
cash. The entire reference contract is part of the preregistration identity.

## Run and resume

Python 3.12 and the pinned requirements are required. Existing backend-only
GitHub secrets are referenced by name: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_USER_ID`. Do not paste keys into code,
logs, issues or chat. No new credentials, grants or bucket policies are created.

```sh
python -m pip install -r research/cmresearchengine/requirements.txt
export PYTHONPATH=research/cmresearchengine
python -m cmresearchengine.cli plan
python -m cmresearchengine.cli preflight --work /tmp/cm-private/work
python -m cmresearchengine.cli run --stage base --offset 0 --count 1 --max-seconds 3000
```

The **CMresearchengine manual research** workflow defaults to preflight. Run
mode executes only the selected bounded batch, never automatically all grids.
The checked workflow must be available in GitHub's default branch before the
normal manual-dispatch UI can be used; creating a draft PR alone does not merge
or deploy it. Invoke the same selection again to resume. One global concurrency
group avoids competing uploads while create-only commit IDs independently
fence duplicate writers.

Each exact code/data/config/strategy identity gets a separate chain. State is
uploaded and read back before a commit marker; completion requires a finished
reachable state, a verified result ZIP and a verified completion marker.
Changed inputs, policy, dependencies or code cannot masquerade as an old run.
A time cap pauses at a complete event boundary; it does not mark a partial path
complete. Failed events cannot publish a poisoned state.

Results and checkpoints remain in private Storage. Public Actions logs contain
status/counts only. Private files are not uploaded to Actions artifacts or
caches. Completed result ZIPs contain NAV, orders, ledger events, demands,
reviews, metrics and the explicit proxy audit. Private `results/` summary and
completion indexes point to the verified output blobs.

## Verification

```sh
PYTHONPATH=research/cmresearchengine python -m unittest discover -s research/cmresearchengine/tests -v
python -m compileall -q research/cmresearchengine
```

Synthetic tests never contact Storage or read real credentials. Tests in an
environment without PyArrow use an explicit test-only shim that rejects Parquet
I/O; production preflight requires the pinned real package. Actual full-input
preflight and historical runs remain separate, observable verification stages.

`UPSTREAM_SOURCE_MANIFEST.json` records the unmodified source hashes copied
from the reviewed fresh-v11 payload. The single initial vendored host change
removes the S05-only candidate restriction; new policy behavior is isolated in
`cmresearchengine/replay.py`. Every actual run also binds current code hashes.

## Storage documentation consulted

- [Supabase changelog](https://supabase.com/changelog.md)
- [Private downloads](https://supabase.com/docs/guides/storage/serving/downloads)
- [Storage uploads and permissions](https://supabase.com/docs/reference/python/storage-from-upload)

No schema or RLS migration is part of this implementation.
