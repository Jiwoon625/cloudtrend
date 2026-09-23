# Backtest data architecture

## Current policy

CloudTrend의 장기 백테스트와 연구는 **Google Drive + Google Colab**에서 수행합니다.

- Google Drive: 한국·미국 시장 canonical Parquet, Reference, 연구 중간산출물, 결과
- Google Colab: DuckDB/Python 기반 백테스트·OOS·피처 연구
- GitHub: 운영 점수·진입/청산 규칙, Production 전략엔진, 코드 버전
- Supabase: screening input/result/history, portfolio, signal log, settings, lightweight cache

## Retired GitHub/Supabase backtest path

2026-09-23부터 다음 경로는 사용하지 않습니다.

- Supabase `backtest-canonical` / `etf-backtest-canonical`을 GitHub Actions가 다운로드하는 방식
- `.github/actions/backtest-source-cache`
- `.github/actions/etf-backtest-source-cache`
- `scripts/run-backtest.ts`의 Supabase 실행
- `backtest-canonical-migration.yml`
- `etf-backtest-canonical.yml`
- Supabase canonical을 전제로 한 과거 V7/V8 연구 Actions workflows

기존 한국 연구 데이터는 Google Drive `CloudTrend/한국시장`으로 검증 이관했으며, Supabase의 backtest source registry 기록은 삭제하지 않고 archived 상태로 보존합니다.

## Reproducibility

Colab 연구 결과는 가능한 한 다음 메타데이터를 함께 저장합니다.

- Universe/data version
- source manifest / SHA-256
- 연구 설정
- 평가기간
- Git commit SHA 또는 전략 버전
- QA 결과
- 결과 manifest

연구에서 채택한 규칙은 별도 검증 후 GitHub의 Production 전략엔진에 반영합니다. `src/lib/engine/**`은 운영 규칙의 기준이며, 연구 데이터 저장 위치 변경과 독립적으로 유지합니다.
