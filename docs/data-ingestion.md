# CloudTrend 원천데이터 등록

CloudTrend는 웹과 GPT/ChatGPT Work에서 받은 파일을 같은 검증기로 처리합니다. CSV가 기본 형식이며
XLSX와 JSON도 입력할 수 있습니다. 계산용 표준 형식은 UTF-8 CSV이지만, 감사 추적을 위해 사용자가
제공한 원본 파일 자체를 비공개 Storage에 보관합니다.

## 자연어 요청과 실행 모드

| 요청 예시                                      | source type | mode            | 동작                                 |
| ---------------------------------------------- | ----------- | --------------- | ------------------------------------ |
| 이 파일 오늘 스크리닝용 데이터로 등록해줘      | `screening` | `replace`       | 기존 활성 스크리닝 원천을 교체       |
| 이 파일을 스크리닝 데이터에 이어붙여줘         | `screening` | `append`        | 값이 다른 중복 행이 없을 때 추가     |
| 이 파일을 기존 스크리닝 데이터와 병합해줘      | `screening` | `merge`         | 같은 종목·거래일은 새 파일 우선      |
| 이 파일을 장기 백테스트 데이터에 추가해줘      | `backtest`  | `add`           | 기존 활성 장기자료에 추가            |
| 이 파일로 기존 장기 백테스트 데이터를 교체해줘 | `backtest`  | `replace_all`   | 기존 활성 장기자료 전체를 대체       |
| 이 파일은 등록하지 말고 검증만 해줘            | 해당 유형   | `validate_only` | Supabase·GitHub에 아무것도 쓰지 않음 |
| 이 파일 등록하고 스크리닝 다시 돌려줘          | `screening` | `replace` + run | 등록 후 공통 스크리닝 엔진 실행      |

요청이 `추가`인지 `전체 교체`인지 불분명하면 쓰기 전에 확인해야 합니다. `validate_only`는 서비스
키와 사용자 ID 없이도 실행되며 원본·정규화본·검증결과를 저장하지 않습니다.

## CLI

```bash
# 등록 없이 검증
npm run data:ingest -- \
  --input ./today.csv \
  --source-type screening \
  --mode validate_only

# 오늘 스크리닝 파일로 교체 등록
npm run data:ingest -- \
  --input ./today.csv \
  --source-type screening \
  --mode replace \
  --supabase-user-id "$SUPABASE_USER_ID"

# 장기 백테스트 파일 추가
npm run data:ingest -- \
  --input ./history-part-09.csv \
  --source-type backtest \
  --mode add \
  --supabase-user-id "$SUPABASE_USER_ID"

# 전체 교체 후 동일 엔진으로 백테스트 실행
npm run data:ingest -- \
  --input ./history-full.csv \
  --source-type backtest \
  --mode replace_all \
  --run backtest \
  --supabase-user-id "$SUPABASE_USER_ID"
```

등록·목록·삭제·실행에는 서버 전용 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`가 필요합니다.
`SUPABASE_USER_ID`는 환경변수로 두거나 인자로 지정할 수 있습니다. 서비스 역할 키는 출력 JSON,
브라우저 환경변수, 소스코드, 이슈 댓글에 포함하지 않습니다.

```bash
# 활성·과거 등록 내역 조회
npm run data:ingest -- \
  --list --source-type backtest \
  --supabase-user-id "$SUPABASE_USER_ID"

# 등록 ID로 삭제
npm run data:ingest -- \
  --remove-source-id 00000000-0000-0000-0000-000000000000 \
  --supabase-user-id "$SUPABASE_USER_ID"
```

CLI는 자동화가 읽을 수 있는 JSON만 반환합니다. `ok`, `sourceType`, `mode`, `source.id`, 통계,
세 가지 SHA-256, 경고·오류, 중복·충돌 결과와 후속 분석 요약이 포함됩니다. 행 원문이나 비밀키는
응답에 포함하지 않습니다.

## 검증 기준

- 파일당 최대 45MB
- CSV/XLSX/JSON 구조와 인코딩 확인
- 필수 열 `symbol`, `date`, `close`
- 날짜 실재 여부, 숫자·양수/음수 범위, OHLC 관계 확인
- 종목코드는 앞자리 0을 보존하여 6자리로 정규화
- 같은 파일 안의 동일 행은 1건으로 정리하고, 값이 다른 동일 종목·거래일은 오류
- KOSPI 지수 60거래일과 분석 대상 종목이 존재하는지 공통 엔진으로 최종 확인
- 내장 613종목 및 추가 섹터 매핑을 적용하고 매핑/미매핑 수 기록

`append`와 `add`는 기존 활성 데이터와 값이 다른 동일 종목·거래일이 있으면 중단합니다.
`merge`는 새 스크리닝 파일을 우선하고, `replace`와 `replace_all`은 교체할 기존 데이터의 충돌을
오류로 보지 않습니다. 파일명 변경과 무관하게 정규화 데이터 해시가 같으면 중복 등록을 재사용합니다.

## Supabase 구조

```text
cloudtrend-data (private)
└── <user-id>/
    ├── source/
    │   ├── screening/<source-id>/<original-file>
    │   └── backtest/<source-id>/<original-file>
    ├── results/
    │   ├── ingestion/<source-id>.json
    │   ├── screening/<run-id>.json
    │   └── backtest/<run-id>.json
    ├── kr.json                     legacy web compatibility
    └── backtest/*.json             legacy web compatibility
```

`analysis_source_files`는 원본 경로, 파일·데이터·스키마 해시, 행·종목·기간·시장·섹터 통계,
검증결과, 중복·충돌 결과와 활성 상태를 보관합니다. 버킷은 비공개이며 RLS가 사용자 ID 첫 경로를
강제합니다. 결과 폴더와 원천 폴더의 허용 경로도 별도 정책으로 제한합니다.

기존 웹 업로드 형식은 당장 제거하지 않습니다. 웹은 신규 등록부와 기존 호환 객체를 함께 갱신하고,
GitHub Actions는 활성 등록부를 우선 사용합니다. 전환 전에 저장된 백테스트 파일은 데이터 해시로
중복을 제거한 뒤 함께 읽으므로 기존 장기자료가 빠지지 않습니다.

## ChatGPT Work 운영 흐름

1. 첨부 파일을 위 자연어 모드 중 하나로 명확히 분류합니다.
2. 먼저 `validate_only` 결과를 확인합니다.
3. 등록이 요청된 경우에만 원본을 Supabase에 등록합니다.
4. `analysis_source_files`의 활성 행과 Storage 경로·해시를 다시 조회해 저장을 검증합니다.
5. 재실행 요청이 있으면 `/cloudtrend run screening|backtest|all` 트리거를 실행합니다.
6. GitHub Actions 완료 후 `analysis_runs.summary`와 private 결과 번들을 읽어 보고합니다.

Work 실행 환경에 서버 비밀키가 노출되지 않는 경우에는 로그인된 CloudTrend 웹의 동일 업로드
컨트롤을 사용합니다. 웹도 같은 검증·등록 코드를 사용하므로 결과는 동일합니다. 서비스 역할 키를
대화나 브라우저에 복사해서 해결하지 않습니다.

## 저장용량

Supabase Free 플랜의 전체 Storage 1GB 안에서 운영합니다. 파일 개수에는 앱 자체 제한을 두지 않지만
각 파일은 45MB 이하여야 합니다. 원본은 한 번만 저장하고 별도 정규화 사본은 만들지 않으며,
계산할 때 검증 후 표준 CSV로 변환합니다. 유료 전환이나 새 유료 브랜치는 자동으로 만들지 않습니다.
