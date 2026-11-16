# 기존 Supabase 입력용 스크리닝 실행

GitHub Actions의 `CloudTrend screening` 워크플로는 Supabase에 저장된 활성 `screening` 원천데이터를 사용해 웹 스크리너·대시보드와 같은 운영 점수 스냅샷을 계산합니다.

이 문서는 기존 활성 Supabase source를 읽는 실행 경로입니다. 현재 한국·ETF Drive v7 실행은 [별도 문서](drive-history-v7/README.md)를 따릅니다. 범용 백테스트 옵션의 제거와 CM 전용 연구 Actions의 존재를 구분합니다. 모든 연구가 Colab에서만 실행되는 것은 아닙니다.

## Actions 화면에서 수동 실행

`Actions → CloudTrend screening → Run workflow`에서 실행합니다. 같은 코드·데이터·설정의 완료 결과가 있으면 기본적으로 재사용하며 `force`를 선택하면 다시 계산합니다.

## GPT 대화에서 실행

저장소 소유자가 전용 제어 이슈에 다음 형식으로 댓글을 남기면 같은 스크리닝 워크플로가 실행됩니다.

```text
/cloudtrend run
/cloudtrend run screening
/cloudtrend run screening force
```

`backtest`, `all`, `cost=`, `limit=`, `include-etf` 같은 과거 백테스트 옵션은 더 이상 지원하지 않습니다.

## 저장 위치

- 스크리닝 입력: Supabase private Storage / `analysis_source_files`의 활성 screening source
- 스크리닝 결과: Supabase private Storage의 `results/screening`
- 최신 화면 캐시: Supabase `cache/screening`, `cache/dashboard`, `cache/instruments`
- 스크리닝 이력: `public.screening_history`
- 실행 기록: `public.analysis_runs`
- 장기 백테스트 데이터·연구결과: Google Drive
- 백테스트 계산: Google Colab

## 필요한 GitHub Actions Secrets

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — 브라우저에 노출하지 않는 서버 전용 키
- `SUPABASE_USER_ID` — 스크리닝할 CloudTrend 계정의 Supabase Auth UUID

서버 키는 `VITE_*` 환경변수 또는 클라이언트 코드에 넣지 않습니다.
