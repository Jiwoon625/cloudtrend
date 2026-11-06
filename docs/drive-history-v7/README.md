# Drive 과거 원천 기반 수집기 v7 — 검증용 별도 구현

상태: **한국·ETF의 Drive baseline 로더, Colab 수집 코드, 수동 Actions 계산 경로 구현. 운영 전환 미완료.**

홈페이지 게시, 부모 delta를 이어받는 장기 운영, 분산 잠금과 baseline/latest 승격은 아직 열지 않았다. 기존 v6.1·실행기·Supabase 원천·확정 이력·요금제·스케줄은 변경하지 않는다.

## 사용 방법

1. `collectors/drive_history_v7/CloudTrend_Drive_History_Collector_v7.ipynb`를 Colab에서 연다. 기본 `DO_COLLECT=False`로 전체 실행하면 비공개 mounted Drive의 manifest와 독립 ZIP 5개를 검증한다.
2. 실제 수집 시 Colab Secrets에 기존 `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`, 승인된 `KRX_OPENAPI_KEY`를 둔다. 출력되는 Colab IP가 Toss 허용 IP인지 확인한다. `DATA_DATE`에 실제 완료 거래일을 입력하고 `DO_COLLECT=True`로 실행한다. 이 preview에서는 baseline 마지막 날짜(2026-11-05)보다 뒤의 거래일만 허용한다.
3. 중단 시 출력된 `runId`를 `RUN_ID`에 넣고 같은 설정으로 재실행한다. 종목별 CSV·SHA256·수집 계획은 `CloudTrend/한국시장/01_원천데이터/drive_history_v7/runs/<runId>/`에 자동 저장된다. 실행 중복은 같은 run의 배타적 잠금으로 거부한다. 프로세스가 비정상 종료된 잠금은 작성자가 종료됐는지 확인 후 정리해야 한다.
4. 정상 완료 시 마지막 셀이 Drive API로 delta ZIP을 업로드하고 다시 내려받아 hash를 검증한 다음 complete manifest를 업로드·재검증한다. `actions-inputs.json`의 세 값(run manifest ID/hash, 결과 폴더 ID)을 사용한다.
5. PR을 main에 병합한 뒤 GitHub → Actions → **CloudTrend Drive history v7 (validation preview)** → Run workflow. `publish_dashboard=false`를 유지한다. run manifest 입력을 비우면 고정 baseline만 계산한다. 결과 폴더는 반드시 지정한다.
6. Actions는 동일 공식 `runScreening`을 providedInputs/계산 모드로 호출한다. 완료 bundle·summary·입력 검증 영수증·네트워크 영수증을 Drive ZIP으로 저장하고 재다운로드 hash를 확인한다. Supabase 변경 요청은 실행 중 차단한다.

### Actions 최소 설정

