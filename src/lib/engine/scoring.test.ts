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
  technicalGrade as scoreGrade,
  technicalScore as scoreTechnical,
  totalScore,
  STOCK_WEIGHTS,
  type ScoringConfig,
} from "./scoring";
import { getBars, getFinancials, getMockDataset, INSTRUMENTS } from "./mockProvider";
import { runAnalysis } from "./pipeline";
import { ETF_POLICY } from "./etfStrategy";
import type { FinancialFacts, Instrument } from "./types";

// Explicit historical fixture from 031a0b5. Pass it directly to the configurable
// helper; mergeScoringConfig deliberately migrates V4 saved settings to V8.
const HISTORICAL_V4_CONFIG: ScoringConfig = {
  ...DEFAULT_SCORING_CONFIG,
  configVersion: 4,
  weights: {
    ...DEFAULT_SCORING_CONFIG.weights,
    stock: { technical: 0.45, priority: 0.2, fundamental: 0.25, marketSector: 0.1 },
  },
  technical: {
    cloudAboveMax: 2,
    maAlignedMax: 2,
    momentumMax: 1.5,
    breakoutMax: 1,
    volumeMax: 0.5,
    volumeStrongRatio: 150,
    clvThreshold: 0.7,
  },
  priority: {
    indexPoints: 2,
    foreignPoints: 2,
    nearHighPoints: 2,
    sizePoints: 1,
    relativePoints: 1,
    nearHighThresholdPercent: -10,
    minMarketCap: 300_000_000_000,
    excessReturnThresholdPp: 2,
  },
  grade: { aMin: 6, bMin: 4 },
  universe: { ...DEFAULT_SCORING_CONFIG.universe, minTradingValue: 3_000_000_000 },
};

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

