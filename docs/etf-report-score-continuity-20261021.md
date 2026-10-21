# ETF M0 report score continuity (PR after #328)

## Observed 2026-10-21 failure

- `analysis_runs.id=screening-20261021113626-a4c24bc5`, `code_version=a70432226a85...` started at 20:36:26 KST, before PR #328 production was READY (20:37 KST).
- Its 1,183 ETF rows are classified as `krx_batch_pending`. In the immutable execution archive, `totalScore=0` is a **generic missing display normalization**, while `evidence.etfStrategy.score=null` is the actual official M0 state.
- October 20's latest Final, `20261020235735-2a5005a2`, contained 736/1,183 numerically scored ETF rows. For 218420 its dated October 20 official M0 is 61.03586459; October 21 current official M0 is null and the raw previousScore refers to 61.03586459.
- PR #328 computed separate read-only preliminary evidence for future screenings, but the `buildSnapshot` path serialized only `evidence.etfStrategy`, **dropping the preliminary estimate from both CLI and browser immutable archives**. As a result LLM/Supabase report readers could still miss the new signal, even after future compatible screenings.

## Prospective fix

- Add `evidence.etfReportScore` to future **execution archives only** (`runId` path). It contains explicit `confirmedM0`, `preliminaryM0`, exact observation dates and `priorSessionScoreReference` with `priorReferenceVerified:false`.
- Add `summary.etfScoreContinuity` with status counts and at most 25 top **reference** ETFs to new analysis runs. It does not promote a preliminary or old score to official/tradable score. The full dated evidence remains only in the run archive; daily `screening_history` strips evidence by existing policy.
- `NOT_STRATEGY_TARGET` applies to bond/cash ETFs: they do not acquire an artificial M0. Current `FINAL` only if current official `dataStatus='ready'` and valid score. Otherwise a valid preview is `PRELIMINARY`, a prior raw score is `PREVIOUS_REFERENCE`, and absent all three is `UNAVAILABLE`.
- Reporting consumers: **never use `SnapshotEntry.totalScore` as ETF final M0 when `evidence.etfStrategy.score` is null**. Use `evidence.etfReportScore.confirmedM0` for final, `preliminaryM0` as a dated estimate, and independently compare `priorSessionScoreReference` to the prior Final archive before claiming confirmed historical M0. A 0 score is valid only when the correct validated official field is explicitly numeric zero.
- Completed historical archives, completed Shadow sessions, actual executions and their prices remain unchanged. **Do not retrospectively change 2026-10-21's 20:36 archived record**. Date-specific reporting can still compare its raw priorScore with the dated 2026-10-20 latest Final.

## Read-only SQL for new execution archive

```sql
SELECT
  a.date, e->>'symbol' AS symbol,
  e->'evidence'->'etfReportScore'->>'scoreStatus' AS score_status,
  e->'evidence'->'etfReportScore'->>'confirmedM0' AS confirmed_m0,
  e->'evidence'->'etfReportScore'->>'preliminaryM0' AS preliminary_m0,
  e->'evidence'->'etfReportScore'->>'priorSessionScoreReference' AS prior_reference_m0,
  e->'evidence'->'etfReportScore'->>'priorSessionDate' AS prior_date
FROM public.screening_run_archive a
CROSS JOIN LATERAL jsonb_array_elements(a.snapshot->'entries') AS e
WHERE a.run_id = '<verified runId>' AND e->>'market' = 'ETF';
```

This SQL applies to uncompressed JSONB run archives only. For compressed runs, hydrate with the existing `hydrateScreeningRunArchive` verifier instead; never manually parse `payload` as original JSON.

## Verification

A prospective change to the presentation/read-only reporting format. Unit checks, dashboard/test run, KOSPI/ETF/US/Shadow regression and Vercel build must pass. Current-run source hashes and code revisions must always be checked before interpreting an older run as a regression of newly deployed code.
