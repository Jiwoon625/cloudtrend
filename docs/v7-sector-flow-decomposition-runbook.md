# V7.2 섹터 점수대 분해 실행

GitHub 이슈 댓글에서 다음 명령으로 실행합니다.

```text
/cloudtrend v7-flow
```

워크플로는 Supabase의 백테스트 장기 데이터를 불러와 `v7-sector-flow-runs/`에 결과 JSON을 생성합니다.

결과에는 기존 V7의 Price Leadership / Money Flow / Rotation Score 분해뿐 아니라 V7.2의 점수대별 분포, 점수대 체류기간, 점수대 진입 후 수익률, 점수와 향후 수익률 간 상관계수가 포함됩니다.

최신 결과는 Supabase `results/sector-v7-flow/latest.json`에도 저장됩니다.
