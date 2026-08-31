// 지표 계산: 전부 순수 함수. 데이터 부족 시 null(계산 불가)을 반환한다.
import type { DailyPrice } from "./types";

export function sma(values: number[], period: number, endIndex: number): number | null {
  if (endIndex < period - 1 || endIndex >= values.length) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += values[i]!;
  return sum / period;
}

export function stdev(values: number[], period: number, endIndex: number): number | null {
  const mean = sma(values, period, endIndex);
  if (mean === null) return null;
  let acc = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) acc += (values[i]! - mean) ** 2;
  return Math.sqrt(acc / period);
}

export interface Bollinger {
  middle: number;
  upper: number;
  lower: number;
  width: number; // %
}

export function bollinger(
  closes: number[],
  endIndex: number,
  period = 20,
  mult = 2,
): Bollinger | null {
  const middle = sma(closes, period, endIndex);
  const sd = stdev(closes, period, endIndex);
  if (middle === null || sd === null || middle === 0) return null;
  const upper = middle + mult * sd;
  const lower = middle - mult * sd;
  return { middle, upper, lower, width: ((upper - lower) / middle) * 100 };
}

export function trueRange(bar: DailyPrice, prevClose: number | null): number {
  const a = bar.high - bar.low;
  if (prevClose === null) return a;
  return Math.max(a, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

/** Wilder 방식 ATR (기본) 또는 SMA 방식 */
export function atr(
  bars: DailyPrice[],
  endIndex: number,
  period = 14,
  method: "wilder" | "sma" = "wilder",
): number | null {
  if (endIndex < period) return null;
  const trs: number[] = [];
  for (let i = 1; i <= endIndex; i++) trs.push(trueRange(bars[i]!, bars[i - 1]!.close));
  // trs[k] corresponds to bar index k+1
  const lastTrIndex = endIndex - 1;
  if (lastTrIndex < period - 1) return null;
  if (method === "sma") return sma(trs, period, lastTrIndex);
  let value = 0;
  for (let i = 0; i < period; i++) value += trs[i]!;
  value /= period;
  for (let i = period; i <= lastTrIndex; i++) value = (value * (period - 1) + trs[i]!) / period;
  return value;
}

export interface Ichimoku {
  tenkan: number | null;
  kijun: number | null;
  cloudTop: number | null; // 현재 시점에 표시되는 구름
  cloudBottom: number | null;
  futureSenkouA: number | null;
  futureSenkouB: number | null;
  futureCloudBullish: boolean | null;
  tenkanAboveKijun: boolean | null;
  tenkanKijunGoldenCrossToday: boolean | null;
  chikouAbovePast26Close: boolean | null; // 점수에 사용하는 정의
  chikouVsDisplayedCandle: boolean | null;
}

function midOfRange(bars: DailyPrice[], endIndex: number, period: number): number | null {
  if (endIndex < period - 1) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    hi = Math.max(hi, bars[i]!.high);
    lo = Math.min(lo, bars[i]!.low);
  }
  return (hi + lo) / 2;
}

export function ichimoku(
  bars: DailyPrice[],
  endIndex: number,
  p = { tenkan: 9, kijun: 26, senkouB: 52, shift: 26 },
): Ichimoku {
  const tenkan = midOfRange(bars, endIndex, p.tenkan);
  const kijun = midOfRange(bars, endIndex, p.kijun);
  const prevTenkan = endIndex > 0 ? midOfRange(bars, endIndex - 1, p.tenkan) : null;
  const prevKijun = endIndex > 0 ? midOfRange(bars, endIndex - 1, p.kijun) : null;

  // 오늘 화면에 표시되는 구름 = 26거래일 전에 산출된 선행스팬
  const srcIndex = endIndex - p.shift;
  let cloudTop: number | null = null;
  let cloudBottom: number | null = null;
  if (srcIndex >= 0) {
    const t = midOfRange(bars, srcIndex, p.tenkan);
    const k = midOfRange(bars, srcIndex, p.kijun);
    const b = midOfRange(bars, srcIndex, p.senkouB);
    if (t !== null && k !== null && b !== null) {
      const a = (t + k) / 2;
      cloudTop = Math.max(a, b);
      cloudBottom = Math.min(a, b);
    }
  }

  const futureSenkouA = tenkan !== null && kijun !== null ? (tenkan + kijun) / 2 : null;
  const futureSenkouB = midOfRange(bars, endIndex, p.senkouB);

  const close = bars[endIndex]?.close ?? null;
  const past = bars[endIndex - p.shift]?.close ?? null;

  return {
    tenkan,
    kijun,
    cloudTop,
    cloudBottom,
    futureSenkouA,
    futureSenkouB,
    futureCloudBullish:
      futureSenkouA !== null && futureSenkouB !== null ? futureSenkouA > futureSenkouB : null,
    tenkanAboveKijun: tenkan !== null && kijun !== null ? tenkan > kijun : null,
    tenkanKijunGoldenCrossToday:
      tenkan !== null && kijun !== null && prevTenkan !== null && prevKijun !== null
        ? prevTenkan <= prevKijun && tenkan > kijun
        : null,
    chikouAbovePast26Close: close !== null && past !== null ? close > past : null,
    chikouVsDisplayedCandle: close !== null && past !== null ? close > past : null,
  };
}

/** 당일 제외 직전 N거래일 평균 대비 비율(%) */
export function ratioToPriorAverage(
  values: number[],
  endIndex: number,
  period = 20,
  includeToday = false,
): number | null {
  const refEnd = includeToday ? endIndex : endIndex - 1;
  const avg = sma(values, period, refEnd);
  if (avg === null || avg === 0) return null;
  return (values[endIndex]! / avg) * 100;
}

export function periodReturn(closes: number[], endIndex: number, lookback: number): number | null {
  const past = closes[endIndex - lookback];
  if (past === undefined || past === 0) return null;
  return closes[endIndex]! / past - 1;
}

export function percentile(sortedAsc: number[], value: number): number {
  if (sortedAsc.length === 0) return 0;
  let below = 0;
  for (const v of sortedAsc) if (v < value) below++;
  return (below / sortedAsc.length) * 100;
}

export interface BollingerState {
  bb: Bollinger | null;
  bbBreakout: boolean | null;
  bbSqueezePrior: boolean | null; // 돌파 전일까지 밴드폭 하위 5%
  bbSqueezeAbsolute: boolean | null;
  bbWidthExpanding: boolean | null;
  bbWalk: boolean | null;
  headFakeWarning: boolean | null;
}

export function bollingerState(closes: number[], endIndex: number): BollingerState {
  const bb = bollinger(closes, endIndex);
  const prev = bollinger(closes, endIndex - 1);
  if (!bb) {
    return {
      bb: null,
      bbBreakout: null,
      bbSqueezePrior: null,
      bbSqueezeAbsolute: null,
      bbWidthExpanding: null,
      bbWalk: null,
      headFakeWarning: null,
    };
  }
  const widths: number[] = [];
  for (let i = endIndex - 60; i <= endIndex - 1; i++) {
    if (i < 0) continue;
    const b = bollinger(closes, i);
    if (b) widths.push(b.width);
  }
  const sorted = [...widths].sort((a, b) => a - b);
  const priorWidth = prev?.width ?? null;
  const squeezePrior =
    priorWidth !== null && sorted.length >= 20 ? percentile(sorted, priorWidth) <= 5 : null;

  let avg20 = null as number | null;
  const last20 = widths.slice(-20);
  if (last20.length === 20) avg20 = last20.reduce((a, b) => a + b, 0) / 20;

  const breakout = closes[endIndex]! > bb.upper;
  const expanding =
    priorWidth !== null && avg20 !== null ? bb.width > priorWidth && bb.width > avg20 : null;

  let walk: boolean | null = true;
  for (let i = endIndex - 2; i <= endIndex; i++) {
    const b = bollinger(closes, i);
    if (!b) {
      walk = null;
      break;
    }
    if (closes[i]! < b.upper) walk = false;
  }

  const prevBreakout = prev ? closes[endIndex - 1]! > prev.upper : null;
  const headFake =
    prevBreakout === null ? null : prevBreakout && !breakout && expanding !== true;

  return {
    bb,
    bbBreakout: breakout,
    bbSqueezePrior: squeezePrior,
    bbSqueezeAbsolute: priorWidth !== null ? priorWidth <= 5 : null,
    bbWidthExpanding: expanding,
    bbWalk: walk,
    headFakeWarning: headFake,
  };
}

export interface IndicatorSnapshot {
  tradeDate: string;
  close: number;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
  ma20Slope: number | null;
  maAligned: boolean | null;
  atr14: number | null;
  bollinger: BollingerState;
  ichimoku: Ichimoku;
  volumeRatio20: number | null;
  tradingValueRatio20: number | null;
  high52w: number | null;
  distanceFrom52wHigh: number | null;
  return20: number | null;
  return60: number | null;
  dayReturn: number | null;
  foreignNet5d: number | null;
  foreignNet20d: number | null;
  foreignNet60d: number | null;
  institutionNet20d: number | null;
  extensionFromMa20: number | null; // %
  atrExtension: number | null; // ATR 배수
}

function sumLast(values: number[], endIndex: number, n: number): number | null {
  if (endIndex - n + 1 < 0) return null;
  let s = 0;
  for (let i = endIndex - n + 1; i <= endIndex; i++) s += values[i]!;
  return s;
}

export function computeIndicators(bars: DailyPrice[], endIndex: number): IndicatorSnapshot {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const values = bars.map((b) => b.tradingValue);
  const foreign = bars.map((b) => b.foreignNetBuyValue);
  const inst = bars.map((b) => b.institutionNetBuyValue);

  const ma20 = sma(closes, 20, endIndex);
  const ma20Prev5 = sma(closes, 20, endIndex - 5);
  const ma60 = sma(closes, 60, endIndex);
  const ma120 = sma(closes, 120, endIndex);
  const atr14 = atr(bars, endIndex, 14);

  let high52w: number | null = null;
  const start = Math.max(0, endIndex - 251);
  if (endIndex - start >= 59) {
    high52w = -Infinity;
    for (let i = start; i <= endIndex; i++) high52w = Math.max(high52w, bars[i]!.high);
  }

  const close = closes[endIndex]!;
  const prevClose = closes[endIndex - 1] ?? null;

  return {
    tradeDate: bars[endIndex]!.tradeDate,
    close,
    ma20,
    ma60,
    ma120,
    ma20Slope: ma20 !== null && ma20Prev5 !== null ? ma20 - ma20Prev5 : null,
    maAligned: ma20 !== null && ma60 !== null && ma120 !== null ? ma20 > ma60 && ma60 > ma120 : null,
    atr14,
    bollinger: bollingerState(closes, endIndex),
    ichimoku: ichimoku(bars, endIndex),
    volumeRatio20: ratioToPriorAverage(volumes, endIndex, 20),
    tradingValueRatio20: ratioToPriorAverage(values, endIndex, 20),
    high52w,
    distanceFrom52wHigh: high52w !== null && high52w > 0 ? (close / high52w - 1) * 100 : null,
    return20: periodReturn(closes, endIndex, 20),
    return60: periodReturn(closes, endIndex, 60),
    dayReturn: prevClose !== null && prevClose !== 0 ? close / prevClose - 1 : null,
    foreignNet5d: sumLast(foreign, endIndex, 5),
    foreignNet20d: sumLast(foreign, endIndex, 20),
    foreignNet60d: sumLast(foreign, endIndex, 60),
    institutionNet20d: sumLast(inst, endIndex, 20),
    extensionFromMa20: ma20 !== null && ma20 !== 0 ? (close / ma20 - 1) * 100 : null,
    atrExtension: ma20 !== null && atr14 ? (close - ma20) / atr14 : null,
  };
}
