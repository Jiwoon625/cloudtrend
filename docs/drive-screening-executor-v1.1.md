# CloudTrend 스크리닝 실행기 v1.1

기존 `CloudTrend_screening_executor_v1.ipynb`를 보존하고, Drive 수집 완료 자료로 **한 번 계산한 결과를 바로 홈페이지에 게시**하는 별도 실행기다.

| 항목 | v1.1 기본 실행 |
|---|---|
| 새 자료 수집 | 하지 않음 |
| 당일 입력 | 선택한 Drive run의 `kr-outputs.zip` |
| 과거 입력 | 기존 Supabase 활성 원천 + 앞서 게시한 Drive 추가분 |
| 계산 | 현재 공식 엔진 1회 |
| Supabase 원천 CSV·원천 등록부 | 업로드·등록·삭제하지 않음 |
| Supabase 결과 | 스크리닝·대시보드 JSON, 실행 결과, Drive 출처 메타데이터·영수증 |
| 홈페이지 표시 | 계산 결과 게시 후 읽기 검증 |
| Drive 결과 | 원래 run 폴더의 `screening-results-...zip` |
| 확정 신호 이력·원장·Shadow | 재작성하거나 실행하지 않음 |
| 최근 차트 | 선택 시 게시 이후 120일 차트 결과를 별도 준비 |

## 실행 방법

1. Drive의 **CloudTrend_screening_executor_v1.1.ipynb**를 Colab으로 연다.
2. 수집이 완료된 `DRIVE_RUN_FOLDER_ID`와 `COLLECTOR_RUN_ID`를 지정한다. 기본값은 검증된 2026-11-06 저장분이다.
3. `PREPARE_RECENT_CHARTS=True`면 현재 결과를 먼저 게시한 후 최근 120일 가격·점수·ETF 차트 결과를 준비한다. 빠르게 현재 표만 보려면 False로 둔다. 입력 CSV는 어느 경우에도 Supabase에 올리지 않는다.
4. 두 코드 셀을 실행한다. 기존 Colab 비밀 `GITHUB_TOKEN`과 Google 로그인을 사용한다. Supabase 서비스 키를 Colab에 넣지 않는다.
5. **홈페이지 게시와 읽기 검증이 끝났습니다**가 출력되면 https://cloudtrend.vercel.app 을 새로고침한다. 차트 준비와 Drive 결과 보관은 뒤이어 진행될 수 있다.

`WAIT_FOR_COMPLETION=True`는 진행 상황을 표시한다. 노트북을 닫아도 이미 시작한 GitHub 작업은 계속된다. 완료/실패는 실제 GitHub 실행과 단계를 조회해 표시하며, 요청 접수만으로 게시 성공을 알리지 않는다. 게시 뒤 차트/Drive 보관이 실패한 경우도 구분한다.

