# Lossless US execution-archive publication

The October 19 US calculation and Shadow recording completed, but execution-archive insertion exceeded PostgreSQL's existing eight-second statement limit. Browser publication is intentionally gated on that archive.

Large US execution snapshots now use a gzip/base64 envelope in the existing JSONB column. Required run/date/market/version/time headers stay readable for the unchanged database constraints. The complete original JSON is retained, bounded during decompression, SHA-256 checked, and compared after write. Existing raw archives remain readable and are not rewritten. The daily-history format, shared KR/model writer, schema, permissions, timeouts, and frozen runtime manifests are unchanged.

The synthetic 5,347-symbol full-evidence fixture shrinks from 8,339,940 to 1,413,050 JSONB bytes. This verifies reduced database work and exact restoration, not production latency by itself.

## Deployment and bounded recovery

1. Merge and deploy the new archive reader; verify the exact production commit before any compressed archive is written.
2. Check no US publication workflow is active or pending. The recovery uses the existing `us-prospective` concurrency group.
3. Only after approval/deployment, add `.github/requests/us-publication-recovery-20261019.json` with the exact approved request. It triggers the one-date recovery workflow. No request is included with the implementation commit.
4. The CLI admits only the specifically approved October 19 source hash, rule version, and 5,347 rows. It requires an already-completed latest history marker and an unchanged immutable result/latest cache. It does not run engines or write actual/model/Shadow ledgers.
5. Recovery writes only the execution archive and browser view/summary. It reads back both browser artifacts, compares complete content against the saved result, and confirms protected result/history/latest are unchanged. Independently compare model/Shadow digests before and after.

Never relabel old snapshots, weaken timeout/security settings, bypass archive verification, or repeatedly rerun failed screening to work around a publication error. If the bounded recovery fails, diagnose that exact failure before another authorized attempt.
