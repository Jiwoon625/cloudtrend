import { describe, expect, it } from "vitest";

import { computeIndicators, type IndicatorSnapshot } from "./indicators";
import {
  actionLabel,
  calculatePositionSizing,
  evaluateMarketGate,
  fundamentalScore,
  DEFAULT_SCORING_CONFIG,
  mergeScoringConfig,
  normalize,
  priorityMaxPoints,
  priorityScore,
  SCORING_CONFIG_VERSION,
  technicalMaxPoints,
  technicalGrade,
  technicalScore,
  totalScore,
  STOCK_WEIGHTS,
} from "./scoring";
import { getBars, getFinancials, getMockDataset, INSTRUMENTS } from "./mockProvider";
import { runAnalysis } from "./pipeline";
import type { FinancialFacts, Instrument } from "./types";

function snapshot(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  const base: IndicatorSnapshot = {
    tradeDate: "2026-08-28",
    close: 100,
    ma20: 95,
    ma60: 90,
    ma120: 85,
    ma20Slope: 1,
    maAligned: true,
    atr14: 2,
    bollinger: {
      bb: { middle: 95, upper: 99, lower: 91, width: 8.4 },
      bbBreakout: true,
      bbSqueezePrior: true,
      bbSqueezeAbsolute: true,
      bbWidthExpanding: true,
      bbWalk: false,
      headFakeWarning: false,
    },
    ichimoku: {
      tenkan: 98,
      kijun: 94,
      cloudTop: 92,
      cloudBottom: 88,
      futureSenkouA: 96,
      futureSenkouB: 93,
      futureCloudBullish: true,
      tenkanAboveKijun: true,
      tenkanKijunGoldenCrossToday: false,
      chikouAbovePast26Close: true,
      chikouVsDisplayedCandle: true,
    },
    volumeRatio20: 220,
    tradingValueRatio20: 210,
    high52w: 104,
    distanceFrom52wHigh: -3.8,
    return20: 0.1,
    return60: 0.2,
    dayReturn: 0.03,
    foreignNet5d: 1e9,
    foreignNet20d: 2e9,
    foreignNet60d: 3e9,
    institutionNet20d: 1e8,
    extensionFromMa20: 5.2,
    atrExtension: 2.5,
    closeLocationValue: 0.85,
  };
  return { ...base, ...overrides };
}

