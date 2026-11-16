# 데이터 상태(한국) · Drive v7 게시본 연동

`/data-status`의 한국 카드와 `KrMarketDataPanel`이 보여 주는 기준일은 **홈페이지 스크리닝
게시본**과 같아야 한다. 이 문서는 그 값을 어디서 읽고, 값이 없을 때 무엇을 하지 않는지를
정한다.

## 왜 바뀌었나

한국장 스크리닝은 Drive v7(`.github/workflows/drive-history-screening-v7.yml`)으로 운영된다.
원천 CSV는 구글 드라이브에 있고, Supabase에는 결과 캐시만 게시된다.

그 이전 경로(`dataStatusServer`)는 Supabase `analysis_source_files`의 활성 스크리닝 CSV를
전부(2026-11 기준 52개, 약 315 MB) 매번 내려받아 파싱해 품질 요약을 만들었다. 그 원천은
Drive 전환 뒤 `max_date 2026-11-05`에 멈춰 있었으므로, 대시보드가 `2026-11-13 FINAL`을
게시해도 데이터 상태 화면만 11-05를 계속 보여 주었다(요청마다 수백 MB 전송도 함께 발생).

## 지금의 흐름

1. **계산 단계**(`scripts/run-screening.ts`)는 이미 메모리에 있는 데이터셋으로
   `computeDatasetDataStatus`를 한 번 실행하고, 그 결과를 `screening-bundle.json`의
   `dataStatus`로 남긴다. 추가 파싱은 없다.
2. **게시 단계**(`scripts/publish-drive-result.ts`)는 `dataStatus`를 게시 세대
   (`publicationId`, `resultDigest`, `asOfDate`, `phase`)에 묶어 두 객체로 저장한다.
   - `cache/data-status/<publicationId>.json` — 불변 요약(종목별 봉 수·자동 검증·수집 현황 포함)
   - `cache/data-status/latest.json` — 현재 세대를 가리키는 포인터
     요약을 먼저 쓰고 포인터를 나중에 쓴다. 중간에 실패하면 화면은 이전 세대를 보여 줄 뿐,
     다른 세대의 값을 섞어 보여 주지 않는다.
3. **조회**(`dataStatusServer`)는 포인터(수백 바이트)를 읽어 현재 세대의 요약(수십~수백 KB)만
   읽는다. 활성 원천 CSV는 읽지 않는다.

## 값이 없을 때

| 상황                                                          | 화면                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 포인터·요약이 현재 게시 세대와 일치                           | 게시 시점 데이터셋 요약(봉 수·자동 검증 포함)                                                                                                     |
| 게시본은 있는데 게시 시점 요약이 아직 없음(이 연동 이전 세대) | 게시된 분석에서 확인 가능한 값만: 기준일·버전·기능·기준일 종목/시총 수. 봉 수·자동 검증은 `evidence.unavailable`로 밝히고 **0으로 채우지 않는다** |
| 게시본이 활성 CSV 원천보다 오래됨(또는 게시본 없음)           | 기존 CSV 계산 경로(변경 없음)                                                                                                                     |
| 활성 CSV도 게시본도 없음                                      | 조회 실패 안내                                                                                                                                    |

축약본은 `deriveDataStatusFromPublishedAnalysis`가 만들며, `notes`에 "다음 게시 실행부터
표시됩니다"를 덧붙인다. 게시 실행기가 요약을 남기면 자동으로 사라진다.

## 계약과 테스트

- `src/lib/dataStatusPublication.ts` — 요약/포인터 스키마, 세대 검증, 축약본, 최신성 판정
- `src/lib/krDataStatus.server.ts` — 포인터 → 요약 → 축약본 → 없음 순서의 조회
- `tests/kr-data-status-publication.test.ts` — 세대 불일치·손상 요약 거부, 축약본 산출, 최신성 판정
- `tests/drive-publication-publisher.test.ts` — 게시가 요약과 포인터를 같은 세대로 남기는지
- `tests/screening-memory-cli.test.ts` — 번들 계약(`dataStatus` 포함)과 기준일 일치
- `tests/market-data-ui.test.tsx` — 확인되지 않은 항목을 0건으로 그리지 않는지
