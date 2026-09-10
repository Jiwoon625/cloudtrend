import { atr } from "./indicators";
import { HISTORICAL_TECHNICAL_MAX } from "./scoring";
import type { ScoredSeries } from "./scoreDiagnostics";

export interface StrategySeries extends ScoredSeries {
  name?: string;
  nearHighs: Array<boolean | null>;
  extensions: Array<number | null>;
  regimes: Array<string>;
}

export const V6_ENTRY_THRESHOLDS = [70] as const;
export const V6_MAX_HOLDING_DAYS = [20, 30, 40, 50] as const;
export const V6_UPSIDE_EXIT_THRESHOLDS = [80, 90] as const;
export const V6_DOWNSIDE_EXIT_THRESHOLDS = [30] as const;
export const V6_FIXED_STOP_PCTS = [10, 20, 30, 40] as const;
export const V6_ATR_MULTIPLIERS = [2, 3, 4] as const;
export const V6_ATR_PERIOD = 14;
export const V6_POSITION_CAPS = [10, 20, 30] as const;

export interface StrategyScenario {
  id: string;
  label: string;
  entryThreshold: number;
  maxHoldingDays: number;
  upsideExitThreshold: number;
  downsideExitThreshold: number;
}

function scenarioId(
  entryThreshold: number,
  maxHoldingDays: number,
  upsideExitThreshold: number,
  downsideExitThreshold: number,
) {
  return `e${entryThreshold}-h${maxHoldingDays}-u${upsideExitThreshold}-d${downsideExitThreshold}`;
}

export const STRATEGY_SCENARIOS: StrategyScenario[] = V6_MAX_HOLDING_DAYS.flatMap((maxHoldingDays) =>
  V6_UPSIDE_EXIT_THRESHOLDS.map((upsideExitThreshold) => ({
    id: scenarioId(70, maxHoldingDays, upsideExitThreshold, 30),
    label: `70점 Onset · 최대 ${maxHoldingDays}D · ↑${upsideExitThreshold} / ↓30`,
    entryThreshold: 70,
    maxHoldingDays,
    upsideExitThreshold,
    downsideExitThreshold: 30,
  })),
);

export const CORE_STRATEGIES = STRATEGY_SCENARIOS.filter((s) => s.maxHoldingDays === 40);

export type V6ExitReason =
  | "TIME"
  | "UPSIDE_SCORE"
  | "DOWNSIDE_SCORE"
  | "PRICE_STOP"
  | "ATR_TRAIL";

export type ExitOverlay =
  | { kind: "NONE"; id: "none"; label: "추가 손절 없음" }
  | { kind: "FIXED_STOP"; id: string; label: string; stopPercent: number }
  | { kind: "ATR_TRAILING"; id: string; label: string; multiplier: number; period: number };

export const NO_EXIT_OVERLAY: ExitOverlay = {
  kind: "NONE",
  id: "none",
  label: "추가 손절 없음",
};
export const FIXED_STOP_OVERLAYS: ExitOverlay[] = V6_FIXED_STOP_PCTS.map((stopPercent) => ({
  kind: "FIXED_STOP" as const,
  id: `fixed-${stopPercent}`,
  label: `진입가 대비 -${stopPercent}%`,
  stopPercent,
}));
export const ATR_STOP_OVERLAYS: ExitOverlay[] = V6_ATR_MULTIPLIERS.map((multiplier) => ({
  kind: "ATR_TRAILING" as const,
  id: `atr-${multiplier}`,
  label: `ATR${V6_ATR_PERIOD} × ${multiplier} trailing`,
  multiplier,
  period: V6_ATR_PERIOD,
}));

export interface SimulatedTrade {
  symbol: string;
  name?: string;
  market: "KOSPI" | "KOSDAQ";
  signalDate: string;
  entryDate: string;
  exitDate: string;
  signalIndex: number;
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  ret: number;
  holdingDays: number;
  reason: V6ExitReason;
  exitTiming: "OPEN" | "CLOSE" | "STOP";
  signalScore: number;
  scoreRise5d: number | null;
  scoreRise10d: number | null;
  signalRegime: string;
  mae: number | null;
  mfe: number | null;
}

export function scorePercent(score: number | null | undefined): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  return (score / HISTORICAL_TECHNICAL_MAX) * 100;
}

function crossedUp(
  previousRaw: number | null | undefined,
  currentRaw: number | null | undefined,
  threshold: number,
) {
  const previous = scorePercent(previousRaw);
  const current = scorePercent(currentRaw);
  return previous !== null && current !== null && previous < threshold && current >= threshold;
}

function crossedDown(
  previousRaw: number | null | undefined,
  currentRaw: number | null | undefined,
  threshold: number,
) {
  const previous = scorePercent(previousRaw);
  const current = scorePercent(currentRaw);
  return previous !== null && current !== null && previous >= threshold && current < threshold;
}

function scoreRise(s: StrategySeries, i: number, lag: number): number | null {
  const current = scorePercent(s.scores[i]);
  const prior = scorePercent(s.scores[i - lag]);
  return current !== null && prior !== null ? current - prior : null;
}

