import type { ScoredSeries } from "./scoreDiagnostics";

export interface StrategySeries extends ScoredSeries {
  nearHighs: Array<boolean | null>;
  extensions: Array<number | null>;
  regimes: Array<string>;
}
export interface StrategyScenario {
  id: string;
  label: string;
  threshold: number;
  onset: boolean;
  nearHigh?: boolean;
  nearHighOnset?: boolean;
  riskOn?: boolean;
  extensionLimit?: number;
  stopPercent?: number;
  exitScore?: number;
}
export const STRATEGY_SCENARIOS: StrategyScenario[] = [
  { id: "state6", label: "6점+ 상태", threshold: 6, onset: false },
  { id: "onset6", label: "6점 신규 돌파", threshold: 6, onset: true },
  { id: "onset7", label: "7점 신규 돌파", threshold: 7, onset: true },
  { id: "onset8", label: "8점 신규 돌파", threshold: 8, onset: true },
  { id: "near", label: "6점 돌파 + 신고가 근접", threshold: 6, onset: true, nearHigh: true },
  {
    id: "nearOnset",
    label: "6점 돌파 + 신고가 근접 신규 충족",
    threshold: 6,
    onset: true,
    nearHigh: true,
    nearHighOnset: true,
  },
  { id: "risk", label: "6점 돌파 + RISK_ON", threshold: 6, onset: true, riskOn: true },
  { id: "extension", label: "6점 돌파 + 이격 <15%", threshold: 6, onset: true, extensionLimit: 15 },
  { id: "stop5", label: "6점 돌파 + −5% 손절", threshold: 6, onset: true, stopPercent: 5 },
  { id: "stop7", label: "6점 돌파 + −7% 손절", threshold: 6, onset: true, stopPercent: 7 },
  { id: "decay", label: "6점 돌파 + 4점 미만 청산", threshold: 6, onset: true, exitScore: 4 },
  {
    id: "filters",
    label: "6점 돌파 + 신고가·RISK_ON·이격",
    threshold: 6,
    onset: true,
    nearHigh: true,
    riskOn: true,
    extensionLimit: 15,
  },
  {
    id: "combined5",
    label: "모든 진입 필터 + −5%·4점 청산",
    threshold: 6,
    onset: true,
    nearHigh: true,
    riskOn: true,
    extensionLimit: 15,
    stopPercent: 5,
    exitScore: 4,
  },
  {
    id: "combined7",
    label: "모든 진입 필터 + −7%·4점 청산",
    threshold: 6,
    onset: true,
    nearHigh: true,
    riskOn: true,
    extensionLimit: 15,
    stopPercent: 7,
    exitScore: 4,
  },
];
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
  reason: "TIME" | "STOP" | "STOP_GAP" | "SCORE";
  exitTiming: "OPEN" | "CLOSE" | "INTRADAY";
}

export function passesEntry(s: StrategySeries, i: number, scenario: StrategyScenario): boolean {
  const score = s.scores[i];
  if (score === null || score === undefined || score < scenario.threshold) return false;
  const previous = s.scores[i - 1];
  if (
    scenario.onset &&
    (previous === null || previous === undefined || previous >= scenario.threshold)
  )
    return false;
  if (scenario.nearHigh && s.nearHighs[i] !== true) return false;
  if (scenario.nearHighOnset && s.nearHighs[i - 1] !== false) return false;
  if (scenario.riskOn && s.regimes[i] !== "RISK_ON") return false;
  if (
    scenario.extensionLimit !== undefined &&
    (s.extensions[i] === null ||
      s.extensions[i] === undefined ||
      s.extensions[i]! >= scenario.extensionLimit)
  )
    return false;
  return true;
}

