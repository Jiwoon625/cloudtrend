# 스크리닝·대시보드 캐시 gzip 저장 (2026-11-14)

Supabase Storage의 cached egress가 8일간 13.05 GB(Free 플랜 월 5 GB)까지 오른 원인은,
대시보드가 쓰는 두 개의 mutable 포인터가 압축 없이 26 MB/3 MB로 저장돼 있었기 때문이다.
두 객체만 gzip으로 저장하고, 읽기는 압축 객체를 먼저 보고 압축 이전 객체를 대체본으로
읽도록 바꿨다. **저장된 JSON 스키마와 `SCREENING_CACHE_VERSION`은 그대로**이고 저장 인코딩만
바뀐다.

## 실측 (2026-11-14 운영 객체, `scripts/migrate-screening-cache-gzip.ts` dry-run)

| 객체 | 현재 | gzip | 절감 |
| --- | --- | --- | --- |
| `cache/screening/latest.json` | 25,986,755 B (24.8 MB) | 1,612,873 B (1.54 MB) | 93.8% |
| `cache/dashboard/latest.json` | 3,111,449 B (2.97 MB) | 665,887 B (0.64 MB) | 78.6% |

대시보드 1회 로드 기준 29.1 MB → 2.28 MB. 같은 호출 패턴(8일 ≈ 500회, 13.05 GB)이면
약 0.81 GB/8일 ≈ 3.0 GB/30일. 종목 패널을 오갈 때의 짧은 재사용(`readSharedScreeningCache`,
45초)까지 겹치면 그보다 더 줄어든다.

## 저장소 계약

- 경로: `{uid}/cache/screening/latest.json.gz`, `{uid}/cache/dashboard/latest.json.gz`
  (`src/lib/cacheObjectEncoding.ts`의 `COMPRESSED_CACHE_OBJECT_TAILS`).
- content type은 `application/octet-stream`이다. 버킷 MIME 허용 목록에 `application/gzip`이
  없고, 종목·차트 캐시가 이미 같은 방식으로 저장된다. `cacheControl: "0"`으로 CDN 캐시를
  막고, 모든 읽기는 `cacheNonce + cache: no-store`로 CDN을 우회한다(게시 직후 신선도 보장은
  이전과 동일하다).
- 쓰기: `writeFreshCacheObject()`가 gzip 본문만 올린다. 압축 이전 객체는 지우지 않는다 —
  아직 배포되지 않은 탭·러너의 대체본이고, 삭제는 아래 이행 스크립트의 명시적 단계다.
- 읽기: `readFreshCacheObject()`가 `.json.gz` → (없거나 손상 시) `latest.json` 순서로 읽고,
  본문이 이름과 달리 gzip이면 magic byte(`1f 8b`)로 판별해 푼다. 두 곳 모두 없으면 `null`,
  읽기 자체가 실패하면 오류를 그대로 올린다.
- 적용 지점: `src/lib/cloud.ts`(브라우저), `src/lib/webScreening.functions.ts`(서버 함수),
  `src/lib/screeningPublication.server.ts`, `src/lib/dashboardOperations.server.ts`,
  `src/lib/instrumentCharts.functions.ts`, `scripts/analysis-run-store.ts`(러너·스크립트),
  `scripts/repair-chart-cache.ts`.
- v7 러너의 네트워크 경계(`scripts/drive-history-network.ts`)에 `.json.gz` 두 경로를 쓰기
  허용 목록으로 추가했다(DELETE는 종전대로 차단).

## 배포·이행 순서

1. **DB 정책 먼저**: `supabase/migrations/20261114132000_allow_owner_compressed_screening_dashboard_cache.sql`
   (authenticated insert/update 두 경로). 브라우저·서버 함수의 쓰기는 이 정책이 있어야 한다.
   러너는 service role이라 정책 없이도 쓴다.
2. 코드 배포(Vercel + Actions). 배포 직후 첫 읽기는 아직 압축 객체가 없으므로 기존
   `latest.json`으로 동작한다(26 MB, 이전과 동일).
3. 압축 객체 생성 — 둘 중 하나:
   - 다음 정기 스크리닝 게시(평일 08:15·20:10)가 `.json.gz`를 쓰고, 그 시점부터 읽기가 gz로 바뀐다.
   - 또는 즉시: `scripts/migrate-screening-cache-gzip.ts --apply`
     (dry-run 기본, `--apply`가 gz 저장, `--apply --prune-legacy`가 gz 재검증 후 legacy 삭제).
4. legacy 삭제는 열린 탭·구 러너의 대체본을 없애므로, 배포 후 하루 이상 지나서
   `--apply --prune-legacy`로 정리한다(삭제 전 gz 재읽기·내용 일치 검증 포함).

## 남은 후보 (이번 범위 밖)

- `cache/screening/confirmed-etf-context.json` 2.71 MB: 대시보드 운영 요청마다 읽힌다.
  같은 방식으로 gzip하면 약 0.3 MB 수준으로 줄어든다.
- `cache/us-screening/latest.json` 6.04 MB: 미국 대시보드가 읽는 포인터.
- `results/screening/{runId}.json` 12.86 MB × 주기: 저장 448 MB의 대부분이지만 대시보드가
  읽지 않는 불변 결과 번들이다(수리·검증 스크립트만 읽음). 전송량 기여는 거의 0이고
  스토리지 사용량 문제다.
- `source/screening/*.csv` 314 MB: 서버가 데이터 상태 확인 때 읽는다(`loadActiveSources`).
  전송량의 또 다른 축이지만 원천 재현성과 직결돼 별도 판단이 필요하다.