/**
 * 진입은 70점 Onset이며, 기존 V6 결과와의 연속성을 위해 신호일 점수가 선택한 상승청산선보다
 * 이미 높으면 해당 시나리오에서는 진입하지 않는다. 따라서 ↑80/↑90 시나리오의 총 거래 수는
 * 동일하지 않을 수 있다. UI에서 이 차이를 별도로 설명한다.
 */
export function passesEntry(s: StrategySeries, i: number, scenario: StrategyScenario): boolean {
  if (!crossedUp(s.scores[i - 1], s.scores[i], scenario.entryThreshold)) return false;
  const current = scorePercent(s.scores[i]);
  return current !== null && current < scenario.upsideExitThreshold;
}

function stopFill(open: number, low: number, stop: number): number | null {
  if (!(stop > 0)) return null;
  if (open <= stop) return open;
  if (low <= stop) return stop;
  return null;
}

function excursion(
  s: StrategySeries,
  entryIndex: number,
  exitIndex: number,
  entryPrice: number,
  exitPrice: number,
  exitTiming: SimulatedTrade["exitTiming"],
): { mae: number | null; mfe: number | null } {
  let low = entryPrice;
  let high = entryPrice;
  for (let i = entryIndex; i <= exitIndex; i++) {
    const bar = s.bars[i];
    if (!bar) break;
    if (i === exitIndex && exitTiming !== "CLOSE") {
      low = Math.min(low, exitPrice);
      high = Math.max(high, exitPrice);
      continue;
    }
    if (Number.isFinite(bar.low) && bar.low > 0) low = Math.min(low, bar.low);
    if (Number.isFinite(bar.high) && bar.high > 0) high = Math.max(high, bar.high);
  }
  return {
    mae: entryPrice > 0 ? (low / entryPrice - 1) * 100 : null,
    mfe: entryPrice > 0 ? (high / entryPrice - 1) * 100 : null,
  };
}

function makeTrade(
  s: StrategySeries,
  signalIndex: number,
  entryIndex: number,
  exitIndex: number,
  entryPrice: number,
  exitPrice: number,
  reason: V6ExitReason,
  exitTiming: SimulatedTrade["exitTiming"],
  signalScore: number,
  costBps: number,
): SimulatedTrade {
  const ex = excursion(s, entryIndex, exitIndex, entryPrice, exitPrice, exitTiming);
  return {
    symbol: s.symbol,
    name: s.name,
    market: s.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI",
    signalDate: s.bars[signalIndex]!.tradeDate,
    entryDate: s.bars[entryIndex]!.tradeDate,
    exitDate: s.bars[exitIndex]!.tradeDate,
    signalIndex,
    entryIndex,
    exitIndex,
    entryPrice,
    exitPrice,
    ret: (exitPrice / entryPrice - 1) * 100 - Math.max(0, costBps) / 100,
    holdingDays: exitIndex - entryIndex + 1,
    reason,
    exitTiming,
    signalScore,
    scoreRise5d: scoreRise(s, signalIndex, 5),
    scoreRise10d: scoreRise(s, signalIndex, 10),
    signalRegime: s.regimes[signalIndex] ?? "UNKNOWN",
    mae: ex.mae,
    mfe: ex.mfe,
  };
}

export function simulateTrade(
  s: StrategySeries,
  signalIndex: number,
  scenario: StrategyScenario,
  costBps = 0,
  overlay: ExitOverlay = NO_EXIT_OVERLAY,
): SimulatedTrade | null {
  const entryIndex = signalIndex + 1;
  const plannedExit = signalIndex + scenario.maxHoldingDays;
  const entry = s.bars[entryIndex];
  if (!entry || !(entry.open > 0) || !Number.isFinite(entry.open)) return null;

  const signalScore = scorePercent(s.scores[signalIndex]);
  if (signalScore === null) return null;
  const lastAvailable = Math.min(plannedExit, s.bars.length - 1);
  const fixedStop =
    overlay.kind === "FIXED_STOP" ? entry.open * (1 - overlay.stopPercent / 100) : null;
  let trailHigh = entry.open;
  let trailStop: number | null = null;
  if (overlay.kind === "ATR_TRAILING") {
    const initialAtr = atr(s.bars, signalIndex, overlay.period);
    if (initialAtr !== null && initialAtr > 0)
      trailStop = entry.open - overlay.multiplier * initialAtr;
  }

  for (let j = entryIndex; j <= lastAvailable; j++) {
    const bar = s.bars[j]!;
    if (![bar.open, bar.close, bar.low, bar.high].every((v) => Number.isFinite(v) && v > 0))
      return null;

    if (j > entryIndex) {
      const scoreIndex = j - 1;
      if (
        crossedDown(
          s.scores[scoreIndex - 1],
          s.scores[scoreIndex],
          scenario.downsideExitThreshold,
        )
      ) {
        return makeTrade(
          s,
          signalIndex,
          entryIndex,
          j,
          entry.open,
          bar.open,
          "DOWNSIDE_SCORE",
          "OPEN",
          signalScore,
          costBps,
        );
      }
      if (
        crossedUp(
          s.scores[scoreIndex - 1],
          s.scores[scoreIndex],
          scenario.upsideExitThreshold,
        )
      ) {
        return makeTrade(
          s,
          signalIndex,
          entryIndex,
          j,
          entry.open,
          bar.open,
          "UPSIDE_SCORE",
          "OPEN",
          signalScore,
          costBps,
        );
      }
    }

    const stop =
      overlay.kind === "FIXED_STOP"
        ? fixedStop
        : overlay.kind === "ATR_TRAILING"
          ? trailStop
          : null;
    if (stop !== null) {
      const fill = stopFill(bar.open, bar.low, stop);
      if (fill !== null) {
        return makeTrade(
          s,
          signalIndex,
          entryIndex,
          j,
          entry.open,
          fill,
          overlay.kind === "FIXED_STOP" ? "PRICE_STOP" : "ATR_TRAIL",
          fill === bar.open ? "OPEN" : "STOP",
          signalScore,
          costBps,
        );
      }
    }

    if (j === plannedExit) {
      return makeTrade(
        s,
        signalIndex,
        entryIndex,
        j,
        entry.open,
        bar.close,
        "TIME",
        "CLOSE",
        signalScore,
        costBps,
      );
    }

    if (overlay.kind === "ATR_TRAILING") {
      trailHigh = Math.max(trailHigh, bar.high);
      const currentAtr = atr(s.bars, j, overlay.period);
      if (currentAtr !== null && currentAtr > 0) {
        const candidate = trailHigh - overlay.multiplier * currentAtr;
        trailStop = trailStop === null ? candidate : Math.max(trailStop, candidate);
      }
    }
  }
  return null;
}