/** Gap-aware daily-bar simulation. Close-derived score exits always execute at the next open. */
export function simulateTrade(
  s: StrategySeries,
  signalIndex: number,
  horizon: number,
  scenario: StrategyScenario,
  costBps = 0,
): SimulatedTrade | null {
  const entryIndex = signalIndex + 1,
    plannedExit = signalIndex + horizon;
  const entry = s.bars[entryIndex];
  if (!entry || !s.bars[plannedExit] || !(entry.open > 0) || !Number.isFinite(entry.open))
    return null;
  const stop =
    scenario.stopPercent === undefined ? null : entry.open * (1 - scenario.stopPercent / 100);
  for (let j = entryIndex; j <= plannedExit; j++) {
    const bar = s.bars[j]!;
    if (![bar.open, bar.close, bar.low, bar.high].every((v) => Number.isFinite(v) && v > 0))
      return null;
    let exitPrice: number | null = null;
    let reason: SimulatedTrade["reason"] = "TIME";
    let exitTiming: SimulatedTrade["exitTiming"] = "CLOSE";
    if (stop !== null && bar.open <= stop) {
      exitPrice = bar.open;
      reason = "STOP_GAP";
      exitTiming = "OPEN";
    } else if (
      j > entryIndex &&
      scenario.exitScore !== undefined &&
      s.scores[j - 1] !== null &&
      s.scores[j - 1] !== undefined &&
      s.scores[j - 1]! < scenario.exitScore
    ) {
      exitPrice = bar.open;
      reason = "SCORE";
      exitTiming = "OPEN";
    } else if (stop !== null && bar.low <= stop) {
      exitPrice = stop;
      reason = "STOP";
      exitTiming = "INTRADAY";
    } else if (j === plannedExit) exitPrice = bar.close;
    if (exitPrice !== null)
      return {
        symbol: s.symbol,
        market: s.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI",
        signalDate: s.bars[signalIndex]!.tradeDate,
        entryDate: entry.tradeDate,
        exitDate: bar.tradeDate,
        entryIndex,
        exitIndex: j,
        entryPrice: entry.open,
        exitPrice,
        holdingDays: j - entryIndex + 1,
        ret: (exitPrice / entry.open - 1) * 100 - costBps / 100,
        reason,
        exitTiming,
      };
  }
  return null;
}

export function simulateScenario(
  s: StrategySeries,
  horizon: number,
  scenario: StrategyScenario,
  costBps = 0,
): SimulatedTrade[] {
  const trades: SimulatedTrade[] = [];
  let nextSignal = 0;
  for (let i = 0; i + horizon < s.bars.length; i++) {
    if (i < nextSignal || !passesEntry(s, i, scenario)) continue;
    const trade = simulateTrade(s, i, horizon, scenario, costBps);
    if (trade) {
      trades.push(trade);
      nextSignal = trade.exitIndex;
    }
  }
  return trades;
}

export interface StrategyValidationRow {
  scenario: string;
  label: string;
  split: "ALL" | "OOS";
  market: "ALL" | "KOSPI" | "KOSDAQ";
  horizon: number;
  trades: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoff: number | null;
  profitFactor: number | null;
  averageHoldingDays: number | null;
  stopRate: number | null;
  scoreExitRate: number | null;
}
export interface StrategyValidation {
  rows: StrategyValidationRow[];
  oosStart: string | null;
  roundTripCostBps: number;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function buildStrategyValidation(
  series: StrategySeries[],
  horizons: number[],
  oosStart: string | null,
  costBps = 0,
): StrategyValidation {
  const rows: StrategyValidationRow[] = [];
  for (const scenario of STRATEGY_SCENARIOS)
    for (const horizon of horizons) {
      const trades = series.flatMap((s) => simulateScenario(s, horizon, scenario, costBps));
      for (const split of ["ALL", "OOS"] as const)
        for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
          const group = trades.filter(
            (t) =>
              (split === "ALL" || (oosStart !== null && t.signalDate >= oosStart)) &&
              (market === "ALL" || t.market === market),
          );
          const returns = group.map((t) => t.ret).sort((a, b) => a - b),
            wins = returns.filter((v) => v > 0),
            losses = returns.filter((v) => v < 0);
          const avgWin = mean(wins),
            avgLoss = mean(losses),
            lossSum = losses.reduce((a, b) => a + b, 0);
          rows.push({
            scenario: scenario.id,
            label: scenario.label,
            split,
            market,
            horizon,
            trades: group.length,
            avgReturn: mean(returns),
            medianReturn: returns.length
              ? (returns[Math.floor((returns.length - 1) / 2)]! +
                  returns[Math.ceil((returns.length - 1) / 2)]!) /
                2
              : null,
            winRate: group.length ? (wins.length / group.length) * 100 : null,
            avgWin,
            avgLoss,
            payoff: avgWin !== null && avgLoss !== null ? avgWin / -avgLoss : null,
            profitFactor: lossSum < 0 ? wins.reduce((a, b) => a + b, 0) / -lossSum : null,
            averageHoldingDays: mean(group.map((t) => t.holdingDays)),
            stopRate: group.length
              ? (group.filter((t) => t.reason === "STOP" || t.reason === "STOP_GAP").length /
                  group.length) *
                100
              : null,
            scoreExitRate: group.length
              ? (group.filter((t) => t.reason === "SCORE").length / group.length) * 100
              : null,
          });
        }
    }
  return { rows, oosStart, roundTripCostBps: costBps };
}
