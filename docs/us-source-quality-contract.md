# US collection quality: price quarantine is not a scoring hold

## Failure and bounded fix

A collector can finish current-price QA while intentionally withholding scores
for securities with insufficient verified post-event history. Previously, upload
marked the overall source incomplete, but the immutable archive and replay
accepted only a price/lifecycle quarantine as an explanation. A hold-only source
therefore failed before upload even though the remaining securities were usable.

This change is an additive transport/validation contract, not an engine-rule
change. It adds `sourceQuality` to new ingest metadata and dated source manifests:

```json
{
  "version": "us-source-quality-v1",
  "priceCoverageComplete": true,
  "scoringHolds": {
    "EXAMPLE": {
      "reason": "unverified_pre_event_history_and_insufficient_post_event_lookback",
      "postEventBars": 15,
      "minimumBars": 253,
      "historyStartDate": "2026-10-05"
    }
  }
}
```

The legacy `sourceCoverageComplete` stays **false** with any explicit score hold
or price quarantine. `quarantinedSymbols` stays empty for a hold-only source;
we do not invent missing prices to pass a gate. `priceCoverageComplete` describes
the absence of explicit in-source price quarantines, with positive current
prices required for tradable rows. It does not claim that every row has enough
history to be scored. `scoringHolds` describes only the guarded-event holds;
ordinary young listings may also lack return history. There is deliberately no
all-symbol `scoringEligibilityComplete=true` claim.

## Admission and propagation

- Known hold reason only, canonical non-SPY symbol present in the CSV, integer
  positive post-event bars below the unchanged 253-bar minimum, valid nonfuture
  history-start date, and no overlap with price quarantine.
- Held rows must retain finite positive OHLC with valid bounds and nonnegative
  volume. All seven score-input features remain null and `active20=false`.
- Ordinary ingest, dated replay, daily publication and recovery readback preserve
  the exact hold evidence. Compact publications independently require null ranks
  and false eligibility/onset/A0/A2/B3 entries. No zero-filled score is introduced
  in the US engine or canonical compact output.
- Unknown contract versions/states, false-complete claims, unsafe features,
  malformed price data and contradictory flat-vs-nested metadata fail closed.
- Omitted candidate **identity** quarantines need a separately reviewed roster
  contract; this patch does not accept arbitrary missing securities. The new
  failure is explicit rather than silently treating omission as price quarantine.
- Exact archive retry validates owner, hashes, roster, row counts, session,
  quarantine and quality evidence; it reuses the first capture timestamp and
  exact saved quality. It does not rewrite `source.json` or retrofit new fields
  into old frozen artifacts. A reviewed lifecycle derivative updates only its own
  quality object, preserving unrelated holds and the immutable original.

The replay receipt's existing aggregate coverage field remains unchanged; the
hash-bound per-session manifest is the authoritative detailed quality evidence.

## Resilience without weakening hard boundaries

Expected, fully evidenced history holds no longer fail the entire archive/upload.
The collector log now says archive/upload validation is still pending, rather
than promising that upload continued before it actually happened. Collection QA,
upload readback, accepted dispatch and completed engine publication remain
separate outcomes. Existing bounded GET retries and optional-diagnostic handling
remain; auth, hashes, identity, session timing, missing mandatory evidence,
immutable conflicts, malformed responses, aggregate provider-gap cap and
uncertain dispatch outcomes remain hard stops. No blanket exception suppression
or automatic repeated POST is added.

The generic cross-market `screening_run_archive` display carrier still has its
pre-existing numeric `totalScore` fallback. Its US original evidence and
`technicalPoints` retain null ranks and entry flags remain false. Changing that
shared display schema is separate from this bounded transport fix; do not claim
that this patch migrates all historical score displays.

## Release and recovery boundaries

Land and validate the server adapters before installing the paired private
notebook runtime. Public push/PR checks run offline validation only;
`screen` remains restricted to `workflow_dispatch`. Recovery additionally supplies
`expected_server_code_sha`; the screen job compares it with the actual
`GITHUB_SHA` before checkout/operational code, closing the main-ref check/dispatch
race. Ordinary dispatches can omit the optional pin. New tests are in the normal
US replay CI target, not merely an ad hoc test command.

A runtime hash is part of the private collector's frozen run identity. Do not
force an old failed run to resume under new code or recommend a full new
collection as a shortcut. A pre-upload failed run's completed CSV/checkpoints
are preserved. Any upload-only recovery must independently admit the exact
saved plan, calendar, seed/master, diagnostics, stage journals, CSV hash and
original capture evidence, use a separate recovery directory, reconcile current
remote state before writes, and obtain separate operational authorization.
This patch itself triggers no collection, upload, dispatch or recovery.

## Offline verification

`tests/fixtures/us-scoring-holds-golden.json` contains redacted real collector
metadata (5,328 input rows; 5,009 with ret252), not a raw data export. The Python
fixture uses three synthetic price rows (plus a fourth for mixed quarantine).
Tests run the actual Python archive, transfer its source/roster/CSV directly to
TypeScript replay admission, run the unchanged scorer, and validate compact
publication. Adversarial tests cover versions, reasons, bar thresholds, dates,
symbols, price corruption, score availability, false completeness, mixed holds,
immutable retries and publication readback. Existing replay/continuation and
same-session revision suites remain required.

### Lifecycle producer compatibility

Coverage refers to the archived CSV roster, not a claim that every original seed
security has current prices. The ordinary upload producer includes lifecycle
quarantines **present in the CSV** when computing `sourceCoverageComplete`.
A previously verified lifecycle event may intentionally leave no current-session
row; its full `lifecycleExcludedSymbols` and `verifiedLifecycleEvents` metadata
remain intact, but it does not invent a CSV quarantine or a price. Such absent
entries require a unique canonical non-SPY symbol and one effective SUSPENDED
event with valid date and HTTPS evidence. Missing provider-gap rows and unknown
candidate identity omissions still fail closed. Actual upload-stage fixtures
exercise present, absent, and mixed lifecycle/hold cases through archive, replay,
and direct ingest, stopping before any HTTP call.
