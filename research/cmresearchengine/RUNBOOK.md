# CMresearchengine manual execution runbook

This is a dry-checked operating plan, not a record of historical execution.
`DISPATCH_PLAN.json` contains the exact sequential workflow inputs. Its tests
verify all 1,409 candidate slots without contacting GitHub or Supabase.

## 1. Gates before dispatch

1. Obtain explicit authorization to merge the reviewed draft research PR. Do not
   merge or deploy merely to make a workflow visible. GitHub's normal manual
   dispatch requires the workflow on the default branch.
2. Keep the latest synthetic CI green on the exact commit to be run. Record that
   SHA. Both workflows pin Python **3.12.14**; scientific/transitive dependencies
   are pinned. Runtime versions are part of each strategy's resume identity.
3. Confirm the existing private `cloudtrend-data` bucket and the intended
   `<SUPABASE_USER_ID>/research/cm/` prefix. No public/RLS/credential change is
   part of this runbook. Only these existing backend secret names are required:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_USER_ID`.
   Their usage is established by existing workflows; current values and current
   configured presence have not been inspected. Never paste them into logs,
   issues, code or chat. The authenticated preflight validates actual access.
4. Wait for all **26 original files** under `inputs/`: two exact stage JSON files
   and 24 TARs. Total source bytes: **2,851,167,429**. Preserve original filenames.
   A browser upload-complete message or object count alone is not a hash check.
5. Also upload the separate **25,691,367-byte**
   `CM06_runtime_private_evidence_20261005.zip` under `evidence/`, unchanged.
   This overlay is additional to the 26 input files. Its pinned SHA256 is
   `b3b28b08ef4be32c07c1f50c3e37a35daa5ce3b656b5027931888fe2c891a100`.
6. Keep TAR/ZIP acceptable under the bucket's current content-type restrictions.
   Total subscription capacity is distinct from an upload's per-file limit.
   The observed dashboard showed an inherited **5 GB** per-file limit; the largest
   required TAR is **133,908,480 bytes**. Preserve private access throughout.

## 2. Exact first dispatches

### Assistant-operated bounded dispatch

The existing manual `workflow_dispatch` remains available. For an assistant or
automation client that can write repository files but cannot call GitHub's
workflow-dispatch API, update this public, non-secret control file on `main`:

`research/cmresearchengine/DISPATCH_REQUEST.json`

A push that changes only that path triggers the same
`CMresearchengine manual research` workflow. The request must contain only
`request_id`, `mode`, `stage`, `offset`, `count`, and `max_seconds`.
The workflow validates the same bounds before the research CLI starts. Change
`request_id` for an intentional retry/resume of the same selection. Never put
credentials, data paths, holdings, prices, or result content in this file.

Workflow: **CMresearchengine manual research**
File: `.github/workflows/cmresearchengine-run.yml`
Use the reviewed branch/commit available after authorized merge. Keep
`max_seconds=3000` (50 minutes) until an actual S05 run establishes safe limits.
The whole Actions job has a 120-minute limit; installation, input download,
preflight and final result persistence occur outside that execution timer.

| Gate | mode | stage | offset | count | max_seconds |
| --- | --- | --- | ---: | ---: | ---: |
| Verify all inputs/evidence | preflight | base | 0 | 1 | 3000 |
| Run S05 first | run | base | 4 | 1 | 3000 |

The first row reads private source objects, validates exact archive/member
hashes, extracts 401 allowed files, verifies all 27 known events and writes the
immutable private input manifest. It does **not** run a historical strategy.

Proceed only when `PREFLIGHT_VERIFIED` appears. For the second row, a
`PAUSED_VERIFIED` result is expected when the time cap is reached. Dispatch the
**same row** again to resume, keeping the same code, Python patch, dependencies,
input hashes and policy. Do not advance merely because the workflow is green.

## 3. S05 measurement and success gate

Record from the actual S05 run, without exposing input data in public logs:

- Setup/download/preflight elapsed time and end-to-end job duration
- Whole-process peak RSS/end-to-end elapsed time from `/usr/bin/time -v`, plus
  the before/after free-disk snapshots in the job log; these do not locate an
  intermediate peak in a particular phase
- Checkpoint compressed bytes and upload/readback elapsed time
- Completed event count, last verified event time and checkpoint sequence
- Final output byte count, hash and completion marker verification
- Proxy-exit count and any unmodeled-rights encounters, only in private results

Current synthetic tests do not establish long-horizon runtime or memory needs.
Full fresh input restoration requires at least **6,002,559,250 free bytes** under
the conservative guard, approximately 5.59 GiB, before evidence/runtime state.
Partial workdir restoration also budgets all members of every incomplete TAR.
Checkpoint reads are bounded at 512 MiB; source objects are streamed to disk.
Actual long-run compressed checkpoint sizes are not yet measured.

S05 is complete only with `COMPLETED_VERIFIED`: a finished reachable checkpoint,
matching state hash, matching result ZIP hash and matching final completion
marker. Review balance/fee/settlement/proxy audits and the report template before
starting the wider plan. Do not interpret this as historical actual-fill or PIT
certification.

## 4. Base, reference and expanded sequence

After the S05 gate:

| Work | stage | offset | count |
| --- | --- | ---: | ---: |
| Static base 1 | base | 0 | 16 |
| Static base 2 | base | 16 | 16 |
| Static base 3 | base | 32 | 8 |
| Independent fixed-budget K/E/U references | references | 0 | 3 |
| Twelve dynamic base policies | base | 40 | 12 |

Use mode `run`, max_seconds `3000` for each row. The already completed S05 is
verified and skipped when its static base batch reaches it. Dynamic candidates
require all three independently completed reference paths; the runner verifies
and reuses their completed outputs.

Then execute `expanded_sequence` in `DISPATCH_PLAN.json`:

- fine: offsets 0,16,…,272; count16 except final count14; total286
- split25: offsets 0,16,32,48,64; final count6; total70
- split10: offsets 0,16,…,992; final count9; total1,001

Never submit the whole list concurrently. GitHub's single concurrency group
prevents overlap, but **it is not a durable queue**: a newer pending run can
replace an older pending run. Wait for each dispatch's terminal outcome, then
resume the same selection if it paused, or advance after every candidate in
that selection has a verified completion.

This version resumes when dispatched again; it does not auto-dispatch future
jobs. There is no promise that all grids run unattended after one click.
No change of framework, persistent credential grant, runner account, public
cache or raw-data artifact upload is needed for these bounded manual runs.

## 5. Transfer and runtime budget

Within a job, the verified input preparation is reused for its selected
candidates; each gets independent trading state. Between fresh hosted jobs,
inputs are restored again because private licensed files are not placed in
public GitHub caches/artifacts.

The exact sequence contains **93 minimum fresh jobs** if every selected batch
finishes within one time cap. At approximately 2.877 GB input+overlay per job,
that is roughly **268 GB of transfer**, before extra resumes/retries. This is a
transfer estimate, not a quoted charge. Verify remaining allowance and actual
S05 throughput before deciding how to execute the whole plan. Do not assume
16 nine-year paths fit inside 50 minutes.

## 6. Private reports and stopping conditions

Use `REPORT_TEMPLATE.md`. Resource counters contain no prices, holdings or source contents and can appear
in the Actions log. Publish research results only to the approved private
research destination. A completion ZIP includes NAV, ledger events, orders,
exposure diagnostics, demands, reviews and the retrospective-exit audit.

- `RESEARCH_BLOCKED`: investigate the exact data/hash/dependency/access issue;
  preserve prior objects. Do not bypass a failed gate or overwrite history
- `PAUSED_VERIFIED`: rerun the same selection; no completion claim
- `COMPLETED_VERIFIED`: verify the private summary and audit, then advance
- Missing input/evidence: wait for upload; never substitute a shorter period,
  a smaller universe or a different strategy
- Changed code/runtime/policy/input: a separate identity; no silent continuation
- Failed GitHub job: distinguish a safe prior checkpoint from an uncommitted
  attempt before retrying; successful workflow status alone is not a completed
  historical strategy