기존 서버 설정 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_USER_ID`와 `GOOGLE_DRIVE_CREDENTIALS_JSON`을 GitHub Secrets에 둔다. 후자는 `authorized_user`의 `client_id`, `client_secret`, `refresh_token`이 있는 갱신 가능한 JSON이어야 한다. 일회성 `GOOGLE_DRIVE_ACCESS_TOKEN`은 사용하지 않는다. 인증 계정은 baseline과 결과 폴더를 읽고 쓸 권한이 있어야 한다. 공유 범위를 공개로 바꾸지 않는다.

이 작업 환경에는 Actions의 서버 secret/Google refresh credential을 사용할 수 없었으며, 연결된 Drive 도구의 권한이 Actions runner 권한을 증명하지는 않는다. Secrets가 현재 설정되어 있는지는 단정하지 않았다. 최초 수동 실행에서 실제 비공개 baseline 읽기를 확인해야 한다. 새 workflow는 main 병합 전 UI에서 수동 실행할 수 없다.

## 구현과 보존 규칙

- `history.py`: 고정 manifest SHA256, 패키지 bytes/hash, 독립 ZIP inventory/CRC/중복/경로/해제량 검사. 파일 이름 순서로 재정렬하지 않고 ordinal과 등록 순서를 검증한다. 실패 시 Supabase fallback이 없다.
- `drive-history-inputs.ts`: 실제 CSV를 현재 `validateSourceBytes`로 재검증하고 등록 file/data/schema hash와 비교한다. 불일치는 원래 값과 새 값을 영수증에 따로 남기고 중단한다. 등록값을 수정하지 않는다.
- `collector.py`: 개별 종목의 실제 관측일과 두 시장 지수 API의 거래일을 비교해 전체 누락 구간과 겹침 재확인 구간을 계획한다. 기존 configured universe만 유지하고 신규 종목 자동 편입을 거부한다. 종목별 미확인 가격은 제외 목록에 기록한다. 휴장일을 평일 규칙으로 합성하지 않는다.
- 과거 52개와 새 CSV는 **분리된 순서 있는 입력 층**이다. Colab에서 과거를 concat/drop_duplicates로 병합하지 않는다. Actions에서 현행 `parseManualMarketDataWithReferences`와 frozen parser가 필드별 보강·0·공백·KRX reference 우선순위·ETF 매핑을 그대로 처리한다.
- 전체 baseline을 유지하므로 MA60 기준으로 역사를 자르지 않는다. 현재 엔진의 MA120/120일 적격성, 수급 20일 변화, 시장 및 ETF 지표도 같은 원천을 쓴다. 요청한 겹침 구간의 수정주가 변화는 공급자·날짜·변경 필드·checkpoint hash를 기록하고 완료를 보류한다. 확정 신호를 다시 쓰지 않는다.
- `provider.py`는 기존 Drive의 KR v3.3.3 bundle(SHA256 `91d4992be9a2d06916ee2e425cb43d210350eed5e73a83429dbb4d041c8b7aba`)의 검토 대상 함수들을 정적 Python 코드로 분리한 것이다. 기존 수집기 파일을 수정하지 않았다. 기존 publisher·pickle·업로드된 코드 실행을 포함하지 않는다. 응답 본문을 오류 로그에 남기지 않는다.
- FINAL/PRELIMINARY는 기존 publication 계약을 검증하며 임의 FINAL 승격을 하지 않는다. KRX 지연은 직전 실제 거래일 공표가 확인되는 경우만 허용한다. 누락 날짜·시장 불일치·입력 충돌은 완료를 차단한다.
- `drive-history-network.ts`는 Supabase source/screening 및 source/us-screening 요청을 보내기 전에 차단한다. DB 설정·이전 snapshot·승인된 operational-index/cache 읽기는 별도 집계한다. 모든 Supabase 변경 요청도 차단한다.
- 기존 `providedInputs + --upload` 보호문은 그대로다. 기존 `source_storage=supabase` 등록 경로를 재사용하거나 원천을 다시 업로드하지 않는다.

## 검증 결과와 한계

2026-11-07 KST 조회. 원천 자료 기준일은 2026-11-05이다.

| 항목 | 결과 |
|---|---|
| Drive 패키지 5개와 원천 52개 | bytes/SHA256/CRC 전부 통과 |
| 원천 총 크기 | 330,053,976 bytes |
| 현재 validator와 등록 file/data/schema hash | 52개 모두 일치 |
| 실제 DB active registry 읽기 | 순서·ID·hash·등록 시각 52개 일치, 쓰기 0 |
| 기존 로더 vs Drive 로더 | 기존 로더에 검증된 사본 transport를 제공한 비교 통과 |
| 결합 dataset fingerprint | `87fc043ce91f952c7c20bccdb157ec68d161f3f4856026c9219ea493723d7ba4` |
| 공식 핵심 엔진 결과 digest | `811c1abe547b53fdef35371c16e8d1a5d43e1fdc9669a3ec43f83e9eb1e136f7` |
| 파서 bars / 결과 종목 | 446,017 / 1,798 |
| 날짜별·시장별·종목별 개수와 필드 hash | 일치 |
| 공표 단계 | 양쪽 FINAL, 계약 일치 |
| 비교 실행 소요 / 최대 RSS | 220.21초 / 2,877,112,320 bytes (약 2.68GiB), 로컬 |
| 실제 GitHub runner 메모리/시간 | 미측정. workflow가 측정하도록 구현 |
| 실제 live Supabase 로더 전체 GET 비교 | 미수행. 사본 transport 비교와 구분 |
| 실제 설치된 운영 ETF 지수 + 사용자 현재 설정 | E2E 미검증. 로컬 비교는 동일 repository default 설정 |
| 새 거래일·중단 재개·중복 run·가격 누락·날짜 누락·공표 지연 | 모의 공급자 통합 테스트 통과. 실제 외부 API 수집 미실행 |
| 토큰 만료·패키지 누락·hash·중복 ZIP·경로 검사 | 자동 테스트 통과 |
| 과거 67개 경로 복구 | 기존 복구 파일 무수정, archive 회귀 테스트 통과. 67개 실제 다운로드 전수 재검증 아님 |
| 홈페이지 게시·중복 게시 방지 | 비활성. Supabase 게시가 0이므로 중복 게시 없음; 운영용 멱등 게시 미구현 |

`equivalence.json`, `live-registry-read.json`에 원자료와 세부 비교를 남겼다. `bars`는 파서가 계산한 bar 수이며 원본 중첩 행 합계 651,612행이나 CSV 결합 고유 행 수와 같은 의미로 사용하지 않는다.

시작 main은 `71ea62badfbae16fc88103b0e6f6fef4b1225bf1`이었다. 작업 중 PR #393이 병합되어 `1638dad2f11719ffb283634dc332d5450f51b945`로 fast-forward했고 기존 회귀/타입 검사를 다시 수행했다. 파서와 점수 엔진 파일은 이 사이에 변경되지 않았다. 52개 비교는 최초 고정 코드에서 수행했다.

## 운영 게시를 열기 전에 남은 구현

1. 웹의 `listActiveSources`/`screeningInputIdentity`는 현재 Supabase active registry를 기준으로 한다. Drive 결과를 cache에 쓰는 것만으로 홈페이지 identity가 맞지 않는다. immutable Drive 입력 head/증거를 서버가 검증하는 전용 adapter와 웹 reader가 함께 필요하다. 이번 변경은 이를 우회하지 않는다.
2. 새 workflow는 기존 Drive 실행기와 `CloudTrend screening-${github.ref}` lock을 공유한다. 하지만 기존 `cloudtrend-analysis`는 workflow명/issue runId 기반 lock이고 다른 게시 경로도 있으므로 전역 writer lock은 아직 아니다. 게시를 열기 전에 DB lease/CAS와 기존 writer 경로의 공동 적용을 검증해야 한다.
3. 현재 Colab lock은 같은 mounted run의 작성자 중복 방지다. 서로 다른 Colab mount의 원자성을 검증하지 않아 shared latest/baseline pointer를 쓰지 않는다. 부모 delta 연쇄·새 baseline 승격은 명시적으로 거부한다. 따라서 매일 운영할 완성판으로 간주하면 안 된다.
4. 실제 새 거래일의 공급자 수집 → private Drive → Actions → 설치된 운영 지수/설정 → 웹 게시 → 신호 이력 영수증까지 E2E 검증 후 전환한다. 과거 확정 이력 재작성과 재무/Shadow 계산은 연결하지 않는다.

## 미국

미국 manifest의 제공 hash `a7db79ffb6a46c827072011dc0c0b14239e2315e4ce703f577640faec30f0368`는 실제 내려받은 값과 일치한다. 28개 입력은 ret120/ret252 등 feature가 든 날짜별 snapshot이고 장기 수정주가 이력이 아니다. 현행 `us_features.py`는 252일 수익률과 60일 SPY beta를 계산하며 `run-us-screening.ts`는 이전 rank/replay 상태 identity를 요구한다.

따라서 미국 수집은 비활성이다. 추가로 검증할 원천은 종목별 최소 253개 실제 가격 관측과 SPY 정렬 이력, 수정주가/기업행위 근거, dated universe/lifecycle 제외, 펀더멘털 시점, 이전 rank/beta 상태이다. 별도 연구 아카이브를 운영 입력에 자동 편입하지 않았다.

## 개발 검증 명령

```bash
python -m unittest discover -s tests -p 'drive_*test.py'
npx vitest run --config scripts/drive-screening.config.ts tests/drive-history-v7.test.ts tests/drive-source.test.ts src/lib/engine/manualDataset.test.ts src/lib/krxReviewReference.test.ts src/lib/krScreeningPublication.test.ts src/lib/sourceRegistryFingerprint.test.ts
npx tsc --noEmit
# 독립 ZIP 5개가 로컬 packages/에 있는 경우
python collectors/drive_history_v7/history.py --output verified --manifest baseline-manifest.json --packages packages
NODE_OPTIONS=--max-old-space-size=5120 npx vite-node --config scripts/drive-screening.config.ts scripts/verify-drive-history.ts verified comparison-output
```

Supabase 프리플랜 전환, egress 월간 추정, 휴면·백업 조건은 이번 코드 검증과 별도다.