type EntryFilter = (series: StrategySeries, signalIndex: number) => boolean;

export function simulateScenario(
  s: StrategySeries,
  scenario: StrategyScenario,
  costBps = 0,
  overlay: ExitOverlay = NO_EXIT_OVERLAY,
  entryFilter?: EntryFilter,
): SimulatedTrade[] {
  const trades: SimulatedTrade[] = [];
  let nextSignalIndex = 0;
  for (let i = 1; i + 1 < s.bars.length; i++) {
    if (i < nextSignalIndex || !passesEntry(s, i, scenario)) continue;
    if (entryFilter && !entryFilter(s, i)) continue;
    const trade = simulateTrade(s, i, scenario, costBps, overlay);
    if (trade) {
      trades.push(trade);
      nextSignalIndex = trade.exitIndex + 1;
    }
  }
  return trades;
}

export interface StrategyValidationRow {
  scenario: string;
  label: string;
  split: "ALL" | "OOS";
  market: "ALL" | "KOSPI" | "KOSDAQ";
  entryThreshold: number;
  maxHoldingDays: number;
  upsideExitThreshold: number;
  downsideExitThreshold: number;
  trades: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoff: number | null;
  profitFactor: number | null;
  averageHoldingDays: number | null;
  avgScoreRise5d: number | null;
  avgScoreRise10d: number | null;
  timeExitRate: number | null;
  upsideExitRate: number | null;
  downsideExitRate: number | null;
  priceStopRate: number | null;
  atrStopRate: number | null;
  worstReturn: number | null;
  avgMae: number | null;
  tailMaeP5: number | null;
  avgMfe: number | null;
  horizon: number;
  stopRate: number | null;
  scoreExitRate: number | null;
}

export interface SegmentPerformanceRow {
  strategy: string;
  strategyLabel: string;
  split: "ALL" | "OOS";
  segment: string;
  trades: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  avgLoss: number | null;
  worstReturn: number | null;
  payoff: number | null;
  profitFactor: number | null;
  averageHoldingDays: number | null;
  avgMae: number | null;
  tailMaeP5: number | null;
  portfolioReturn: number | null;
}

export interface PortfolioMetricRow {
  strategy: string;
  strategyLabel: string;
  split: "ALL" | "OOS";
  maxHoldingDays: number;
  upsideExitThreshold: number;
  overlayId: string;
  overlayLabel: string;
  trades: number;
  totalReturn: number | null;
  cagr: number | null;
  mdd: number | null;
  sharpe: number | null;
  activeDayRate: number | null;
  avgActivePositions: number | null;
  peakActivePositions: number;
  averageHoldingDays: number | null;
}

export interface RiskMetricRow {
  strategy: string;
  strategyLabel: string;
  split: "ALL" | "OOS";
  trades: number;
  avgLoss: number | null;
  worstReturn: number | null;
  avgMae: number | null;
  tailMaeP5: number | null;
  avgMfe: number | null;
  portfolioMdd: number | null;
}

export interface ExitOverlayComparisonRow extends StrategyValidationRow {
  overlayId: string;
  overlayLabel: string;
  portfolioCagr: number | null;
  portfolioMdd: number | null;
  portfolioSharpe: number | null;
}

export interface RegimeGateComparisonRow {
  strategy: string;
  strategyLabel: string;
  split: "ALL" | "OOS";
  gate: "ALL" | "NO_RISK_OFF";
  gateLabel: string;
  trades: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  cagr: number | null;
  mdd: number | null;
  sharpe: number | null;
  avgActivePositions: number | null;
}

