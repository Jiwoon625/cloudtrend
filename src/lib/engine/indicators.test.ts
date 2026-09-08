import { describe, expect, it } from "vitest";

import {
  atr,
  bollinger,
  bollingerState,
  computeIndicators,
  HIGH_52W_WINDOW,
  ichimoku,
  periodReturn,
  ratioToPriorAverage,
  sma,
} from "./indicators";
import type { DailyPrice } from "./types";

function bar(close: number, i = 0, high?: number, low?: number): DailyPrice {
  return {
    tradeDate: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    open: close,
    high: high ?? close + 1,
    low: low ?? close - 1,
    close,
    volume: 1000,
    tradingValue: close * 1000,
    marketCap: 1e12,
    foreignNetBuyValue: 0,
    institutionNetBuyValue: 0,
  };
}

describe("이동평균", () => {
  it("데이터가 정확히 20개일 때 MA20을 계산한다", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(sma(values, 20, 19)).toBe(10.5);
  });

  it("데이터가 19개면 계산 불가(null)", () => {
    const values = Array.from({ length: 19 }, (_, i) => i + 1);
    expect(sma(values, 20, 18)).toBeNull();
  });

  it("정배열 및 기울기 판정", () => {
    const up = Array.from({ length: 130 }, (_, i) => 100 + i);
    const ma20 = sma(up, 20, 129)!;
    const ma60 = sma(up, 60, 129)!;
    const ma120 = sma(up, 120, 129)!;
    expect(ma20 > ma60 && ma60 > ma120).toBe(true);
    expect(ma20 - sma(up, 20, 124)!).toBeGreaterThan(0);
  });
});

describe("52주 신고가", () => {
  it("252거래일이 모이기 전에는 52주 신고가를 계산하지 않는다", () => {
    const bars = Array.from({ length: HIGH_52W_WINDOW - 1 }, (_, i) => bar(100 + i * 0.1, i));
    const snap = computeIndicators(bars, bars.length - 1);
    expect(snap.high52w).toBeNull();
    expect(snap.distanceFrom52wHigh).toBeNull();
  });

  it("252거래일이 확보되면 정확히 252봉 범위의 최고가를 사용한다", () => {
    const bars = Array.from({ length: HIGH_52W_WINDOW + 1 }, (_, i) => bar(100, i, 101, 99));
    bars[0] = bar(100, 0, 999, 99); // 현재 252봉 창 밖의 극단값
    bars[1] = bar(100, 1, 150, 99); // 현재 252봉 창 안의 최고가
    const snap = computeIndicators(bars, HIGH_52W_WINDOW);
    expect(snap.high52w).toBe(150);
    expect(snap.distanceFrom52wHigh).toBeCloseTo((100 / 150 - 1) * 100);
  });
});

describe("볼린저밴드", () => {
  it("표준편차가 0이면 밴드폭 0", () => {
    const flat = Array.from({ length: 20 }, () => 100);
    const bb = bollinger(flat, 19)!;
    expect(bb.width).toBe(0);
    expect(bb.upper).toBe(100);
  });

  it("사전 스퀴즈 판정에 당일 데이터를 사용하지 않는다", () => {
    // 60봉 저변동 후 마지막 봉만 급등 → 스퀴즈(전일 기준) + 돌파 동시 성립
    const closes = Array.from({ length: 90 }, (_, i) => 100 + Math.sin(i) * 0.2);
    closes.push(130);
    const s = bollingerState(closes, closes.length - 1);
    expect(s.bbBreakout).toBe(true);
    expect(s.bbSqueezeAbsolute).toBe(true);
    expect(s.bbWidthExpanding).toBe(true);
  });

  it("돌파 후 밴드 내부 복귀는 Head Fake로 판정", () => {
    const closes = Array.from({ length: 90 }, () => 100);
    closes.push(120); // 전일 돌파
    closes.push(100); // 당일 복귀
    const s = bollingerState(closes, closes.length - 1);
    expect(s.headFakeWarning).toBe(true);
  });
});

describe("일목균형표", () => {
  const bars = Array.from({ length: 120 }, (_, i) => bar(100 + i, i));

  it("전환선·기준선은 최고가/최저가 중간값", () => {
    const ich = ichimoku(bars, 119);
    // 상승 일변량: 최근 9봉 고가 = 220, 저가 = 210
    expect(ich.tenkan).toBe((bars[119]!.high + bars[111]!.low) / 2);
    expect(ich.kijun).toBe((bars[119]!.high + bars[94]!.low) / 2);
  });

  it("표시 구름은 26봉 전 데이터로 산출한다 (off-by-one 방지)", () => {
    const ich = ichimoku(bars, 119);
    const src = ichimoku(bars, 119 - 26);
    expect(ich.cloudTop).toBe(Math.max(src.futureSenkouA!, src.futureSenkouB!));
  });

  it("현재 구름과 미래 구름을 구분한다", () => {
    const ich = ichimoku(bars, 119);
    expect(ich.cloudTop).not.toBe(Math.max(ich.futureSenkouA!, ich.futureSenkouB!));
    expect(ich.futureCloudBullish).toBe(true);
  });

  it("후행스팬 비교는 현재 종가 > 26거래일 전 종가", () => {
    const ich = ichimoku(bars, 119);
    expect(ich.chikouAbovePast26Close).toBe(bars[119]!.close > bars[93]!.close);
  });
});

describe("거래량", () => {
  const base = Array.from({ length: 20 }, () => 100);

  it("직전 20일 평균에서 당일을 제외한다", () => {
    const values = [...base, 200];
    expect(ratioToPriorAverage(values, 20, 20)).toBe(200);
  });

  it("당일 포함 옵션은 다른 값을 낸다", () => {
    const values = [...base, 200];
    expect(ratioToPriorAverage(values, 20, 20, true)).not.toBe(200);
  });

  it("200% / 130% 경계값", () => {
    expect(ratioToPriorAverage([...base, 200], 20, 20)).toBe(200);
    expect(ratioToPriorAverage([...base, 130], 20, 20)).toBe(130);
  });
});

describe("ATR", () => {
  it("데이터 부족 시 null", () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(100 + i, i));
    expect(atr(bars, 9, 14)).toBeNull();
  });

  it("Wilder 방식으로 양수 값을 산출", () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(100 + i, i));
    expect(atr(bars, 39, 14)!).toBeGreaterThan(0);
  });
});

describe("수익률", () => {
  it("기간 수익률", () => {
    const closes = [100, 0, 0, 0, 0, 110];
    expect(periodReturn(closes, 5, 5)).toBeCloseTo(0.1);
  });
  it("과거 데이터 없으면 null", () => {
    expect(periodReturn([100], 0, 20)).toBeNull();
  });
});