describe("V4 Technical Signal Score", () => {
  it("모든 조건 충족 시 만점 7점, A등급", () => {
    const block = technicalScore(snapshot(), 85);
    expect(block.maxPoints).toBe(7);
    expect(block.points).toBe(7);
    expect(technicalGrade(block.points)).toBe("A");
  });

  it("일목 구름 상단 위는 전환선·후행스팬 없이도 단독 2점", () => {
    const block = technicalScore(
      snapshot({
        ichimoku: {
          ...snapshot().ichimoku,
          tenkanAboveKijun: false,
          chikouAbovePast26Close: false,
        },
      }),
      85,
    );
    const row = block.rows.find((r) => r.rule.startsWith("일목 구름 상단 위"))!;
    expect(row.points).toBe(2);
    expect(row.status).toBe("PASS");
  });

  it("이동평균 정배열은 MA20 기울기를 요구하지 않고 단독 2점", () => {
    const block = technicalScore(snapshot({ ma20Slope: -3 }), 85);
    const row = block.rows.find((r) => r.rule.startsWith("이동평균 정배열"))!;
    expect(row.points).toBe(2);
    const notAligned = technicalScore(snapshot({ maAligned: false }), 85).rows.find((r) =>
      r.rule.startsWith("이동평균 정배열"),
    )!;
    expect(notAligned.points).toBe(0);
  });

  it("Momentum Confirmation은 전환선 > 기준선 단일 조건만 사용한다", () => {
    const base = snapshot();
    const points = (tk: boolean, slope: number, ret: number) =>
      technicalScore(
        snapshot({
          ichimoku: { ...base.ichimoku, tenkanAboveKijun: tk },
          ma20Slope: slope,
          return20: ret,
        }),
        85,
      ).rows.find((r) => r.group === "Momentum Confirmation")!.points;

    expect(points(false, -1, -0.1)).toBe(0);
    expect(points(false, 1, 0.1)).toBe(0);
    expect(points(true, -1, -0.1)).toBe(1.5);
    expect(points(true, 1, 0.1)).toBe(1.5);
  });

  it("MA20 상승과 20일 수익률 양수는 기술점수를 바꾸지 않는다", () => {
    const base = snapshot();
    const a = technicalScore(snapshot({ ma20Slope: -5, return20: -0.2 }), 85).points;
    const b = technicalScore(snapshot({ ma20Slope: 5, return20: 0.2 }), 85).points;
    expect(a).toBe(b);
    expect(
      technicalScore(base, 85).rows.some(
        (r) => r.rule.includes("MA20 상승") || r.rule.includes("20일 수익률 양수"),
      ),
    ).toBe(false);
  });

  it("볼린저 스퀴즈 단독으로는 점수가 없고, 상단 돌파는 1점", () => {
    const base = snapshot();
    const squeezeOnly = technicalScore(
      snapshot({ bollinger: { ...base.bollinger, bbBreakout: false } }),
      85,
    );
    const row = squeezeOnly.rows.find((r) => r.group === "Breakout")!;
    expect(row.points).toBe(0);
    expect(technicalScore(snapshot(), 85).rows.find((r) => r.group === "Breakout")!.points).toBe(1);
  });

  it("고가마감 거래량: 거래량 150% 이상 AND CLV 0.7 이상일 때만 0.5점", () => {
    const vol = (ratio: number | null, clv: number | null) =>
      technicalScore(snapshot({ volumeRatio20: ratio, closeLocationValue: clv }), null).rows.find(
        (r) => r.group === "Volume",
      )!;
    expect(vol(150, 0.7).points).toBe(0.5);
    expect(vol(149, 0.9).points).toBe(0);
    expect(vol(200, 0.69).points).toBe(0);
    expect(vol(null, 0.9).status).toBe("NO_DATA");
    expect(vol(200, null).status).toBe("NO_DATA");
  });

  it("거래대금 백분위는 점수에 영향을 주지 않는다 (참고 정보)", () => {
    expect(technicalScore(snapshot(), 85).points).toBe(technicalScore(snapshot(), 10).points);
  });

  it("20일선 과열 이격률은 기술점수를 바꾸지 않는다", () => {
    const a = technicalScore(snapshot({ extensionFromMa20: 2 }), 85).points;
    const b = technicalScore(snapshot({ extensionFromMa20: 45, atrExtension: 9 }), 85).points;
    expect(a).toBe(b);
  });

  it("구름 내부면 구름 항목 0점", () => {
    const block = technicalScore(snapshot({ close: 90 }), 85);
    expect(block.rows[0]!.points).toBe(0);
    expect(block.rows[0]!.status).toBe("FAIL");
  });

  it("데이터 없음은 0점과 구분되고 산정 가능 점수에서 제외된다", () => {
    const block = technicalScore(
      snapshot({
        volumeRatio20: null,
        bollinger: {
          bb: null,
          bbBreakout: null,
          bbSqueezePrior: null,
          bbSqueezeAbsolute: null,
          bbWidthExpanding: null,
          bbWalk: null,
          headFakeWarning: null,
        },
      }),
      null,
    );
    expect(block.availableMaxPoints).toBe(5.5);
    expect(block.rows.find((r) => r.group === "Volume")!.status).toBe("NO_DATA");
    expect(normalize(block)).toBeCloseTo((block.points / 5.5) * 100);
  });

  it("Head Fake 경고 시 돌파 점수는 0", () => {
    const base = snapshot();
    const block = technicalScore(
      snapshot({ bollinger: { ...base.bollinger, headFakeWarning: true } }),
      85,
    );
    expect(block.rows.find((r) => r.group === "Breakout")!.points).toBe(0);
  });

  it("등급 경계값", () => {
    expect(technicalGrade(6)).toBe("A");
    expect(technicalGrade(5)).toBe("B");
    expect(technicalGrade(4)).toBe("B");
    expect(technicalGrade(3)).toBe("C");
  });
});

describe("시장 게이트", () => {
  const bench = snapshot();
  it("4개 충족은 Risk-On, 점수를 변경하지 않는다", () => {
    const gate = evaluateMarketGate({ benchmark: bench, vkospi: 15, marketForeignNet5d: 1 });
    expect(gate.status).toBe("RISK_ON");
    const tech = technicalScore(bench, 85);
    expect(tech.points).toBe(7);
    expect(actionLabel("A", gate.status)).toBe("강한 관심 후보");
  });

  it("Risk-Off에서도 기술점수는 그대로이고 라벨만 관망 계열", () => {
    const gate = evaluateMarketGate({
      benchmark: snapshot({ ma60: 120, ichimoku: { ...bench.ichimoku, cloudTop: 130 } }),
      vkospi: 34,
      marketForeignNet5d: -5,
    });
    expect(gate.status).toBe("RISK_OFF");
    expect(technicalScore(bench, 85).points).toBe(7);
    expect(actionLabel("A", gate.status)).toBe("시장 위험, 관망");
  });

  it("데이터 일부 없으면 판정 불완전", () => {
    const gate = evaluateMarketGate({ benchmark: bench, vkospi: null, marketForeignNet5d: null });
    expect(gate.incomplete).toBe(true);
  });
});

