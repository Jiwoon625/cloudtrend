# Drive 과거 원천 기반 수집기 v7 — 수집 이후 실행 경로

상태: **한국·ETF의 Drive baseline + 검증된 수집 delta → 기존 공식 실행기 → Drive 결과 저장 및 선택적 홈페이지 게시 경로 구현. 실제 운영 E2E 미검증.**

수집 코드는 변경하지 않는다. 실행기 1.1의 부모 Drive 이력·웹 출처 검증·FINAL 보호를 재사용한다. 기존 Supabase 원천·확정 신호 이력·요금제·스케줄은 변경하지 않는다. baseline 자동 승격과 무제한 장기 이력 축약은 포함하지 않는다.

## 사용 방법

1. `collectors/drive_history_v7/CloudTrend_Drive_History_Collector_v7.ipynb`를 Colab에서 연다. 기본 `DO_COLLECT=False`로 전체 실행하면 비공개 mounted Drive의 manifest와 독립 ZIP 5개를 검증한다.
2. 실제 수집 시 Colab Secrets에 기존 `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`, 승인된 `KRX_OPENAPI_KEY`를 둔다. 출력되는 Colab IP가 Toss 허용 IP인지 확인한다. `DATA_DATE`에 실제 완료 거래일을 입력하고 `DO_COLLECT=True`로 실행한다. 이 preview에서는 baseline 마지막 날짜(2026-11-05)보다 뒤의 거래일만 허용한다.
3. 중단 시 출력된 `runId`를 `RUN_ID`에 넣고 같은 설정으로 재실행한다. 종목별 CSV·SHA256·수집 계획은 `CloudTrend/한국시장/01_원천데이터/drive_history_v7/runs/<runId>/`에 자동 저장된다. 실행 중복은 같은 run의 배타적 잠금으로 거부한다. 프로세스가 비정상 종료된 잠금은 작성자가 종료됐는지 확인 후 정리해야 한다.
4. 정상 완료 시 마지막 셀이 Drive API로 delta ZIP을 업로드하고 다시 내려받아 hash를 검증한 다음 complete manifest를 업로드·재검증한다. `actions-inputs.json`의 세 값(run manifest ID/hash, 결과 폴더 ID)을 사용한다.
5. PR을 main에 병합한 뒤 GitHub → Actions → **CloudTrend Drive history v7** → Run workflow. 기본 `publish_dashboard=false`로 먼저 계산을 검증한다. 명시적으로 `true`를 선택하면 검증된 결과만 게시한다. run manifest 입력을 비우면 고정 baseline만 계산한다. 결과 폴더는 반드시 지정한다.
6. Actions는 동일 공식 `runScreening`을 providedInputs/계산 모드로 호출한다. 완료 bundle·summary·입력 검증 영수증·네트워크 영수증을 Drive ZIP으로 저장하고 재다운로드 hash를 확인한다. Supabase 원천 읽기·등록·수정은 실행 중 차단한다. 게시를 요청한 경우에만 계산 완료 뒤 해당 owner/run의 정확한 결과·캐시 경로에 POST/PUT을 허용한다.

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
- `drive-history-network.ts`는 Supabase source/screening 및 source/us-screening 요청을 보내기 전에 차단한다. DB 설정·이전 snapshot·승인된 operational-index/cache 읽기는 별도 집계한다. 계산 중 모든 Supabase 변경 요청도 차단하며 게시 직전에만 제한된 결과 경로를 연다.
- 기존 `providedInputs + --upload` 보호문은 그대로다. 기존 `source_storage=supabase` 등록 경로를 재사용하거나 원천을 다시 업로드하지 않는다.

## 검증 결과와 한계

2026-11-07 KST 조회. 원천 자료 기준일은 2026-11-05이다.