GitHub token 권한은 기존과 같이 대상 저장소 `Jiwoon625/cloudtrend`의 Actions·Secrets 쓰기와 Metadata 읽기가 필요하다. GitHub에는 기존 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_USER_ID`를 사용한다. Colab이 갱신한 Drive 단기 토큰은 암호화된 GitHub Secret으로 전달한다. 노트북·workflow 입력·결과물·로그에 인증값을 넣지 않는다.

## 게시 계약

기존 `source_storage=supabase`는 원천 CSV 등록을 동반하므로 재사용하지 않는다. 새 `source_storage=publish`가 검증된 Drive 입력으로 한 번 계산한 bundle을 게시한다. 기존 `providedInputs + --upload` 거부문과 v1의 두 실행 방식은 유지한다.

홈페이지의 새로운 Drive 결과 reader는 기존 활성 원천·설정·운영 지수의 fingerprint에 Drive 파일별 해시·공표 명세·순서를 결합해 검사한다. 표에 결과만 복사하고 기존 원천 fingerprint인 것처럼 가장하지 않는다. 기존 등록 원천 cache도 같은 방식으로 계속 읽는다. 홈페이지의 명시적 재실행은 유효한 Drive 게시 결과를 재사용하며, 등록 원천만으로 더 오래된 결과를 덮어쓰지 않는다.

원천 bytes는 Drive에 보존한다. Supabase의 `results/drive-screening/input-head/latest.json`에는 파일 ID·SHA256·공표 명세·적용 순서만 남긴다. 다음 실행은 이전 Drive ZIP을 검증해 이어 읽는다. 이전 거래일의 실행 누락, 이전 ZIP의 삭제·수정, 기준 원천/설정 변화, 누락된 부모 이력, 동시 head 변경은 조용히 무시하지 않고 중단한다. 64개 추가 입력을 넘으면 별도 baseline 정리가 필요하며 오래된 이력을 자동으로 버리지 않는다. 기존 원천 업로드 방식과 섞어 기준을 바꾼 경우도 자동 이관으로 간주하지 않는다. 이전 거래일이 비어 있으면 해당 날짜의 Drive run부터 차례로 실행해야 한다.

기존 두 한국 GitHub 게시 workflow는 같은 writer lock을 사용한다. 게시 직전/후 활성 원천 fingerprint를 다시 확인하고 오래된 날짜 및 같은 날짜 FINAL→PRELIMINARY 덮어쓰기를 차단한다. 게시 세대 ID·입력 fingerprint·결과 digest를 head와 두 결과 cache에 함께 기록한다. reader는 세대가 다르면 게시 중으로 처리하며, 화면의 재실행·요약 복구는 이전 Drive 결과를 다시 저장하지 않는다. 게시 중 실패한 metadata head는 다음 실행의 재개 근거로 보존한다. 이 기능은 운영 DB의 분산 트랜잭션을 추가하는 방식이 아니며, 실패 시 영수증을 확인하고 같은 run으로 재개해야 한다.

PRELIMINARY를 임의로 FINAL로 바꾸지 않는다. 실제 FINAL 입력은 최신 행의 KRX 시가총액을 확인하고, 이전 잠정 자료의 모든 키와 해당 날짜의 공식 시가총액을 실제로 보완한 경우에만 기존 서버의 동일한 검증 함수로 해소 근거를 만든다. 불완전한 보완은 잠정 상태로 유지한다. 엔진이 확정 결과에서 공표 필드를 생략하는 기존 형식도 지원한다. 이 버전은 홈페이지 현재 결과 게시용이며 확정 신호 이력·성과/원장 갱신을 따로 실행하지 않는다. 한국·국내 ETF의 현재 v1 입력 형식만 지원하며 미국 입력을 혼합하지 않는다. 과거 원천 전체의 Drive 전환은 별도 v7 검증 경로다.

최근 120일 차트는 runner 안에 보관한 검증 입력으로 파서와 기존 차트 함수를 이용해 결과 cache만 만든다. 전체 스크리닝을 다시 실행하지 않는다. 전체 기간 차트를 서버에서 새로 만들려면 Drive 원천 reader가 추가로 필요하므로 이 버전에서 등록 원천만으로 잘못 재계산하지 않는다. 준비되지 않은 차트는 준비 필요 안내를 표시한다.

## 검증

- 원천 등록·업로드 0, 원천/원장 쓰기 경로 차단, 엔진 1회 호출을 자동 검사했다.
- Drive 파일·공표 manifest·기준 fingerprint의 변조, 누락·중복·오래된 게시·경쟁 head를 차단하는 테스트를 실행했다.
- 이전 Drive 추가분의 재조회와 SHA256 검증을 Python 모의 전송으로 검사했다.
- 실제 2026-11-06 Drive 결과 1,798종목과 고정 원천 메타데이터를 이용한 mock transport 게시에서 전체 분석 보존, 홈페이지 fingerprint 일치, 원천 쓰기 0, 결과 읽기 검증을 확인했다. 실제 Supabase에는 쓰지 않은 검사다.
- 타입·빌드·게시/입력/기존 기능 회귀 검사를 수행한다. 최종 테스트 수와 CI 결과는 배포 패키지에 기록한다.
- 사용자 Google 로그인 → Colab → GitHub dispatch의 실제 인증 실행은 사용자가 노트북을 실행할 때 확인한다. 기존 11/06 홈페이지 결과를 다시 덮어쓰는 실행은 하지 않았다.
