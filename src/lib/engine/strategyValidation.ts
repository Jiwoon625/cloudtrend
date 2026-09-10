import { HISTORICAL_TECHNICAL_MAX } from "./scoring";
import type { ScoredSeries } from "./scoreDiagnostics";

export interface StrategySeries extends ScoredSeries {
  nearHighs: Array<boolean | null>;
  extensions: Array<number | null>;
  regimes: Array<string>;
}

export const V6_ENTRY_THRESHOLDS = [60, 70] as const;
export const V6_MAX_HOLDING_DAYS = [20, 30, 40, 50] as const;
export const V6_UPSIDE_EXIT_THRESHOLDS = [80, 90] as const;
export const V6_DOWNSIDE_EXIT_THRESHOLDS = [60, 50, 40, 30] as const;

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

export const STRATEGY_SCENARIOS: StrategyScenario[] = V6_ENTRY_THRESHOLDS.flatMap((entryThreshold) =>
  V6_MAX_HOLDING_DAYS.flatMap((maxHoldingDays) =>
    V6_UPSIDE_EXIT_THRESHOLDS.flatMap((upsideExitThreshold) =>
      V6_DOWNSIDE_EXIT_THRESHOLDS.map((downsideExitThreshold) => ({
        id: scenarioId(entryThreshold, maxHoldingDays, upsideExitThreshold, downsideExitThreshold),
        label: `${entryThreshold}점 Onset · 최대 ${maxHoldingDays}D · ↑${upsideExitThreshold} / ↓${downsideExitThreshold}`,
        entryThreshold,
        maxHoldingDays,
        upsideExitThreshold,
        downsideExitThreshold,
      })),
    ),
  ),
);

export type V6ExitReason = "TIME" | "UPSIDE_SCORE" | "DOWNSIDE_SCORE";