export interface CrashStopTradeRow {
  strategy: string;
  strategyLabel: string;
  upsideExitThreshold: number;
  symbol: string;
  name?: string;
  market: "KOSPI" | "KOSDAQ";
  signalDate: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  stopPrice: number;
  exitPrice: number;
  stopReturn: number;
  baselineReturn: number | null;
  baselineExitDate: string | null;
  signalRegime: string;
  exitWasGap: boolean;
  exitOpenGapPct: number | null;
  maxAbsCloseMovePct: number | null;
  suspiciousPriceBreak: boolean;
  inOos: boolean;
}

export interface PositionCapComparisonRow {
  strategy: string;
  strategyLabel: string;
  split: "ALL" | "OOS";
  cap: number | null;
  capLabel: string;
  trades: number;
  skippedForCapacity: number;
  cagr: number | null;
  mdd: number | null;
  sharpe: number | null;
  totalReturn: number | null;
  activeDayRate: number | null;
  avgActivePositions: number | null;
  peakActivePositions: number;
}

export interface StrategyValidation {
  rows: StrategyValidationRow[];
  yearlyRows: SegmentPerformanceRow[];
  regimeRows: SegmentPerformanceRow[];
  riskRows: RiskMetricRow[];
  portfolioRows: PortfolioMetricRow[];
  fixedStopRows: ExitOverlayComparisonRow[];
  atrStopRows: ExitOverlayComparisonRow[];
  regimeGateRows: RegimeGateComparisonRow[];
  crashStopTrades: CrashStopTradeRow[];
  positionCapRows: PositionCapComparisonRow[];
  oosStart: string | null;
  roundTripCostBps: number;
  fixedWeights: readonly [number, number, number, number, number, number, number];
  assumptions: string[];
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const lo = Math.floor((sorted.length - 1) / 2);
  const hi = Math.ceil((sorted.length - 1) / 2);
  return (sorted[lo]! + sorted[hi]!) / 2;
}

function quantile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function reasonRate(group: SimulatedTrade[], reason: V6ExitReason): number | null {
  return group.length
    ? (group.filter((trade) => trade.reason === reason).length / group.length) * 100
    : null;
}

function summarizeTrades(
  group: SimulatedTrade[],
  meta: StrategyScenario,
  split: "ALL" | "OOS",
  market: "ALL" | "KOSPI" | "KOSDAQ",
): StrategyValidationRow {
  const returns = group.map((trade) => trade.ret);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  const winSum = wins.reduce((a, b) => a + b, 0);
  const lossSum = losses.reduce((a, b) => a + b, 0);
  const scoreRises5 = group
    .map((t) => t.scoreRise5d)
    .filter((v): v is number => v !== null);
  const scoreRises10 = group
    .map((t) => t.scoreRise10d)
    .filter((v): v is number => v !== null);
  const maes = group.map((t) => t.mae).filter((v): v is number => v !== null);
  const mfes = group.map((t) => t.mfe).filter((v): v is number => v !== null);
  const upsideExitRate = reasonRate(group, "UPSIDE_SCORE");
  const downsideExitRate = reasonRate(group, "DOWNSIDE_SCORE");
  const priceStopRate = reasonRate(group, "PRICE_STOP");
  const atrStopRate = reasonRate(group, "ATR_TRAIL");
  return {
    scenario: meta.id,
    label: meta.label,
    split,
    market,
    entryThreshold: meta.entryThreshold,
    maxHoldingDays: meta.maxHoldingDays,
    upsideExitThreshold: meta.upsideExitThreshold,
    downsideExitThreshold: meta.downsideExitThreshold,
    trades: group.length,
    avgReturn: mean(returns),
    medianReturn: median(returns),
    winRate: group.length ? (wins.length / group.length) * 100 : null,
    avgWin,
    avgLoss,
    payoff: avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null,
    profitFactor: lossSum < 0 ? winSum / -lossSum : null,
    averageHoldingDays: mean(group.map((trade) => trade.holdingDays)),
    avgScoreRise5d: mean(scoreRises5),
    avgScoreRise10d: mean(scoreRises10),
    timeExitRate: reasonRate(group, "TIME"),
    upsideExitRate,
    downsideExitRate,
    priceStopRate,
    atrStopRate,
    worstReturn: returns.length ? Math.min(...returns) : null,
    avgMae: mean(maes),
    tailMaeP5: quantile(maes, 0.05),
    avgMfe: mean(mfes),
    horizon: meta.maxHoldingDays,
    stopRate:
      priceStopRate !== null && atrStopRate !== null ? priceStopRate + atrStopRate : null,
    scoreExitRate:
      upsideExitRate !== null && downsideExitRate !== null
        ? upsideExitRate + downsideExitRate
        : null,
  };
}

function seriesKey(market: string, symbol: string) {
  return `${market}:${symbol}`;
}

interface DailyPortfolioRow {
  date: string;
  ret: number;
  active: number;
}

