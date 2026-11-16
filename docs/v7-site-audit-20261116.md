# v7 site audit — 2026-11-16

Base: `315c9eeac80ea719c417152cd44e177473ad8ccd`. Production was READY on that commit when inspected.

## Scope and findings

Reviewed navigation/root authentication, dashboard, KR/ETF screeners and instrument caches, US published views, history queries, data management, publication generation checks, v7 execution documentation, build gates, and Supabase health/security/performance advisories. Browser verification reached the login page only; authenticated end-to-end timings were not measured.

| Area                                   | Evidence                                                                                                                               | Action                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent instrument/result reads     | Shared cache reused only completed reads; simultaneous panels each downloaded and validated the same full result                       | Coalesce in-flight requests by owner path and scoring settings, clean failures, invalidate pending reuse after writes                                                       |
| Validation waterfall                   | Source fingerprint request finished before Drive head download started                                                                 | Run independent checks concurrently; require both before accepting the cache                                                                                                |
| Mutable US views and instrument detail | `view-v1.json.gz`, `summary-v1.json`, and instrument files used ordinary CDN downloads despite being overwritten                       | Fresh nonce/no-store reads and cacheControl 0 on client writes; retain caching for content-addressed chart bundles                                                          |
| v7 data-management flow                | Button labeled “start screening” only navigated and depended on a browser-local source file                                            | Show Drive v7 collection/publication instructions and an always-available saved-results navigation action; retain manual input separately                                   |
| Large Drive head                       | Storage metadata: 3,349,032 bytes uncompressed, vs dashboard 721,620 bytes and screening 1,672,324 bytes compressed                    | Follow-up: compact/hash-address publication proof with a versioned reader/writer migration. Do not add an independently stale gzip sidecar to a publication generation gate |
| US result size                         | Canonical 6,327,501 bytes, compressed browser view 764,842 bytes, summary 35,902 bytes                                                 | Existing compact views are present and preferred; fix their freshness rather than replacing their schemas                                                                   |
| History                                | Metadata-only list, four parallel bounded queries (90 each), full record loaded on demand                                              | Preserve existing behavior                                                                                                                                                  |
| Database                               | Health advisor clear; per-row auth.jwt evaluation on two archive policies; three missing FK covering indexes; unused-index suggestions | No database bottleneck attribution without query timings. Do not delete indexes or weaken RLS based only on advisors                                                        |
| Security                               | Definer-function and archived-table notices, leaked-password protection disabled                                                       | Separate follow-up: review intentional permission matrix; no auth/privilege changes in a performance patch                                                                  |

## Preservation and limits

- Strategy/engine identities, input fingerprints, result digests, Drive generation equality, FINAL protection, user ownership, historical data, and ledger write behavior remain unchanged.
- Collection v7, technical strategy V8, and cache schema v9 are separate version namespaces. Do not rename all of them to v7.
- No production data was rewritten and no full screening was triggered by this audit.
- The 45-second completed-read reuse window is unchanged. Explicit later reads still fetch and verify the origin. A settings change cannot reuse the previous settings' result.
- Keep the frozen `freshStorage.ts` calculation dependency unchanged; browser view classification lives in a separate module. Full prebuild validates the existing frozen runtime identities.
- Full browser testing after login and before/after production latency measurements remain necessary to quantify end-user speed. Request coalescing is verified with three concurrent consumers producing one screening download.

## Verification

- Storage tests: 12 passing, including current US/detail reads and preserved immutable chart caching.
- Cache/gzip/dashboard focused suite: 50 passing; final dashboard/coalescing checks: 41 passing.
- UI suite: 147 passing; updated data-management checks: 19 passing.
- Screening memory/publication suite: 434 tests. An initial unconstrained concurrent run timed out in two suites; both affected suites passed on rerun with two workers (34/34). Added an invalidation-in-flight regression test, which also passed.
- Full production build passed, including unchanged frozen-runtime manifests, trade safety checks and client bundle budget: 294.6 KiB gzip versus 320 KiB limit. Changed-file ESLint and git diff checks passed. The user explicitly approved public GitHub publication and production rollout on 2026-11-16 after reviewing the changes. Deployment checks are tracked in the pull request.

## Follow-up order

1. Version the Drive head/proof into a small atomic pointer and immutable content-addressed evidence. Update Python transfer, Node publisher, server and browser readers together; test interrupted publication/recovery and FINAL protection before migration.
2. Measure server/database region alignment as well as authenticated route waterfall and main-thread parsing on a representative device; compare cold dashboard, repeat screener navigation, and ETF full-history charts.
3. Review archive RLS initplan and FK indexes against actual query plans. Keep private ledger policies and grants unchanged unless separately justified.
4. Plan major dependency upgrades (Recharts/ESLint and transitive ExcelJS dependencies) in isolated changes; do not mix them with the v7 publication fixes.


## 사용자용 요약

- 동일 결과를 동시에 조회하는 요청을 하나로 묶고, 입력 검증과 게시 세대 확인의 순차 대기를 줄였습니다.
- 미국 요약·상세 및 국내 종목 상세의 변경 가능한 파일은 최신 내용을 읽도록 수정했습니다. 해시로 구분되는 차트 파일의 캐시는 유지했습니다.
- 데이터 관리 화면은 Drive v7 수집·게시 흐름을 안내하고, 로컬 원자료 없이도 저장 결과 화면으로 이동할 수 있게 변경했습니다.
- 전체 빌드 성공, 초기 화면 JS/CSS gzip 294.6 KiB로 기존 320 KiB 제한 통과. 전략과 원장 런타임 해시는 유지했습니다.
- 실제 사용자 로그인 이후의 속도 측정은 수행하지 않았습니다. 사이트 전체 기능의 실사용 검증 완료나 특정 비율의 속도 향상을 주장하지 않습니다.
- 큰 Drive 게시 확인 파일(약 3.35 MB), 미국 서버와 인도 DB 사이 통신, DB 세부 성능 권고는 후속 과제로 남겼습니다.
- 사용자가 2026-11-16 공개 GitHub 업로드와 운영 반영을 명시적으로 승인했습니다. 배포 상태는 PR에서 확인합니다.