describe("V4 Priority Quality Score", () => {
  const inst: Instrument = {
    ...INSTRUMENTS[0]!,
    indexMemberships: ["KOSPI200", "KRX300"],
  };

  it("만점 8점 = 지수 2 + 외국인 2 + 신고가 2 + 규모 1 + 상대성과 1", () => {
    const block = priorityScore(inst, snapshot({ dayReturn: 0.05 }), undefined, 5e12, 0.02);
    expect(block.maxPoints).toBe(8);
    expect(block.points).toBe(8);
  });

  it("중복 지수 편입에도 +2점만 부여", () => {
    const block = priorityScore(inst, snapshot(), getFinancials("005930"), 5e12, 0.001);
    expect(block.rows[0]!.points).toBe(2);
  });

  it("외국인 수급은 20일 누적을 사용하고 60일은 사용하지 않는다", () => {
    const only20Negative = priorityScore(
      inst,
      snapshot({ foreignNet20d: -1e9, foreignNet60d: 5e9 }),
      undefined,
      5e12,
      0,
    );
    expect(only20Negative.rows[1]!.points).toBe(0);
    const only20Positive = priorityScore(
      inst,
      snapshot({ foreignNet20d: 1e9, foreignNet60d: -5e9 }),
      undefined,
      5e12,
      0,
    );
    expect(only20Positive.rows[1]!.points).toBe(2);
  });

  it("외국인 20일 데이터 없으면 산정 불가 처리", () => {
    const block = priorityScore(inst, snapshot({ foreignNet20d: null }), undefined, 5e12, 0);
    expect(block.rows[1]!.status).toBe("NO_DATA");
    expect(block.availableMaxPoints).toBeLessThan(block.maxPoints);
  });

  it("52주 신고가 근접은 -10% 이내에서 2점", () => {
    const near = priorityScore(inst, snapshot({ distanceFrom52wHigh: -9.9 }), undefined, 5e12, 0);
    expect(near.rows[2]!.points).toBe(2);
    const far = priorityScore(inst, snapshot({ distanceFrom52wHigh: -10.1 }), undefined, 5e12, 0);
    expect(far.rows[2]!.points).toBe(0);
  });

  it("밸류업 편입 여부는 점수를 바꾸지 않고 참고지표로만 남는다", () => {
    const withValueUp: Instrument = {
      ...inst,
      indexMemberships: [...inst.indexMemberships, "KOREA_VALUEUP"],
    };
    const a = priorityScore(inst, snapshot(), undefined, 5e12, 0.001);
    const b = priorityScore(withValueUp, snapshot(), undefined, 5e12, 0.001);
    expect(b.points).toBe(a.points);
    expect(b.maxPoints).toBe(a.maxPoints);
    const info = b.rows.find((r) => r.rule === "코리아 밸류업 지수 편입")!;
    expect(info.maxPoints).toBe(0);
    expect(info.group).toContain("점수 미반영");
  });

  it("당일 초과수익률은 종목 등락률이 아닌 벤치마크 차이로 계산", () => {
    const block = priorityScore(inst, snapshot({ dayReturn: 0.03 }), undefined, 5e12, 0.02);
    expect(block.rows[4]!.points).toBe(0); // 1%p 차이 → 미충족
    const block2 = priorityScore(inst, snapshot({ dayReturn: 0.05 }), undefined, 5e12, 0.02);
    expect(block2.rows[4]!.points).toBe(1);
  });
});

describe("V4 설정 버전 마이그레이션", () => {
  it("구버전 저장 설정은 V4 기본값으로 대체된다", () => {
    const v3 = {
      ...DEFAULT_SCORING_CONFIG,
      configVersion: 3,
      technical: { ...DEFAULT_SCORING_CONFIG.technical, momentumMax: 9 },
    };
    const merged = mergeScoringConfig(v3);
    expect(merged.configVersion).toBe(SCORING_CONFIG_VERSION);
    expect(merged.technical.cloudAboveMax).toBe(2);
    expect(merged.technical.momentumMax).toBe(1.5);
    expect(merged.priority.nearHighPoints).toBe(2);
    expect(merged.universe.minTradingValue).toBe(3_000_000_000);
    expect(merged.universe.excludeLeveragedInverse).toBe(true);
    expect(technicalMaxPoints(merged)).toBe(7);
    expect(priorityMaxPoints(merged)).toBe(8);
  });

  it("V4 사용자 수정값은 그대로 보존된다", () => {
    const custom = {
      ...DEFAULT_SCORING_CONFIG,
      technical: { ...DEFAULT_SCORING_CONFIG.technical, volumeStrongRatio: 180 },
    };
    const merged = mergeScoringConfig(custom);
    expect(merged.technical.volumeStrongRatio).toBe(180);
    expect(merged.configVersion).toBe(SCORING_CONFIG_VERSION);
  });
});

