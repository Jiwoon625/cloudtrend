# Dated downstream reconciliation

This separate wrapper leaves the collector, notebooks, existing engines and frozen policies unchanged. After an eligible successful ordinary upload-dispatched CloudTrend screening or US Prospective Screening workflow completes, it checks every reviewed session from the integrated accounting start through the latest completed market model date. A manual run defaults to inspection only.

The wrapper does not infer completeness from the latest Korean model head. It verifies each required market's completed model publications, dated integrated inputs and both integrated books. An exact validated outbox can restore a missing immutable input even behind an already advanced head. The original integrated engine then appends only the globally complete chronological prefix; its predecessor and decision-clock guards remain authoritative.

## Trigger chain

The unchanged KR verified-upload callback dispatches `cloudtrend-analysis.yml`; its `run-screening.ts` runs restart-market replay for final sources. The unchanged US verified-upload/archive callback dispatches `US Prospective Screening` (including its multi-date atomic chain). This observer listens to those successful dispatch workflows directly, not the separate older KOSPI Shadow workflow. The only existing downstream workflow edit is a US `run-name` completion label. Recovery dry-run and apply-without-screen are excluded. Ordinary US screening and verified atomic apply-and-screen (`replay_apply=true`, `replay_then_screen=true`) are eligible: the unchanged collector uses the latter for multiple uploaded dates. A manual apply-and-screen uses that same explicit mutation path and is also eligible. Own repository, main branch, matching completed/current commit, successful conclusion and workflow identity are mandatory. Older/stale commits, forks, PR/push validation, and KR issue-comment runs do not trigger this observer. KR comments still run their existing screening/integration path; recovery without screening can be followed by an explicit manual reconciliation. No collector or engine file changes. A main-branch change during upstream execution makes that completion ineligible; a later ordinary upload or explicit manual run is needed. A failed or disabled upload callback cannot be fixed by this downstream observer.

`WAITING` resumes only on a subsequent successful screening or an explicit manual run. This release adds no timer or finality-boundary wake-up. A failed predecessor with partially committed work likewise needs a later successful run/manual inspection.

## Safety and limitations

- Missing both staging and retained outbox is `REPAIR_REQUIRED`, not success and not permission to recompute old history from today's data. An explicitly reviewed dated capture is needed for that exceptional repair.
- Missing market publications or not-yet-due model decisions remain `WAITING`. This includes preliminary Korean data and a delayed US counterpart. No later date jumps a missing predecessor.
- The wrapper does not create market model publications, initialize books, alter actual trades, rescore raw data, replace an existing dated input, or rewrite historical journals.
- Exact storage readback and a fresh fingerprint guard precede each write phase. A concurrent change or uncertain response stops this invocation. Later runs inspect the actual committed prefix and reuse it; no blind retry.
- The wrapper has a dedicated concurrency group so it cannot cancel queued original workflows. Existing optimistic append guards and fresh fingerprints remain necessary: KR/US workflows may finish while this job is running. Repeated wrapper triggers can coalesce while one is running; the next retained run inspects the full dated horizon.
- The reviewed calendar currently ends 2026-12-31; Korean 2026-11-19 special hours await verification. This enhancement does not extend calendar evidence or weaken its holds.
- Public workflow output contains only dates, counts and hold reasons. No raw source data, credentials or private financial payload is published. Existing private storage and RPCs are reused, with no new credentials or permissions.

## Verification

`npx vitest run scripts/integrated-reconcile tests/integrated-allocation-replay.test.ts`

`npx tsc --noEmit -p scripts/integrated-reconcile/tsconfig.json`

`npx eslint scripts/integrated-reconcile scripts/build-integrated-reconcile.mjs`

Before applying, run the workflow manually with apply=false and verify the dated report. After release, test three trading days, a weekend/market holiday, delayed US data, an exact recoverable middle outbox, an unprovable middle gap, repeated runs and partial publication/resume. A successful code test is not a claim that live historical inputs are complete.

## Bounded read design (local candidate; live verification still required)

The entrypoint first verifies both integrated heads, all eight model date grids and
fresh generation presence for every staged input. If already aligned it returns
`NO_WORK_METADATA_ONLY`, `payloadProvenanceRevalidated:false`, and performs no
writes. This is a missing-date/presence check, not a historical payload integrity
scan. Operational/auth/budget errors stop; they do not silently retry as a full scan.

A mutation path still verifies real market publication chains and every input
required by the existing frozen engine. A verified prior integrated checkpoint can
bound the US payload range to the earliest prior US session of both books plus new
sessions. All KR history remains required. Both books' K/E/U calendar grids and
original checkpoint rows are checked; all historical staging generations remain
freshly checked. Older US bodies are presence-only archival checks, not newly
verified source payloads. Missing/weak initial proof selects full mode; later
checkpoint/generation invalidation stops rather than dynamically widening scope.

