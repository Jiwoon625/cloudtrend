# 수집 완료 자료용 CloudTrend 스크리닝 실행기

기존 v6.1 자료수집기를 다시 돌리지 않고 저장된 한국 주식·국내 ETF 입력으로 GitHub Actions에서 기존 스크리닝 엔진을 실행합니다. 이번 기본 입력은 `288f696eb14c4ef48f267f3fcfb61151`이며, `kr-outputs.zip`의 매니페스트와 CSV를 사용합니다. `blobs.zip`이나 Pickle 체크포인트는 읽거나 실행하지 않습니다.

## 두 실행 방식

| 선택 | 당일 입력 | 과거 입력 | 결과 저장 | 홈페이지 |
| --- | --- | --- | --- | --- |
| `drive` 기본 | Drive ZIP에서 직접 읽기 | 현재 Supabase 활성 원천을 읽어 병합 | 원래 Drive run 폴더 | 갱신하지 않음 |
| `supabase` | 기존 원천등록기로 업로드·등록 | 현재 Supabase 활성 원천을 읽어 병합 | 홈페이지 및 원래 Drive run 폴더 | 갱신 |

당일 저장 CSV는 전체 장기 이력이 아닙니다. 오늘 입력만 분석하면 이동평균·수급·추세 판단 이력이 부족해지므로 두 방식 모두 기존 과거 자료를 함께 사용합니다. 기본 Drive 방식은 Supabase 읽기만 수행하며 원본 재업로드·등록부 변경·원장 변경을 하지 않습니다. 이 설계로 기존 v6.1 수집기의 원천 조회 방식도 유지합니다. 홈페이지까지 연결하는 운영은 `supabase`를 선택합니다. Drive 자료만으로 홈페이지를 갱신하는 기능은 이 버전에 포함하지 않습니다.

## 처음 한 번 설정

1. 이 변경을 main에 병합합니다. 워크플로는 `.github/workflows/drive-screening.yml`입니다.
2. 기존 저장소의 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_USER_ID` GitHub Secrets를 사용합니다. 값은 노트북에 넣지 않습니다.
3. Colab 비밀에 `GITHUB_TOKEN`을 등록하고 이 노트북에서 접근을 허용합니다. Fine-grained token의 대상 저장소는 `Jiwoon625/cloudtrend`, 필요한 권한은 `Actions: Read and write`, `Secrets: Read and write`, `Metadata: Read`입니다. 기존 토큰에 해당 권한이 없으면 보완해야 합니다.
4. `collectors/CloudTrend_screening_executor_v1.ipynb`를 Colab에서 엽니다.

## 실행

1. 수집 완료 run 폴더의 Drive ID와 collector run ID를 확인합니다. 제공된 기본값은 이번 저장 폴더를 가리킵니다.
2. 실행 방식을 선택하고 아래 실행 셀을 누릅니다.
3. Google 로그인 후 Colab이 갱신한 단기 Drive 인증을 암호화하여 GitHub Secret에 저장하고 workflow를 요청합니다. 인증값을 워크플로 입력·실행 파일·결과물에 넣지 않습니다. 노트북에서 장기 수집을 하거나 시장 API에 접속하지 않습니다.
4. 출력된 GitHub 실행 링크에서 진행을 확인합니다. 노트북을 닫아도 GitHub 작업은 계속됩니다.
5. 같은 Drive run 폴더에 저장된 `screening-results-<collectorRunId>-<githubRunId>-<attempt>.zip`을 확인합니다.

결과 ZIP에는 전체 종목 점수 CSV, 스크리닝 JSON, 요약 JSON, 진행 영수증이 포함됩니다. 계산이 실패한 경우에도 생성된 영수증을 가능한 범위에서 저장합니다. GitHub에서 계산이 성공하더라도 Drive 결과 저장이 실패하면 전체 workflow는 실패로 표시되므로 로그에서 실패 단계를 확인합니다. 다음 실행은 검증된 입력을 다시 읽어 계산합니다. Supabase 방식의 동일 원본 재실행은 기존 등록 ID를 재사용합니다.

## 입력 검증과 범위

- 매니페스트의 run ID·완료 여부·종목/지수 누락, CSV의 바이트 크기·SHA-256·행 수·중복·최신일 종목 가격과 지수를 확인합니다.
- ZIP 경로 탈출·중복 이름·심볼릭 링크·과도한 압축 해제 크기를 차단합니다.
- 기존 게시 계약 검증을 재사용하므로 PRELIMINARY를 FINAL로 바꾸지 않습니다. 이번 자료는 KRX 공표 대기 상태입니다.
- 현재 원천보다 오래된 run은 잘못 선택한 것으로 보고 중단합니다.
- 기존 스크리닝 writer와 동시 실행을 피하도록 GitHub 실행 잠금을 공유합니다.
- 이번 버전은 한국·국내 ETF run의 `kr-outputs.zip`에 적용됩니다. 미국 수집기의 저장 형식에는 적용하지 않습니다.
- 정상 실행에는 기존 Supabase 과거 원천 및 운용 설정에 대한 읽기 권한이 필요합니다. 모든 과거 원천의 Drive 전환은 별도 작업입니다.

## GitHub에서 직접 실행

GitHub Actions의 **CloudTrend Drive screening executor → Run workflow**에서도 실행할 수 있습니다. Colab이 저장한 `GOOGLE_DRIVE_ACCESS_TOKEN`은 단기 인증이므로 시간이 지난 뒤에는 Colab에서 새로 인증해야 합니다.

반복 로그인 없이 수동 GitHub 실행을 하려면 별도로 준비한 Google OAuth `authorized_user` JSON을 `GOOGLE_DRIVE_CREDENTIALS_JSON` Secret에 저장할 수 있습니다. 이 옵션은 workflow에서 토큰을 갱신합니다. 서비스 계정 JSON은 이 버전의 대상이 아닙니다. 인증정보를 저장소 파일·출력·노트북 셀에 붙여 넣지 않습니다.

## 검증

- 제공된 실제 ZIP: 1,798종목·2,180행·CSV 1개, SHA-256 및 최신일 가격/지수 검증 통과.
- 직접 실행기·기존 스크리닝·원천 등록/캐시 관련 TypeScript 테스트 53개, Python 전송/입력 검증 테스트 4개 통과.
- TypeScript 타입 검사 및 workflow 구조 검사 통과.
- Google OAuth 및 GitHub Secret 설정을 사용한 실제 Actions 전체 실행은 사용자의 Google 인증 후 확인해야 합니다.