| 항목                                                       | 결과                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Drive 패키지 5개와 원천 52개                               | bytes/SHA256/CRC 전부 통과                                                                                     |
| 원천 총 크기                                               | 330,053,976 bytes                                                                                              |
| 현재 validator와 등록 file/data/schema hash                | 52개 모두 일치                                                                                                 |
| 실제 DB active registry 읽기                               | 순서·ID·hash·등록 시각 52개 일치, 쓰기 0                                                                       |
| 기존 로더 vs Drive 로더                                    | 기존 로더에 검증된 사본 transport를 제공한 비교 통과                                                           |
| 결합 dataset fingerprint                                   | `87fc043ce91f952c7c20bccdb157ec68d161f3f4856026c9219ea493723d7ba4`                                             |
| 공식 핵심 엔진 결과 digest                                 | `811c1abe547b53fdef35371c16e8d1a5d43e1fdc9669a3ec43f83e9eb1e136f7`                                             |
| 파서 bars / 결과 종목                                      | 446,017 / 1,798                                                                                                |
| 날짜별·시장별·종목별 개수와 필드 hash                      | 일치                                                                                                           |
| 공표 단계                                                  | 양쪽 FINAL, 계약 일치                                                                                          |
| 비교 실행 소요 / 최대 RSS                                  | 220.21초 / 2,877,112,320 bytes (약 2.68GiB), 로컬                                                              |
| 실제 GitHub runner 메모리/시간                             | 미측정. workflow가 측정하도록 구현                                                                             |
| 실제 live Supabase 로더 전체 GET 비교                      | 미수행. 사본 transport 비교와 구분                                                                             |
| 실제 설치된 운영 ETF 지수 + 사용자 현재 설정               | E2E 미검증. 로컬 비교는 동일 repository default 설정                                                           |
| 새 거래일·중단 재개·중복 run·가격 누락·날짜 누락·공표 지연 | 모의 공급자 통합 테스트 통과. 실제 외부 API 수집 미실행                                                        |
| 토큰 만료·패키지 누락·hash·중복 ZIP·경로 검사              | 자동 테스트 통과                                                                                               |
| 과거 67개 경로 복구                                        | 기존 복구 파일 무수정, archive 회귀 테스트 통과. 67개 실제 다운로드 전수 재검증 아님                           |
| 홈페이지 게시·중복 게시 방지                               | 실행기 1.1 공통 publisher 재사용. 동일 delta 입력 ID 중복 방지, head 재확인, FINAL 후퇴 방지. 실제 게시 미실행 |

`equivalence.json`, `live-registry-read.json`에 원자료와 세부 비교를 남겼다. `bars`는 파서가 계산한 bar 수이며 원본 중첩 행 합계 651,612행이나 CSV 결합 고유 행 수와 같은 의미로 사용하지 않는다.

시작 main은 `71ea62badfbae16fc88103b0e6f6fef4b1225bf1`이었다. 작업 중 PR #393이 병합되어 `1638dad2f11719ffb283634dc332d5450f51b945`로 fast-forward했고 기존 회귀/타입 검사를 다시 수행했다. 파서와 점수 엔진 파일은 이 사이에 변경되지 않았다. 52개 비교는 최초 고정 코드에서 수행했다.

## 수집 이후 연결과 운영 한계