Validated envelopes are retained only within one invocation. Each reuse requires
a fresh strong object ID/version/ETag/size probe. Changed generations trigger
revalidation or checkpoint abort; weak metadata never enables reuse. The scoped
Storage info transport adds a unique `cacheNonce` plus `no-store` and preserves
existing authentication. The existing engine can consume these pinned, rechecked
envelopes through a separate read-only client bridge; engine files are unchanged.
No persistent cache, new destination or credential is introduced.

Automatic/manual apply responses share a **256 MiB consumed-response / 1,000 request**
invocation cap. Manual read-only acceptance defaults to **8 MiB**; an explicit
`inspection_budget_mib=256` selects the larger read-only inspection budget. Exhaustion stops and reports aggregate usage; it is not success.
This is a defensive client consumption bound, not an exact invoice/egress ceiling:
transport buffering, headers and network compression are not invoice measurements.

Captured historical cost evidence: the original 28 staged objects total 133,458,377
bytes. Checkpoint-bound October 28→29 inputs total 49,188,169 bytes; the historical
three-day October 23→28 catchup inputs total 59,580,353 bytes. Add market-model
chains (~8.69 MB for the captured 115 records), checkpoint heads (~2.08 MB), and
when needed historical lineage chains (~14.53 MB once). These are actual captured
sample sizes, not universal bounds or billed egress. Aligned no-op and ordinary
first-date waiting download **zero staged payloads**, only heads plus small
model/generation metadata. Growing required KR history remains linear and can
hit the explicit cap; it is never silently skipped.

Official transport evidence: [Smart CDN bypass](https://supabase.com/docs/guides/storage/cdn/smart-cdn),
[Storage info API](https://supabase.com/docs/reference/javascript/file-buckets-info).
The separately approved single live fixed-object probe passed: 3 fresh info
requests, 1 payload, 2,569,698 consumed bytes, repeated hash equality and unchanged
operational tables/object generation. This validates transport, not production
end-to-end reconciliation. Full-feature read-only acceptance and explicit
automatic-activation approval remain required.

### Historical source vintages and ordinary finality waiting

A reviewed retrospective market-model publication can legitimately have a different
source vintage from an older immutable input already consumed by both integrated
books. A mismatched hash is never silently replaced. The separate pure historical
lineage verifier requires all five frozen KR model receipts and reviewed markers,
an exact original prepared-evidence audit, both complete original integrated
publication/hash chains, and recomputation of the historical K/E input hashes from
the original prior ledgers and required KR history. These must equal the receipts
retained at both pinned checkpoints. The exception carries explicit typed date,
stage/source/model hashes and proof hash into the completion checker. It cannot
apply to pending dates, US evidence, missing/outbox evidence, or dates beyond either
checkpoint. Newly appended dates keep strict source equality. This proves prior
consumption and lineage, not independent correctness of the underlying source.

The invocation-local proof cache binds all relevant input/model/checkpoint hashes;
original checkpoint rows, generation identity and prepared audit candidates are
freshly rechecked. The preserved example needs approximately 14.53 MB of integrated
chain payloads once, plus small audit rows, not a new persistent cache.

When both verified integrated heads are aligned and the *first* pending global
session still lacks a complete market publication, the quick path validates every
historical date grid and staging generation through that checkpoint and returns
`WAITING_METADATA_ONLY` with missing-market counts. It downloads no input bodies
and makes no mutation or finality/source-provenance revalidation claim. Any ready
first pending date, divergent heads, historical hole, malformed grid or weak/missing
historical generation selects the full verified path. Operational errors stop.

Observed offline post-repair shape (heads October 29, US published October 30,
KR October 30 not published) uses 20 database metadata queries and 28 historical
generation probes with zero input bodies. Generation IDs/ETags partly simulated
in that offline fixture are explicitly not evidence of live transport freshness.
The separately approved fixed-object probe validates the live transport only; its
success does not authorize automatic reconciliation activation.

### Three-trading-day regression evidence

The synthetic in-memory IO suite uses the real adapter, completion checker,
existing integrated staging/replay/adapters, ledger verification and publication
engine. Friday October 23, Monday October 26 and Tuesday October 27 produce six
book rows; rerun produces zero; an injected partial append failure resumes only
two missing rows; an exact middle-date retained outbox restores one input.
Prior rows remain byte-identical and bridge reads reuse only freshly verified
generations. HTTP/DB/Storage persistence is mocked, and market receipt fixtures
are not a re-execution of the market economic engines. This is not live write
acceptance or a promise that missing historical evidence can always be repaired.
