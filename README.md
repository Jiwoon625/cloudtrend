# TrendScore KR — 한국 주식·ETF 중기 추세추종 스크리너

규칙 기반 중기 추세추종 스크리닝 결과와 **계산 근거**를 함께 보여주는 리서치 도구입니다.
투자 판단을 대신하지 않으며, 자동 주문 기능도 제공하지 않습니다.

## 주요 기능

- 3단계 분리 스크리닝: ① Universe(실격) 필터 → ② 시장 게이트 → ③ 점수 산정
- Technical Signal Score 7점, Priority Quality Score 10점, Fundamental Score 100점,
  ETF 상품건전성 100점, 섹터·시장 점수 100점을 **별개 지표로** 표시
- 일목균형표, 볼린저밴드(스퀴즈/돌파/Head Fake), 이동평균 정배열, ATR, 거래량·거래대금 비율,
  RS20/RS60 등 순수 함수 지표 엔진
- 데이터가 없으면 0점 대신 **“데이터 없음”**으로 표시하고 산정 가능 점수·정규화 점수를 별도 제공
- 종목 상세: 조건별 획득/산정가능 점수 표, 차트(MA·볼린저·일목 구름·거래량), 규칙 기반 설명 문장,
  계산 근거 로그(JSON)
- 스크리너: 프리셋, 필터 저장, 열 정렬·숨김, 실격 종목 보기, CSV 다운로드
- 섹터 상대강도 순위, 데이터 품질 검증 화면, 포지션 사이징 계산기(1R/2R/3R, 오픈 리스크 한도)
- 한국어 기본 · 원/억 원/조 원 단위 · 다크 모드 · 모바일 반응형

## 시스템 구조

이 저장소는 Lovable 표준 스택인 **TanStack Start v1(React 19 + TypeScript + Vite 7)** 기반입니다.
(요청서의 Next.js 대신 동일 역할의 프레임워크를 사용하며, 라우팅/서버 함수/SSR 구조는 동등합니다.)

```
src/
  lib/engine/
    types.ts          도메인 타입 (Instrument, DailyPrice, FinancialSnapshot, ETFMetadata 등)
    indicators.ts     지표 순수 함수 (MA/ATR/볼린저/일목/거래량/상대강도)
    scoring.ts        실격 필터·시장 게이트·점수·포지션 사이징 순수 함수
    mockProvider.ts   교체 가능한 mock 데이터 공급자 (시드 기반 결정론적 합성 데이터)
    pipeline.ts       지표 → 필터 → 게이트 → 점수 파이프라인 및 섹터 점수
    *.test.ts         단위 테스트
  lib/format.ts       한국식 숫자 표기
  components/         AppShell, ScreenerView, ScreenerTable, BreakdownTable
  routes/
    index.tsx                 대시보드
    screener.stocks.tsx       주식 스크리너
    screener.etfs.tsx         ETF 스크리너
    sectors.tsx               섹터 상대강도
    instrument.$symbol.tsx    종목 상세 (점수 근거·차트·계산 로그)
    position-sizing.tsx       포지션 사이징 계산기
    data-status.tsx           데이터 상태 및 검증
```

## 설치 및 실행

```bash
bun install       # 또는 npm install
bun run dev       # 개발 서버 (http://localhost:8080)
bun run build     # 프로덕션 빌드
bunx vitest run   # 계산 단위 테스트
```

## 환경변수

`.env.example`을 복사해 `.env`로 사용합니다. 초기 버전은 mock provider로 동작하므로
외부 키 없이 실행됩니다. 어떤 API 키도 프론트엔드 번들에 노출하지 않습니다.

## mock 데이터

`src/lib/engine/mockProvider.ts`가 시드(종목코드 해시) 기반 PRNG로 KOSPI 10종목,
KOSDAQ 10종목, ETF 10종목, 시장지수 3개, 섹터지수 7개의 **300거래일** 합성 시계열을 생성합니다.
동일 시드·동일 파라미터면 항상 같은 데이터와 같은 점수가 산출됩니다.
포함 시나리오: A등급 7점, A등급+Risk-Off 민감, B등급 리테스트 대기, Head Fake, 거래량 부족,
펀더멘털 일부 누락, ETF 괴리율 초과, 20MA 이탈 청산 점검, 구름 하단 이탈.

## 실제 데이터 공급자 연결

`mockProvider.ts`가 노출하는 인터페이스(`getBars`, `getFinancials`, `getEtfFacts`,
`getIndexSeries`)를 동일 시그니처로 구현한 adapter를 추가하고 `pipeline.ts`의 import만 교체합니다.
API 원본 응답과 가공 결과는 분리 저장하고, 재무 데이터는 **공시일(announcedAt) 이후 날짜**의
스크리닝에서만 사용해야 합니다(결산기말 날짜를 정보 이용 가능일로 쓰지 않습니다).

## 지표 계산 정의 (요약)

- MA20/60/120: 종가 단순평균, MA20Slope = 오늘 MA20 − 5거래일 전 MA20
- ATR14: Wilder 평활(기본), SMA 방식 선택 가능
- 볼린저: 20기간·2σ, Bandwidth = (상단−하단)/중심선×100.
  스퀴즈는 **돌파 전일까지** 데이터로 판정하고 돌파 당일은 밴드폭 확장을 별도 평가
- 일목: 9/26/52, 표시 구름은 26봉 전 선행스팬으로 산출(현재 구름 ≠ 미래 구름).
  점수용 후행스팬 정의는 “현재 종가 > 26거래일 전 종가”
- 거래량 비율: 당일 거래량 / 직전 20거래일 평균(기본값 당일 제외) × 100
- RS: 종목 기간수익률 − 벤치마크 기간수익률 (KOSPI/KOSDAQ, ETF는 기초지수 없으면 KOSPI 대체 표시)

## 점수 계산 정의 (요약)

- Technical 7점: 일목 2 + 볼린저 2 + 거래량 2 + 이동평균 1, A≥6 / B 4~5 / C≤3
- Priority 10점: 지수 편입 2(중복 1회) + 외국인 3개월 2 + 밸류업 1 + 실적 모멘텀 2 +
  신고가 1 + 규모 1 + 당일 초과수익률 1
- Fundamental 100점: 수익성 25 + 성장성 25 + 재무건전성 25 + 밸류에이션 25
- 종합점수 = 각 정규화 점수의 가중 평균(주식 45/20/25/10, ETF 55/15/15/15).
  Risk-Off는 점수를 깎지 않고 상태로만 표시하며, 구름 내부·아래는 진입 적합으로 표시하지 않습니다.

## 알려진 제한사항

- 현재는 mock provider 전용이며 실거래 데이터·DB(Prisma/PostgreSQL) 영속화는 연결되지 않았습니다.
- 전일 스냅샷이 없어 “신규 A등급 진입”, “A→B 하락”은 미집계로 표시합니다.
- 리테스트 상태 머신, 백테스트(Phase 4), 관심종목·보유종목·매매일지 영속화는 후속 단계입니다.
- 차트는 라인/영역 기반이며 캔들 렌더링은 후속 개선 항목입니다.

## 투자 유의사항

모든 화면의 점수와 라벨(“관심 후보”, “리테스트 대기”, “관망”, “청산 점검”)은 규칙 계산 결과이며
매수·매도 권유가 아닙니다. 현재 데이터는 전부 합성 데이터입니다.
