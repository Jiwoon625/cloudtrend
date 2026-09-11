# CloudTrend 자동 분석

GitHub Actions의 `CloudTrend analysis` 워크플로는 Supabase에 저장된 동일 입력을 사용해 다음을 실행합니다.

- `screening`: 웹 스크리너·대시보드와 같은 점수 엔진으로 최신 스냅샷 계산
- `backtest`: 웹 백테스트와 같은 V6 엔진 실행
- `all`: 두 실행을 순서대로 수행

입력은 `analysis_source_files`의 활성 원천데이터를 우선 사용합니다. 등록부 도입 전에 웹에서 올린
`kr.json`과 `backtest/index.json`은 자동 호환되며, 장기자료는 데이터 해시로 중복을 제거합니다.
파일 검증·등록·교체 명령은 [`data-ingestion.md`](data-ingestion.md)를 참고하세요.

상세 번들은 Supabase private Storage의 `<uid>/results/screening|backtest`에 저장되고, GPT가 빠르게 질의할 핵심 결과는
`public.analysis_runs`에 사용자별 RLS가 적용된 JSON 요약으로 저장됩니다. 실행마다 Git SHA,
데이터 SHA-256, 설정과 종목별 섹터 매핑을 기록합니다.

## Actions 화면에서 수동 실행

`Actions → CloudTrend analysis → Run workflow`에서 실행 대상, 비용, Universe 크기, ETF 포함 여부를
선택합니다. 같은 코드·데이터·설정의 완료 결과가 있으면 기본적으로 재사용하며 `force`를 선택하면
다시 계산합니다.

## GPT 대화에서 실행

저장소 소유자가 전용 제어 이슈에 다음 형식으로 댓글을 남기면 같은 워크플로가 실행됩니다.

```text
/cloudtrend run
/cloudtrend run screening
/cloudtrend run backtest cost=30 limit=613 exclude-etf
/cloudtrend run all force
```

명령은 소유자 댓글만 허용하며, 정해진 토큰과 수치 범위를 벗어나면 실행 전에 거부됩니다. GPT는
GitHub 연결로 이 댓글을 작성하고 실행 상태를 확인한 다음, Supabase의 `analysis_runs.summary`를
조회해 결과를 답변할 수 있습니다.

## 필요한 GitHub Actions Secrets

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — 브라우저에 노출하지 않는 서버 전용 `sb_secret` 키
- `SUPABASE_USER_ID` — 분석할 CloudTrend 계정의 Supabase Auth UUID

서버 키는 `VITE_*` 환경변수 또는 클라이언트 코드에 넣지 않습니다.
