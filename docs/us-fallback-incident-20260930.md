# US daily fallback incident — 2026-09-30

## Evidence
- Default branch: main. Workflow 368883545: active; repository is active (no 60-day inactivity).
- Actual cron change commit: `2f8a5e16270a98ea49ebcd48fb2adeed54f7cf7c`, committed 2026-09-29 23:33:16 UTC (08:33:16 KST). The SHA provided in the incident request had a different suffix and was not found.
- main contains `40 2 * * *` (11:40 KST), nearly three hours before its first due time.
- Last schedule: run 36642760906, created 22:59:50 UTC, screen completed 23:01:04 UTC.
- Push run 36645832695: validation success, screen skipped as intended.
- Collector/manual dispatch run 36646975358: screen success, completed 23:48:09 UTC (08:48:09 KST).
- At investigation, no September 30 schedule run exists. No running/pending prior US run overlaps 02:40 UTC. Concurrency cannot explain an absent run record on available evidence.
- Previous hourly schedule runs were created at 05:49, 13:00, 18:40, 22:59 UTC on September 29: delivery was already sparse.

## Conclusion and limits
Most likely schedule delivery delay/drop or cron re-registration behavior, not timezone, default branch, inactivity, or a running job. GitHub does not expose internal scheduler registration/delivery state, so a specific cause cannot be proven. No documented cron propagation SLA supports attributing this definitively to propagation.
GitHub documents schedule delays and dropped jobs under load: https://docs.github.com/en/actions/how-tos/troubleshoot-workflows

## Change
- Keep primary 11:40 KST. Add only two bounded daily recovery checks, 12:10 and 12:40; no hourly polling.
- After a scheduled screen succeeds, upload a 7-day artifact named for its KST run-creation date. Subsequent checks skip before dependency installation. Only scheduled success counts; collector workflow_dispatch does not suppress fallback.
- API errors fail visibly. Failed screening leaves no success artifact; recovery retries. The engine retains its existing immutable-date/idempotent portfolio behavior.
- Separate workflow concurrency for CI, schedule and dispatch. Serialize all screen jobs under us-prospective-production. Set screen timeout to 25 minutes. GitHub concurrency is not a FIFO queue; multiple pending dispatches can still coalesce.
- Move tests/build to push/PR validation; runtime schedule/dispatch only installs and executes the frozen engine. Add gate files to validation path filters.
- Workflow summaries explain run/skip decisions; artifact is completion evidence, not market-data availability evidence. No ingest remains the existing successful no-op.

## Validation
- Gate tests: 5 pass (KST boundary, missing marker, completed marker, expired/wrong marker, API failure).
- US engine: 13 pass. Collector: 7 pass. Production build: pass (existing deprecation/chunk warnings).
- YAML parses and git diff --check passes. Real scheduled recovery and artifact permissions need observation after merge; local mocks do not establish live trigger delivery.

## Reliability boundary
This provides one successful fallback per KST day in normal operation, with two recovery opportunities. Exact 11:40 start and delivery are not guaranteed by GitHub cron; all three triggers could be dropped. A marker upload failure after a successful engine can cause another idempotent engine invocation. Strict exactly-once execution and hard punctuality require an independent scheduler plus transactional execution claims, outside this PR.