1. 원본 v7 manifest/delta ZIP 및 각 멤버의 SHA256을 먼저 검증한다. 종목별 CSV 약 1,800개를 그대로 게시 증거에 반복 저장하지 않는다. 동일한 헤더의 CSV만 원래 멤버명 순서대로 합치고 행 경계에서 분할한다. 서로 다른 헤더의 의미를 추정하거나 원천 값을 보정하지 않는다. 파생 legacy `kr-outputs.zip`은 결정론적으로 생성하며 원본 manifest 사본 및 ID/SHA 연결을 보존한다. 기존 원본은 수정하지 않는다.
2. 파생 ZIP을 비공개 결과 폴더에 저장·readback 검증한 뒤 기존 `run-drive-screening.ts`에 전달한다. 같은 해시 이름이 있으면 실제 내용을 검증해 재사용한다. 실행기의 입력은 고정 Drive baseline 52개, 게시 head에 연결된 이전 Drive delta들, 현재 delta 순서다. Supabase source CSV fallback은 없다.
3. 이전 head와 모든 부모 archive·CSV·manifest 해시를 다시 검증한다. 부모 순서를 유지하고 준비 이후 head 변경을 거부한다. manifest의 이전 거래일까지 부모 이력이 없더라도 현재 v7 delta가 여러 거래일을 포함할 수 있다. 이 경우 현재 정규화된 CSV를 직접 읽어 공표 달력의 중간 거래일마다 요청 종목과 KOSPI/KOSDAQ의 유효 가격이 모두 있는지 검증한다. 실제 날짜·종목 누락이 있으면 계산/게시를 중단한다. baseline-only 모드는 이전과 같은 비교용 계산이며 최신 수집 실행으로 표시하지 않는다.
4. 홈페이지는 PR #395의 Drive proof-aware reader와 공통 publisher를 사용한다. 등록 baseline fingerprint와 웹 입력 identity를 맞추고 이전 FINAL을 PRELIMINARY로 덮어쓰지 않는다. 새 run 재실행은 동일 입력 ID를 중복 적재하지 않는다. 결과 저장은 여러 파일이므로 원자적 DB 트랜잭션으로 간주하지 않는다.
5. v7·v1.1·기존 분석·수동 메모리 회귀·일별 신호·과거 복구 Actions는 `CloudTrend screening-writer` concurrency group을 공유한다. 이는 GitHub Actions 내 직렬화이며 임의 외부 writer나 별도 원천 compaction에 대한 분산 CAS/lease 보장이 아니다. 게시 중 registry 변경은 공통 publisher가 재확인한다. v7 직접 CLI 게시를 거부하고 해당 Actions workflow 안에서만 허용한다.
6. 기존 안전 상한을 유지한다: 부모 proof 최대 64개 입력, head 최대 8MiB, parent archive 총 다운로드 제한. 상한 도달 시 조용히 이력을 자르지 않고 중단한다. 장기 baseline 재승격/이력 축약은 별도 작업이며 자동 실행하지 않는다.
7. 실제 새 거래일 private Drive → Actions → 운영 ETF 지수/사용자 설정 → 홈페이지 게시 E2E는 아직 수행하지 않았다. main 병합, runner의 기존 인증 설정 및 완성된 수집 manifest가 필요하다. 새 credential 생성, 자동 스케줄, 운영 게시, 확정 신호 이력 재작성은 이번 구현 작업에서 실행하지 않았다.

## 미국

미국 manifest의 제공 hash `a7db79ffb6a46c827072011dc0c0b14239e2315e4ce703f577640faec30f0368`는 실제 내려받은 값과 일치한다. 28개 입력은 ret120/ret252 등 feature가 든 날짜별 snapshot이고 장기 수정주가 이력이 아니다. 현행 `us_features.py`는 252일 수익률과 60일 SPY beta를 계산하며 `run-us-screening.ts`는 이전 rank/replay 상태 identity를 요구한다.

따라서 미국 수집은 비활성이다. 추가로 검증할 원천은 종목별 최소 253개 실제 가격 관측과 SPY 정렬 이력, 수정주가/기업행위 근거, dated universe/lifecycle 제외, 펀더멘털 시점, 이전 rank/beta 상태이다. 별도 연구 아카이브를 운영 입력에 자동 편입하지 않았다.

## 수집 이후 보완 검증

- Python Drive transport·ZIP·수집기 회귀 35개 테스트 통과(격리된 Python 3.12 환경에 v7 requirements 설치).
- TypeScript Drive 실행·게시·네트워크 경계·공식 파서/공표 계약 289개 테스트 통과.
- v7 전용 TypeScript 검사 및 전체 프로젝트 TypeScript 검사 통과.
- 다일 delta, 중간 거래일 누락, 종목·지수 누락, 변조, 동일 아카이브 재사용, 부모 순서, source capacity, FINAL 보호 및 결과-only 쓰기 범위를 모의 데이터로 검증했다. 실제 운영 E2E와는 구분한다.
- 기존 Drive screening CI에 v7 Python requirements 설치를 추가해 `pandas` 미설치로 전체 drive 테스트가 실패하던 문제를 해결했다.

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