function portfolioDaily(
  trades: SimulatedTrade[],
  series: StrategySeries[],
  dates: string[],
  startDate: string | null,
  costBps: number,
): DailyPortfolioRow[] {
  const bySeries = new Map(
    series.map((s) => [seriesKey(s.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI", s.symbol), s]),
  );
  const contributions = new Map<string, number[]>();
  for (const trade of trades) {
    const s = bySeries.get(seriesKey(trade.market, trade.symbol));
    if (!s) continue;
    for (let i = trade.entryIndex; i <= trade.exitIndex; i++) {
      const bar = s.bars[i];
      if (!bar) break;
      const start = i === trade.entryIndex ? trade.entryPrice : s.bars[i - 1]?.close;
      const end = i === trade.exitIndex ? trade.exitPrice : bar.close;
      if (!(start && end && start > 0 && end > 0)) continue;
      let r = end / start - 1;
      if (i === trade.exitIndex && costBps > 0) r -= costBps / 10_000;
      const cur = contributions.get(bar.tradeDate);
      if (cur) cur.push(r);
      else contributions.set(bar.tradeDate, [r]);
    }
  }
  return dates
    .filter((date) => startDate === null || date >= startDate)
    .map((date) => {
      const xs = contributions.get(date) ?? [];
      return {
        date,
        ret: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0,
        active: xs.length,
      };
    });
}

function portfolioMetric(
  trades: SimulatedTrade[],
  series: StrategySeries[],
  dates: string[],
  startDate: string | null,
  costBps: number,
) {
  const daily = portfolioDaily(trades, series, dates, startDate, costBps);
  if (!daily.length) {
    return {
      trades: trades.length,
      totalReturn: null,
      cagr: null,
      mdd: null,
      sharpe: null,
      activeDayRate: null,
      avgActivePositions: null,
      peakActivePositions: 0,
      averageHoldingDays: mean(trades.map((t) => t.holdingDays)),
      daily,
    };
  }
  let equity = 1;
  let peak = 1;
  let mdd = 0;
  for (const row of daily) {
    equity *= 1 + row.ret;
    peak = Math.max(peak, equity);
    if (peak > 0) mdd = Math.min(mdd, equity / peak - 1);
  }
  const returns = daily.map((d) => d.ret);
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.length > 1
      ? returns.reduce((a, b) => a + (b - avg) ** 2, 0) / (returns.length - 1)
      : 0;
  const sd = Math.sqrt(Math.max(0, variance));
  const activeDays = daily.filter((d) => d.active > 0).length;
  return {
    trades: trades.length,
    totalReturn: (equity - 1) * 100,
    cagr: equity > 0 ? (equity ** (252 / daily.length) - 1) * 100 : null,
    mdd: mdd * 100,
    sharpe: sd > 0 ? (avg / sd) * Math.sqrt(252) : null,
    activeDayRate: (activeDays / daily.length) * 100,
    avgActivePositions: mean(daily.map((d) => d.active)),
    peakActivePositions: Math.max(...daily.map((d) => d.active), 0),
    averageHoldingDays: mean(trades.map((t) => t.holdingDays)),
    daily,
  };
}

function filterSplit(trades: SimulatedTrade[], split: "ALL" | "OOS", oosStart: string | null) {
  return split === "ALL"
    ? trades
    : trades.filter((t) => oosStart !== null && t.signalDate >= oosStart);
}

function segmentSummary(
  strategy: StrategyScenario,
  split: "ALL" | "OOS",
  segment: string,
  trades: SimulatedTrade[],
  portfolioReturn: number | null,
): SegmentPerformanceRow {
  const summary = summarizeTrades(trades, strategy, split, "ALL");
  return {
    strategy: strategy.id,
    strategyLabel: strategy.label,
    split,
    segment,
    trades: summary.trades,
    avgReturn: summary.avgReturn,
    medianReturn: summary.medianReturn,
    winRate: summary.winRate,
    avgLoss: summary.avgLoss,
    worstReturn: summary.worstReturn,
    payoff: summary.payoff,
    profitFactor: summary.profitFactor,
    averageHoldingDays: summary.averageHoldingDays,
    avgMae: summary.avgMae,
    tailMaeP5: summary.tailMaeP5,
    portfolioReturn,
  };
}

function maxAbsCloseMovePct(s: StrategySeries, fromIndex: number, toIndex: number): number | null {
  let maxMove: number | null = null;
  for (let i = Math.max(1, fromIndex); i <= toIndex; i++) {
    const prev = s.bars[i - 1]?.close;
    const current = s.bars[i]?.close;
    if (!(prev && current && prev > 0 && current > 0)) continue;
    const move = Math.abs(current / prev - 1) * 100;
    maxMove = maxMove === null ? move : Math.max(maxMove, move);
  }
  return maxMove;
}

interface CapacitySimulation {
  trades: SimulatedTrade[];
  skippedForCapacity: number;
}

function occupiesSlotAtOpen(trade: SimulatedTrade, date: string) {
  if (trade.exitDate > date) return true;
  if (trade.exitDate < date) return false;
  return trade.exitTiming !== "OPEN";
}

/**
 * 포트폴리오 동시보유 제한. 같은 진입일 후보가 슬롯보다 많으면
 * ① 신호점수, ② 최근 5D 점수상승, ③ 10D 점수상승, ④ 종목코드 순으로 선택한다.
 * 선택되지 않은 신호는 대기 주문으로 넘기지 않고 그 Onset은 소멸한 것으로 처리한다.
 */
function simulateWithPositionCap(
  series: StrategySeries[],
  scenario: StrategyScenario,
  costBps: number,
  cap: number,
): CapacitySimulation {
  const candidates: Array<{ s: StrategySeries; signalIndex: number; entryDate: string; score: number; rise5: number; rise10: number }> = [];
  for (const s of series) {
    for (let i = 1; i + 1 < s.bars.length; i++) {
      if (!passesEntry(s, i, scenario)) continue;
      const entryDate = s.bars[i + 1]?.tradeDate;
      const score = scorePercent(s.scores[i]);
      if (!entryDate || score === null) continue;
      candidates.push({
        s,
        signalIndex: i,
        entryDate,
        score,
        rise5: scoreRise(s, i, 5) ?? -Infinity,
        rise10: scoreRise(s, i, 10) ?? -Infinity,
      });
    }
  }
  candidates.sort(
    (a, b) =>
      a.entryDate.localeCompare(b.entryDate) ||
      b.score - a.score ||
      b.rise5 - a.rise5 ||
      b.rise10 - a.rise10 ||
      a.s.symbol.localeCompare(b.s.symbol),
  );

  const selected: SimulatedTrade[] = [];
  let skippedForCapacity = 0;
  let cursor = 0;
  while (cursor < candidates.length) {
    const date = candidates[cursor]!.entryDate;
    const day: typeof candidates = [];
    while (cursor < candidates.length && candidates[cursor]!.entryDate === date) {
      day.push(candidates[cursor]!);
      cursor++;
    }
    const active = selected.filter((t) => occupiesSlotAtOpen(t, date));
    const activeSymbols = new Set(active.map((t) => seriesKey(t.market, t.symbol)));
    let slots = Math.max(0, cap - active.length);
    for (const candidate of day) {
      const market = candidate.s.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI";
      const key = seriesKey(market, candidate.s.symbol);
      if (activeSymbols.has(key)) continue;
      if (slots <= 0) {
        skippedForCapacity++;
        continue;
      }
      const trade = simulateTrade(candidate.s, candidate.signalIndex, scenario, costBps);
      if (!trade) continue;
      selected.push(trade);
      activeSymbols.add(key);
      slots--;
    }
  }
  return { trades: selected, skippedForCapacity };
}

export function buildStrategyValidation(
  series: StrategySeries[],
  _horizons: number[],
  oosStart: string | null,
  costBps = 0,
): StrategyValidation {
  const rows: StrategyValidationRow[] = [];
  const yearlyRows: SegmentPerformanceRow[] = [];
  const regimeRows: SegmentPerformanceRow[] = [];
  const riskRows: RiskMetricRow[] = [];
  const portfolioRows: PortfolioMetricRow[] = [];
  const fixedStopRows: ExitOverlayComparisonRow[] = [];
  const atrStopRows: ExitOverlayComparisonRow[] = [];
  const regimeGateRows: RegimeGateComparisonRow[] = [];
  const crashStopTrades: CrashStopTradeRow[] = [];
  const positionCapRows: PositionCapComparisonRow[] = [];
  const normalizedCost = Math.max(0, costBps);
  const allDates = [...new Set(series.flatMap((s) => s.bars.map((b) => b.tradeDate)))].sort();

  const baseTrades = new Map<string, SimulatedTrade[]>();
  for (const scenario of STRATEGY_SCENARIOS) {
    const trades = series.flatMap((s) => simulateScenario(s, scenario, normalizedCost));
    baseTrades.set(scenario.id, trades);
    for (const split of ["ALL", "OOS"] as const) {
      for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
        const group = trades.filter(
          (trade) =>
            (split === "ALL" || (oosStart !== null && trade.signalDate >= oosStart)) &&
            (market === "ALL" || trade.market === market),
        );
        rows.push(summarizeTrades(group, scenario, split, market));
      }
    }
  }

  const commonStart =
    [...baseTrades.values()].flat().map((t) => t.entryDate).sort()[0] ?? null;

  for (const scenario of STRATEGY_SCENARIOS) {
    const all = baseTrades.get(scenario.id) ?? [];
    for (const split of ["ALL", "OOS"] as const) {
      const group = filterSplit(all, split, oosStart);
      const start = split === "OOS" ? oosStart : commonStart;
      const p = portfolioMetric(group, series, allDates, start, normalizedCost);
      portfolioRows.push({
        strategy: scenario.id,
        strategyLabel: scenario.label,
        split,
        maxHoldingDays: scenario.maxHoldingDays,
        upsideExitThreshold: scenario.upsideExitThreshold,
        overlayId: NO_EXIT_OVERLAY.id,
        overlayLabel: NO_EXIT_OVERLAY.label,
        trades: p.trades,
        totalReturn: p.totalReturn,
        cagr: p.cagr,
        mdd: p.mdd,
        sharpe: p.sharpe,
        activeDayRate: p.activeDayRate,
        avgActivePositions: p.avgActivePositions,
        peakActivePositions: p.peakActivePositions,
        averageHoldingDays: p.averageHoldingDays,
      });
    }
  }

  for (const strategy of CORE_STRATEGIES) {
    const all = baseTrades.get(strategy.id) ?? [];
    for (const split of ["ALL", "OOS"] as const) {
      const splitTrades = filterSplit(all, split, oosStart);
      const start = split === "OOS" ? oosStart : commonStart;
      const portfolio = portfolioMetric(splitTrades, series, allDates, start, normalizedCost);
      const summary = summarizeTrades(splitTrades, strategy, split, "ALL");
      riskRows.push({
        strategy: strategy.id,
        strategyLabel: strategy.label,
        split,
        trades: summary.trades,
        avgLoss: summary.avgLoss,
        worstReturn: summary.worstReturn,
        avgMae: summary.avgMae,
        tailMaeP5: summary.tailMaeP5,
        avgMfe: summary.avgMfe,
        portfolioMdd: portfolio.mdd,
      });

      const years = [...new Set(splitTrades.map((t) => t.signalDate.slice(0, 4)))].sort();
      for (const year of years) {
        const group = splitTrades.filter((t) => t.signalDate.startsWith(year));
        const yearDaily = portfolio.daily.filter((d) => d.date.startsWith(year));
        const yearReturn = yearDaily.length
          ? (yearDaily.reduce((eq, d) => eq * (1 + d.ret), 1) - 1) * 100
          : null;
        yearlyRows.push(segmentSummary(strategy, split, year, group, yearReturn));
      }

      for (const regime of ["RISK_ON", "NEUTRAL", "RISK_OFF", "UNKNOWN"]) {
        const group = splitTrades.filter((t) => t.signalRegime === regime);
        if (group.length) regimeRows.push(segmentSummary(strategy, split, regime, group, null));
      }
    }
  }

  const buildOverlayRows = (overlays: ExitOverlay[], target: ExitOverlayComparisonRow[]) => {
    for (const strategy of CORE_STRATEGIES) {
      for (const overlay of [NO_EXIT_OVERLAY, ...overlays]) {
        const trades =
          overlay.kind === "NONE"
            ? baseTrades.get(strategy.id) ?? []
            : series.flatMap((s) => simulateScenario(s, strategy, normalizedCost, overlay));
        for (const split of ["ALL", "OOS"] as const) {
          const group = filterSplit(trades, split, oosStart);
          const start = split === "OOS" ? oosStart : commonStart;
          const summary = summarizeTrades(group, strategy, split, "ALL");
          const p = portfolioMetric(group, series, allDates, start, normalizedCost);
          target.push({
            ...summary,
            overlayId: overlay.id,
            overlayLabel: overlay.label,
            portfolioCagr: p.cagr,
            portfolioMdd: p.mdd,
            portfolioSharpe: p.sharpe,
          });
        }
      }
    }
  };

  buildOverlayRows(FIXED_STOP_OVERLAYS, fixedStopRows);
  buildOverlayRows(ATR_STOP_OVERLAYS, atrStopRows);

  // ① RISK_OFF 신규진입 금지. 기존 보유 포지션의 청산규칙은 그대로 둔다.
  for (const strategy of CORE_STRATEGIES) {
    const variants = [
      {
        gate: "ALL" as const,
        gateLabel: "시장국면 제한 없음",
        trades: baseTrades.get(strategy.id) ?? [],
      },
      {
        gate: "NO_RISK_OFF" as const,
        gateLabel: "RISK_OFF 신규진입 금지",
        trades: series.flatMap((s) =>
          simulateScenario(
            s,
            strategy,
            normalizedCost,
            NO_EXIT_OVERLAY,
            (candidate, i) => candidate.regimes[i] !== "RISK_OFF",
          ),
        ),
      },
    ];
    for (const variant of variants) {
      for (const split of ["ALL", "OOS"] as const) {
        const group = filterSplit(variant.trades, split, oosStart);
        const start = split === "OOS" ? oosStart : commonStart;
        const summary = summarizeTrades(group, strategy, split, "ALL");
        const p = portfolioMetric(group, series, allDates, start, normalizedCost);
        regimeGateRows.push({
          strategy: strategy.id,
          strategyLabel: strategy.label,
          split,
          gate: variant.gate,
          gateLabel: variant.gateLabel,
          trades: group.length,
          avgReturn: summary.avgReturn,
          medianReturn: summary.medianReturn,
          winRate: summary.winRate,
          cagr: p.cagr,
          mdd: p.mdd,
          sharpe: p.sharpe,
          avgActivePositions: p.avgActivePositions,
        });
      }
    }
  }

  // ② -40% catastrophe stop 실제 체결 목록과 가격단절 진단.
  const fixed40 = FIXED_STOP_OVERLAYS.find(
    (o): o is Extract<ExitOverlay, { kind: "FIXED_STOP" }> =>
      o.kind === "FIXED_STOP" && o.stopPercent === 40,
  );
  if (fixed40) {
    for (const strategy of CORE_STRATEGIES) {
      for (const s of series) {
        const stopped = simulateScenario(s, strategy, normalizedCost, fixed40).filter(
          (t) => t.reason === "PRICE_STOP",
        );
        for (const trade of stopped) {
          const previousClose = s.bars[trade.exitIndex - 1]?.close;
          const exitOpen = s.bars[trade.exitIndex]?.open;
          const gapPct =
            previousClose && exitOpen && previousClose > 0 && exitOpen > 0
              ? (exitOpen / previousClose - 1) * 100
              : null;
          const maxMove = maxAbsCloseMovePct(s, trade.entryIndex, trade.exitIndex);
          const baseline = simulateTrade(
            s,
            trade.signalIndex,
            strategy,
            normalizedCost,
            NO_EXIT_OVERLAY,
          );
          crashStopTrades.push({
            strategy: strategy.id,
            strategyLabel: strategy.label,
            upsideExitThreshold: strategy.upsideExitThreshold,
            symbol: trade.symbol,
            name: trade.name,
            market: trade.market,
            signalDate: trade.signalDate,
            entryDate: trade.entryDate,
            exitDate: trade.exitDate,
            entryPrice: trade.entryPrice,
            stopPrice: trade.entryPrice * 0.6,
            exitPrice: trade.exitPrice,
            stopReturn: trade.ret,
            baselineReturn: baseline?.ret ?? null,
            baselineExitDate: baseline?.exitDate ?? null,
            signalRegime: trade.signalRegime,
            exitWasGap: trade.exitTiming === "OPEN" && trade.exitPrice < trade.entryPrice * 0.6,
            exitOpenGapPct: gapPct,
            maxAbsCloseMovePct: maxMove,
            suspiciousPriceBreak:
              (gapPct !== null && Math.abs(gapPct) >= 25) ||
              (maxMove !== null && maxMove >= 25),
            inOos: oosStart !== null && trade.signalDate >= oosStart,
          });
        }
      }
    }
  }

  // ③ 실전 동시보유 10/20/30종목 제한. 무제한 행도 기준선으로 함께 제공한다.
  for (const strategy of CORE_STRATEGIES) {
    const unlimited = baseTrades.get(strategy.id) ?? [];
    const variants: Array<{
      cap: number | null;
      capLabel: string;
      trades: SimulatedTrade[];
      skippedForCapacity: number;
    }> = [
      { cap: null, capLabel: "제한 없음", trades: unlimited, skippedForCapacity: 0 },
      ...V6_POSITION_CAPS.map((cap) => {
        const sim = simulateWithPositionCap(series, strategy, normalizedCost, cap);
        return {
          cap,
          capLabel: `최대 ${cap}종목`,
          trades: sim.trades,
          skippedForCapacity: sim.skippedForCapacity,
        };
      }),
    ];
    for (const variant of variants) {
      for (const split of ["ALL", "OOS"] as const) {
        const group = filterSplit(variant.trades, split, oosStart);
        const start = split === "OOS" ? oosStart : commonStart;
        const p = portfolioMetric(group, series, allDates, start, normalizedCost);
        positionCapRows.push({
          strategy: strategy.id,
          strategyLabel: strategy.label,
          split,
          cap: variant.cap,
          capLabel: variant.capLabel,
          trades: group.length,
          skippedForCapacity: variant.skippedForCapacity,
          cagr: p.cagr,
          mdd: p.mdd,
          sharpe: p.sharpe,
          totalReturn: p.totalReturn,
          activeDayRate: p.activeDayRate,
          avgActivePositions: p.avgActivePositions,
          peakActivePositions: p.peakActivePositions,
        });
      }
    }
  }

  return {
    rows,
    yearlyRows,
    regimeRows,
    riskRows,
    portfolioRows,
    fixedStopRows,
    atrStopRows,
    regimeGateRows,
    crashStopTrades,
    positionCapRows,
    oosStart,
    roundTripCostBps: normalizedCost,
    fixedWeights: [1, 1, 1.5, 1, 0.5, 2.5, 2],
    assumptions: [
      "진입: 70점 최초 상향 돌파를 종가에서 확인하고 다음 거래일 시가 체결",
      "↑80/↑90 비교는 기존 정의를 유지해 신호일 점수가 해당 상승청산선 이상이면 그 시나리오에서는 진입하지 않으므로 총 거래 수가 서로 다를 수 있음",
      "점수 청산: 상승 80/90 또는 하락 30 돌파/이탈을 종가에서 확인하고 다음 거래일 시가 체결",
      "가격 손절: 시가가 손절선 아래면 시가, 장중 저가가 손절선을 터치하면 손절선 가격 체결",
      "ATR trailing: Wilder ATR14, 직전 종가까지의 정보로 다음 세션 stop을 설정",
      "RISK_OFF 필터: 신규진입만 금지하고 기존 포지션은 원래 청산규칙을 유지",
      "동시보유 제한: 같은 날 후보가 넘치면 신호점수 → 5D 점수상승 → 10D 점수상승 → 종목코드 순으로 선택하며 탈락 신호는 다음 날로 이월하지 않음",
      "포트폴리오: 신호 보유 종목을 거래일별 동일가중, 신호가 없는 날은 현금(수익률 0), 무위험수익률 0 가정",
      "-40% 손절 거래의 가격단절 경고는 일중 갭 또는 일간 종가 변동이 25% 이상인 경우로, 데이터 오류를 확정하는 판정이 아니라 원자료 확인이 필요한 후보 표시",
    ],
  };
}