export interface SimulatedTrade {
  symbol: string;
  market: "KOSPI" | "KOSDAQ";
  signalDate: string;
  entryDate: string;
  exitDate: string;
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  ret: number;
  holdingDays: number;
  reason: V6ExitReason;
  exitTiming: "OPEN" | "CLOSE";
  signalScore: number;
  scoreRise5d: number | null;
  scoreRise10d: number | null;
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
 * V6 entry: first daily upward crossing of the selected 60/70 threshold.
 * If the signal close has already crossed the selected upside-exit threshold,
 * the strategy does not open a position that it would already have wanted to close.
 */
export function passesEntry(s: StrategySeries, i: number, scenario: StrategyScenario): boolean {
  if (!crossedUp(s.scores[i - 1], s.scores[i], scenario.entryThreshold)) return false;
  const current = scorePercent(s.scores[i]);
  return current !== null && current < scenario.upsideExitThreshold;
}

/**
 * Signal is known at t close and entry executes at t+1 open.
 * Score-based exits are also close-derived and therefore execute at the next open.
 * If no score exit occurs, the position is sold at the selected maximum holding day's close.
 */
export function simulateTrade(
  s: StrategySeries,
  signalIndex: number,
  scenario: StrategyScenario,
  costBps = 0,
): SimulatedTrade | null {
  const entryIndex = signalIndex + 1;
  const plannedExit = signalIndex + scenario.maxHoldingDays;
  const entry = s.bars[entryIndex];
  if (!entry || !(entry.open > 0) || !Number.isFinite(entry.open)) return null;

  const signalScore = scorePercent(s.scores[signalIndex]);
  if (signalScore === null) return null;
  const lastAvailable = Math.min(plannedExit, s.bars.length - 1);

  for (let j = entryIndex; j <= lastAvailable; j++) {
    const bar = s.bars[j]!;
    if (![bar.open, bar.close].every((v) => Number.isFinite(v) && v > 0)) return null;

    // A score seen at the previous close can only be acted on at this session's open.
    // Do not re-use the original entry signal as an immediate exit on the entry open.
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
  }

  // The dataset ended before the time exit and no earlier event was observed: censored trade.
  return null;
}

function makeTrade(
  s: StrategySeries,
  signalIndex: number,
  entryIndex: number,
  exitIndex: number,
  entryPrice: number,
  exitPrice: number,
  reason: V6ExitReason,
  exitTiming: "OPEN" | "CLOSE",
  signalScore: number,
  costBps: number,
): SimulatedTrade {
  return {
    symbol: s.symbol,
    market: s.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI",
    signalDate: s.bars[signalIndex]!.tradeDate,
    entryDate: s.bars[entryIndex]!.tradeDate,
    exitDate: s.bars[exitIndex]!.tradeDate,
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
  };
}

/** One open position per symbol; a new Onset can be traded after the prior position exits. */
export function simulateScenario(
  s: StrategySeries,
  scenario: StrategyScenario,
  costBps = 0,
): SimulatedTrade[] {
  const trades: SimulatedTrade[] = [];
  let nextSignalIndex = 0;
  for (let i = 1; i + 1 < s.bars.length; i++) {
    if (i < nextSignalIndex || !passesEntry(s, i, scenario)) continue;
    const trade = simulateTrade(s, i, scenario, costBps);
    if (trade) {
      trades.push(trade);
      // A fresh signal may occur after the exit session; never overlap positions in one symbol.
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
  /** Compatibility aliases for older result renderers. */
  horizon: number;
  stopRate: number | null;
  scoreExitRate: number | null;
}

export interface StrategyValidation {
  rows: StrategyValidationRow[];
  oosStart: string | null;
  roundTripCostBps: number;
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

function rate(group: SimulatedTrade[], reason: V6ExitReason): number | null {
  return group.length
    ? (group.filter((trade) => trade.reason === reason).length / group.length) * 100
    : null;
}

/**
 * Pre-compute every slash-option combination (2 x 4 x 2 x 4 = 64).
 * The V6 UI can switch entry/exit rules immediately without re-running the data engine.
 * The legacy horizons argument is retained because V5 diagnostics still share this call site.
 */
export function buildStrategyValidation(
  series: StrategySeries[],
  _horizons: number[],
  oosStart: string | null,
  costBps = 0,
): StrategyValidation {
  const rows: StrategyValidationRow[] = [];

  for (const scenario of STRATEGY_SCENARIOS) {
    const trades = series.flatMap((s) => simulateScenario(s, scenario, costBps));
    for (const split of ["ALL", "OOS"] as const) {
      for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
        const group = trades.filter(
          (trade) =>
            (split === "ALL" || (oosStart !== null && trade.signalDate >= oosStart)) &&
            (market === "ALL" || trade.market === market),
        );
        const returns = group.map((trade) => trade.ret);
        const wins = returns.filter((value) => value > 0);
        const losses = returns.filter((value) => value < 0);
        const avgWin = mean(wins);
        const avgLoss = mean(losses);
        const winSum = wins.reduce((a, b) => a + b, 0);
        const lossSum = losses.reduce((a, b) => a + b, 0);
        const scoreRises5 = group
          .map((trade) => trade.scoreRise5d)
          .filter((value): value is number => value !== null);
        const scoreRises10 = group
          .map((trade) => trade.scoreRise10d)
          .filter((value): value is number => value !== null);
        const upsideExitRate = rate(group, "UPSIDE_SCORE");
        const downsideExitRate = rate(group, "DOWNSIDE_SCORE");

        rows.push({
          scenario: scenario.id,
          label: scenario.label,
          split,
          market,
          entryThreshold: scenario.entryThreshold,
          maxHoldingDays: scenario.maxHoldingDays,
          upsideExitThreshold: scenario.upsideExitThreshold,
          downsideExitThreshold: scenario.downsideExitThreshold,
          trades: group.length,
          avgReturn: mean(returns),
          medianReturn: median(returns),
          winRate: group.length ? (wins.length / group.length) * 100 : null,
          avgWin,
          avgLoss,
          payoff: avgWin !== null && avgLoss !== null ? avgWin / -avgLoss : null,
          profitFactor: lossSum < 0 ? winSum / -lossSum : null,
          averageHoldingDays: mean(group.map((trade) => trade.holdingDays)),
          avgScoreRise5d: mean(scoreRises5),
          avgScoreRise10d: mean(scoreRises10),
          timeExitRate: rate(group, "TIME"),
          upsideExitRate,
          downsideExitRate,
          horizon: scenario.maxHoldingDays,
          stopRate: null,
          scoreExitRate:
            upsideExitRate !== null && downsideExitRate !== null
              ? upsideExitRate + downsideExitRate
              : null,
        });
      }
    }
  }

  return { rows, oosStart, roundTripCostBps: Math.max(0, costBps) };
}