describe.each([
  {
    label: "historical V4 configurable helper",
    config: HISTORICAL_V4_CONFIG,
    cloud: 2,
    aligned: 2,
    momentum: 1.5,
    breakout: 1,
    total: 7,
    available: 5.5,
    aMin: 6,
    bMin: 4,
  },
  {
    label: "current Vf technical sub-score (not the V8 operating score)",
    config: DEFAULT_SCORING_CONFIG,
    cloud: 1,
    aligned: 1,
    momentum: 1,
    breakout: 1.5,
    total: 5,
    available: 3,
    aMin: 4,
    bMin: 3,
  },
])("$label", ({ config, cloud, aligned, momentum, breakout, total, available, aMin, bMin }) => {
  const technicalScore = (snap: IndicatorSnapshot, percentile: number | null) =>
    scoreTechnical(snap, percentile, config);
  const technicalGrade = (points: number) => scoreGrade(points, config);
  it("모든 조건 충족 시 해당 모델 만점, A등급", () => {
    const block = technicalScore(snapshot(), 85);
    expect(block.maxPoints).toBe(total);
    expect(block.points).toBe(total);
    expect(technicalGrade(block.points)).toBe("A");
  });

  it("일목 구름 상단 위는 전환선·후행스팬 없이 독립 배점", () => {
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
    expect(row.points).toBe(cloud);
    expect(row.status).toBe("PASS");
  });

  it("이동평균 정배열은 MA20 기울기를 요구하지 않고 독립 배점", () => {
    const block = technicalScore(snapshot({ ma20Slope: -3 }), 85);
    const row = block.rows.find((r) => r.rule.startsWith("이동평균 정배열"))!;
    expect(row.points).toBe(aligned);
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
    expect(points(true, -1, -0.1)).toBe(momentum);
    expect(points(true, 1, 0.1)).toBe(momentum);
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

  it("볼린저 스퀴즈 단독으로는 점수가 없고, 상단 돌파에만 배점", () => {
    const base = snapshot();
    const squeezeOnly = technicalScore(
      snapshot({ bollinger: { ...base.bollinger, bbBreakout: false } }),
      85,
    );
    const row = squeezeOnly.rows.find((r) => r.group === "Breakout")!;
    expect(row.points).toBe(0);
    expect(technicalScore(snapshot(), 85).rows.find((r) => r.group === "Breakout")!.points).toBe(
      breakout,
    );
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
    expect(block.availableMaxPoints).toBe(available);
    expect(block.rows.find((r) => r.group === "Volume")!.status).toBe("NO_DATA");
    expect(normalize(block)).toBeCloseTo((block.points / available) * 100);
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
    expect(technicalGrade(aMin)).toBe("A");
    expect(technicalGrade(aMin - 0.001)).toBe("B");
    expect(technicalGrade(bMin)).toBe("B");
    expect(technicalGrade(bMin - 0.001)).toBe("C");
  });
});

describe("시장 게이트 진단 및 현재 표시용 라벨", () => {
  // Entry vetoes are tested in kospiMarketGate/operationalStrategy; this helper is display-only.
  const bench = snapshot();
  it("4개 충족은 Risk-On, 점수를 변경하지 않는다", () => {
    const gate = evaluateMarketGate({ benchmark: bench, vkospi: 15, marketForeignNet5d: 1 });
    expect(gate.status).toBe("RISK_ON");
    const tech = scoreTechnical(bench, 85);
    expect(tech.points).toBe(5);
    expect(actionLabel("A", gate.status)).toBe("관심 후보");
  });

  it("Risk-Off는 표시용 점수·등급 라벨을 덮어쓰지 않는다", () => {
    const gate = evaluateMarketGate({
      benchmark: snapshot({ ma60: 120, ichimoku: { ...bench.ichimoku, cloudTop: 130 } }),
      vkospi: 34,
      marketForeignNet5d: -5,
    });
    expect(gate.status).toBe("RISK_OFF");
    expect(scoreTechnical(bench, 85).points).toBe(5);
    expect(actionLabel("A", gate.status)).toBe("관심 후보");
  });

  it("데이터 일부 없으면 판정 불완전", () => {
    const gate = evaluateMarketGate({ benchmark: bench, vkospi: null, marketForeignNet5d: null });
    expect(gate.incomplete).toBe(true);
  });
});

describe.each([
  { label: "historical V4 priority helper", config: HISTORICAL_V4_CONFIG, nearHigh: 2, total: 8 },
  {
    label: "current legacy priority helper (before V8 priority projection)",
    config: DEFAULT_SCORING_CONFIG,
    nearHigh: 2.5,
    total: 8.5,
  },
])("$label", ({ config, nearHigh, total }) => {
  const scorePriority = (...args: Parameters<typeof priorityScore>) =>
    priorityScore(args[0], args[1], args[2], args[3], args[4], config);
  const inst: Instrument = {
    ...INSTRUMENTS[0]!,
    indexMemberships: ["KOSPI200", "KRX300"],
  };

  it("만점은 지수·외국인·신고가·규모·상대성과 배점의 합", () => {
    const block = scorePriority(inst, snapshot({ dayReturn: 0.05 }), undefined, 5e12, 0.02);
    expect(block.maxPoints).toBe(total);
    expect(block.points).toBe(total);
  });

  it("중복 지수 편입에도 +2점만 부여", () => {
    const block = scorePriority(inst, snapshot(), getFinancials("005930"), 5e12, 0.001);
    expect(block.rows[0]!.points).toBe(2);
  });

  it("외국인 수급은 20일 누적을 사용하고 60일은 사용하지 않는다", () => {
    const only20Negative = scorePriority(
      inst,
      snapshot({ foreignNet20d: -1e9, foreignNet60d: 5e9 }),
      undefined,
      5e12,
      0,
    );
    expect(only20Negative.rows[1]!.points).toBe(0);
    const only20Positive = scorePriority(
      inst,
      snapshot({ foreignNet20d: 1e9, foreignNet60d: -5e9 }),
      undefined,
      5e12,
      0,
    );
    expect(only20Positive.rows[1]!.points).toBe(2);
  });

  it("외국인 20일 데이터 없으면 산정 불가 처리", () => {
    const block = scorePriority(inst, snapshot({ foreignNet20d: null }), undefined, 5e12, 0);
    expect(block.rows[1]!.status).toBe("NO_DATA");
    expect(block.availableMaxPoints).toBeLessThan(block.maxPoints);
  });

  it("52주 신고가 근접 배점은 -10% 경계까지 포함한다", () => {
    const near = scorePriority(inst, snapshot({ distanceFrom52wHigh: -9.9 }), undefined, 5e12, 0);
    expect(near.rows[2]!.points).toBe(nearHigh);
    const boundary = scorePriority(
      inst,
      snapshot({ distanceFrom52wHigh: -10 }),
      undefined,
      5e12,
      0,
    );
    expect(boundary.rows[2]!.points).toBe(nearHigh);
    const far = scorePriority(inst, snapshot({ distanceFrom52wHigh: -10.1 }), undefined, 5e12, 0);
    expect(far.rows[2]!.points).toBe(0);
  });

  it("밸류업 편입 여부는 점수를 바꾸지 않고 참고지표로만 남는다", () => {
    const withValueUp: Instrument = {
      ...inst,
      indexMemberships: [...inst.indexMemberships, "KOREA_VALUEUP"],
    };
    const a = scorePriority(inst, snapshot(), undefined, 5e12, 0.001);
    const b = scorePriority(withValueUp, snapshot(), undefined, 5e12, 0.001);
    expect(b.points).toBe(a.points);
    expect(b.maxPoints).toBe(a.maxPoints);
    const info = b.rows.find((r) => r.rule === "코리아 밸류업 지수 편입")!;
    expect(info.maxPoints).toBe(0);
    expect(info.group).toContain("점수 미반영");
  });

  it("당일 초과수익률은 종목 등락률이 아닌 벤치마크 차이로 계산", () => {
    const block = scorePriority(inst, snapshot({ dayReturn: 0.03 }), undefined, 5e12, 0.02);
    expect(block.rows[4]!.points).toBe(0); // 1%p 차이 → 미충족
    const block2 = scorePriority(inst, snapshot({ dayReturn: 0.05 }), undefined, 5e12, 0.02);
    expect(block2.rows[4]!.points).toBe(1);
  });
});

describe("V8 설정 버전 마이그레이션", () => {
  it.each([3, 4, 7])("버전 %s의 저장 설정은 현재 기본값으로 교체된다", (configVersion) => {
    const historical = {
      ...HISTORICAL_V4_CONFIG,
      configVersion,
      technical: { ...HISTORICAL_V4_CONFIG.technical, momentumMax: 9 },
    };
    const merged = mergeScoringConfig(historical);
    expect(merged).toEqual(DEFAULT_SCORING_CONFIG);
    expect(merged.configVersion).toBe(8);
    expect(merged.technical.cloudAboveMax).toBe(1);
    expect(merged.technical.momentumMax).toBe(1);
    expect(merged.priority.nearHighPoints).toBe(2.5);
    expect(merged.universe.minTradingValue).toBe(0);
    expect(merged.universe.excludeLeveragedInverse).toBe(true);
    expect(technicalMaxPoints(merged)).toBe(5);
    expect(priorityMaxPoints(merged)).toBe(8.5);
    expect(merged.technical).not.toBe(DEFAULT_SCORING_CONFIG.technical);
    expect(historical.technical.momentumMax).toBe(9);
  });

  it("현재 버전 사용자 수정값은 그대로 보존된다", () => {
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
  it("과거 V4 혼합 가중치는 명시적으로 전달할 때 결측 구성요소를 제외한다", () => {
    const r = totalScore({
      technicalNormalized: 100,
      priorityNormalized: 50,
      qualityScore: null,
      marketSectorScore: 60,
      weights: HISTORICAL_V4_CONFIG.weights.stock,
    });
    expect(r.dataCompletenessRatio).toBeCloseTo(0.75);
    expect(r.total).toBeCloseTo((100 * 0.45 + 50 * 0.2 + 60 * 0.1) / 0.75);
  });

  it("현재 주식 총점은 기술점수만 반영하고 보조점수로 결측을 채우지 않는다", () => {
    expect(STOCK_WEIGHTS).toEqual({ technical: 1, priority: 0, fundamental: 0, marketSector: 0 });
    expect(
      totalScore({
        technicalNormalized: 80,
        priorityNormalized: 100,
        qualityScore: null,
        marketSectorScore: 60,
        weights: STOCK_WEIGHTS,
      }),
    ).toEqual({ total: 80, dataCompletenessRatio: 1 });
    expect(
      totalScore({
        technicalNormalized: null,
        priorityNormalized: 100,
        qualityScore: 100,
        marketSectorScore: 100,
        weights: STOCK_WEIGHTS,
      }),
    ).toEqual({ total: 0, dataCompletenessRatio: 0 });
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
    expect(stock.technical.maxPoints).toBe(10);
    expect(stock.technical.rows.some((r) => r.group === "V8 Sector")).toBe(true);
    expect(stock.priority.maxPoints).toBe(5);
    expect(etf.etfStrategy?.version).toBe(ETF_POLICY.version);
    expect(etf.technical.maxPoints).toBe(100);
    expect(etf.technical.rows.map((r) => r.group)).toEqual(["ETF Technical"]);
    expect(etf.quality.rows.map((r) => r.group)).toEqual(["ETF Health"]);
    expect(etf.qualityScore).toBe(etf.etfStrategy?.health);
    expect(etf.totalScoreNormalized).toBe(etf.etfStrategy?.score ?? 0);
    expect(analysis.scoringConfig.weights.etf).toEqual({
      technical: 0.625,
      priority: 0.075,
      fundamental: 0.15,
      marketSector: 0.15,
    });
  });
});
