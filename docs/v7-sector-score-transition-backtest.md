# CloudTrend V7.3 · Sector Score Band Transition Backtest

V7.2는 점수대별 분포, 체류기간, 상태 기준 수익률, 점수-수익률 상관관계를 확인했다. V7.3은 여기서 한 단계 더 나아가 **점수대가 바뀌는 순간**을 이벤트로 잡고, 전환 이후 5/10/20/40거래일 수익률과 KOSPI 대비 초과수익률을 검증한다.

## 목적

단순히 `현재 점수가 높다`가 아니라 다음 질문을 검증한다.

1. 40점 미만에서 40점 이상으로 올라오는 초기 개선 신호가 유효한가?
2. 40~60점대에서 60점 이상으로 올라오는 Top4 진입 신호가 유효한가?
3. 70점 이상 또는 80점 이상으로 급격히 올라온 섹터는 추세가 이어지는가, 과열인가?
4. 60점 이상에서 60점 미만으로 이탈하면 이후 초과수익률이 악화되는가?
5. Price Leadership, Money Flow, Rotation Momentum, Rotation Score 중 어떤 전환 신호가 가장 실전성이 있는가?

## 분석 대상 점수군

- `PRICE`: Price Leadership
- `FLOW`: Money Flow
- `MOMENTUM`: Rotation Momentum
- `ROTATION`: Rotation Score

## 점수대

```text
0~20
20~40
40~60
60~70
70~80
80~90
90~100
```

## 전환 이벤트 정의

전일 관측 점수대와 당일 관측 점수대가 달라진 경우만 이벤트로 기록한다.

예시:

```text
40~60 -> 60~70  상향 전환
60~70 -> 40~60  하향 전환
70~80 -> 80~90  상향 전환
```

전환일 당일 종가를 기준으로 이후 5/10/20/40거래일 섹터 중앙수익률과 KOSPI 대비 초과수익률을 계산한다.

## 대표 신호군

V7.3은 모든 개별 전환 외에도 다음 신호군을 요약한다.

| signalId | 의미 |
|---|---|
| `ANY_UP` | 모든 상향 점수대 전환 |
| `BELOW_40_TO_40_PLUS` | 40점 미만에서 40점 이상 진입 |
| `BELOW_60_TO_60_PLUS` | 60점 미만에서 60점 이상 진입 |
| `BAND_40_60_TO_60_PLUS` | 40~60점대에서 60점 이상 진입 |
| `BELOW_70_TO_70_PLUS` | 70점 미만에서 70점 이상 진입 |
| `BELOW_80_TO_80_PLUS` | 80점 미만에서 80점 이상 진입 |
| `UP_TWO_OR_MORE_BANDS` | 2개 이상 점수대 상향 점프 |
| `DOWN_FROM_60_PLUS` | 60점 이상에서 60점 미만 이탈 |
| `DOWN_FROM_70_PLUS` | 70점 이상에서 70점 미만 이탈 |

## 결과 파일

실행 결과는 다음 JSON으로 저장된다.

```text
v7-sector-transition-runs/<runId>/sector-score-transitions.json
```

Supabase 최신 결과 경로는 다음과 같다.

```text
<userId>/results/sector-v7-transition/latest.json
```

## 실행 명령

GitHub 이슈 댓글에서 다음 명령으로 실행한다.

```text
/cloudtrend v7-transition
```

## 해석 원칙

- `60점 이상 진입`이 양호하지 않고 `40점 이상 진입`이 양호하면, 완성된 주도 섹터보다 초기 개선 섹터를 보는 전략이 낫다.
- `70점 이상 진입` 또는 `80점 이상 진입`의 초과수익률이 나쁘면, 고점수는 추격매수보다 과열 경계 신호로 해석한다.
- `Money Flow 상향 전환`이 `Price Leadership 상향 전환`보다 낫다면, 수급 개선이 가격 강세보다 빠른 선행 신호일 수 있다.
- `Rotation Momentum`은 중앙 체류기간이 짧으므로, 단독 상태 지표가 아니라 단기 가속도 이벤트로 해석한다.
- 모든 성과는 섹터 구성 종목의 중앙값 수익률 기준이며, KOSPI 수익률을 차감한 초과수익률을 함께 본다.