describe("Fundamental Score", () => {
  it("데이터 전체 부재 시 산정 가능 점수 0", () => {
    const block = fundamentalScore(undefined);
    expect(block.availableMaxPoints).toBe(0);
    expect(normalize(block)).toBeNull();
  });

  it("PBR 1배 미만은 자동 가점이 없다", () => {
    const facts = { ...(getFinancials("005930") as FinancialFacts), pbr: 0.7 };
    const block = fundamentalScore(facts);
    expect(block.rows.find((r) => r.rule.startsWith("PBR"))!.points).toBe(0);
  });
});

describe("총점", () => {
  it("데이터 없는 구성요소는 가중치에서 제외되고 완전성으로 표시", () => {
    const r = totalScore({
      technicalNormalized: 100,
      priorityNormalized: 50,
      qualityScore: null,
      marketSectorScore: 60,
      weights: STOCK_WEIGHTS,
    });
    expect(r.dataCompletenessRatio).toBeCloseTo(0.75);
    expect(r.total).toBeCloseTo((100 * 0.45 + 50 * 0.2 + 60 * 0.1) / 0.75);
  });
});

describe("포지션 사이징", () => {
  const base = {
    totalCapital: 100_000_000,
    riskPercent: 1,
    entryPrice: 10_000,
    atr14: 300,
    atrMultiple: 1.8,
    maxWeightPercent: 25,
    currentOpenRiskPercent: 0,
  };

  it("리스크 기준과 비중 제한 중 작은 값을 사용", () => {
    const r = calculatePositionSizing(base);
    expect(r.finalQuantity).toBe(Math.min(r.riskBasedQuantity, r.weightCappedQuantity));
    expect(r.weightPercent).toBeLessThanOrEqual(25);
  });

  it("ATR 0이면 오류를 반환", () => {
    const r = calculatePositionSizing({ ...base, atr14: 0 });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.finalQuantity).toBe(0);
  });

  it("리스크 한도 0이면 수량 0", () => {
    expect(calculatePositionSizing({ ...base, riskPercent: 0 }).finalQuantity).toBe(0);
  });

  it("오픈 리스크 6% 초과를 감지하되 계산은 계속한다", () => {
    const r = calculatePositionSizing({ ...base, currentOpenRiskPercent: 6 });
    expect(r.openRiskExceeded).toBe(true);
    expect(r.finalQuantity).toBeGreaterThan(0);
  });

  it("1R/2R/3R 가격", () => {
    const r = calculatePositionSizing(base);
    expect(r.r2 - base.entryPrice).toBeCloseTo(2 * r.riskPerShare);
  });
});

describe("결정론 및 미래 데이터 미사용", () => {
  it("동일 기준일·파라미터 재실행 시 같은 점수", () => {
    const a = runAnalysis(getMockDataset()).rows.map((r) => r.totalScoreNormalized.toFixed(6));
    const b = runAnalysis(getMockDataset()).rows.map((r) => r.totalScoreNormalized.toFixed(6));
    expect(a).toEqual(b);
  });

  it("지표는 기준일 이후 데이터를 사용하지 않는다", () => {
    const bars = getBars("005930");
    const cut = bars.length - 10;
    const full = computeIndicators(bars, cut);
    const truncated = computeIndicators(bars.slice(0, cut + 1), cut);
    expect(full.ma20).toBe(truncated.ma20);
    expect(full.ichimoku.cloudTop).toBe(truncated.ichimoku.cloudTop);
    expect(full.volumeRatio20).toBe(truncated.volumeRatio20);
  });

  it("주식과 ETF는 서로 다른 규칙으로 평가된다", () => {
    const analysis = runAnalysis(getMockDataset());
    const stock = analysis.rows.find((r) => r.instrument.instrumentType === "STOCK")!;
    const etf = analysis.rows.find((r) => r.instrument.instrumentType === "ETF")!;
    expect(stock.quality.rows.some((r) => r.group === "수익성")).toBe(true);
    expect(etf.quality.rows.some((r) => r.group === "추적 품질")).toBe(true);
  });
});