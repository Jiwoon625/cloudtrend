# KOSPI pre-open evidence watchdog

This read-only watchdog alerts before the existing Shadow admission window closes.
It does not collect prices, publish sessions, approve recovery, or certify source bytes.
A green result means only that an exact-date, owner-scoped completed screening manifest
matches the complete ordered source registry under the existing historical pre-open
checks. The normal publisher still owns byte verification, predecessor continuity,
runtime admission, and immutable publication.

The proposed workflow runs at 08:35 and 08:50 Asia/Seoul on weekdays. Holidays use
the reviewed KR exchange calendar. Uncovered calendars and unconfirmed special-session
hours fail closed. GitHub schedules are best effort; an execution after the open fails
explicitly instead of manufacturing an earlier observation clock. Configure repository
Actions failure notifications if desired; the workflow itself sends no external message.

A failure requires checking the source collector and finishing the full morning refresh
and screening before the actual next-session open. Evening-only data, absent exact-date
screening, changed membership, source hash mismatches, future timestamps, and after-open
registrations are not substituted. This watchdog detects recurrence; it cannot repair an
upstream collector that has not delivered data. Upstream collector scheduling is outside
this repository's screening workflow, which currently has no timed collection trigger.

## 2026-11-03 incident

Read-only production inspection on 2026-11-04 found:

- The first registered source with max date 2026-11-03 activated at 2026-11-04
  01:17:31.829861 UTC (10:17:31 KST). A second activated at 01:59:27.761967 UTC.
- The two completed SCREENING runs for that date were created at 01:23:08.171 UTC
  and 02:05:00.333 UTC, both after the 00:00 UTC / 09:00 KST decision cutoff.
- The revised immutable journal contains 2026-11-02, but no 2026-11-03 session.
- Therefore an ordinary prospective append cannot truthfully be produced from those
  sources. Retrying the failed late adapter cannot make this missing evidence exist.

Leave the authoritative ledger at its last verified session. Do not synthesize a pre-open
clock, carry forward a fake zero-trade session, or reuse Oct30/Nov2 retrospective approvals.
If the owner wants a retrospective Nov3 continuation, prepare a separately reviewed,
explicitly retrospective append with exact source/plan hashes and provenance, preserving
all completed sessions and actual trades. Publication requires separate approval; this
change contains no such approval or recovery data.

## Local verification

```
npx vitest run --config vitest.shadow.config.ts
node tests/shadow-runner-smoke.mjs
npx eslint scripts/check-kospi-preopen.ts tests/shadow-preopen-watchdog.test.ts
```

The new script and workflow are isolated from frozen engine and publication runtime roots.
No economic rules or existing runtime admission lists are changed.
