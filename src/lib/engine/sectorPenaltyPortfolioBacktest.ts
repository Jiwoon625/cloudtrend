import type { MarketDataset } from "./dataset";
import type { DailyPrice } from "./types";
import {
  buildPortfolioCandidates,
  buildPortfolioSignalContext,
  PORTFOLIO_STRATEGIES,
  type PortfolioCandidateTrade,
  type PortfolioMarketCode,
  type PortfolioSeries,
  type PortfolioStrategyDefinition,
} from "./sectorPenaltyPortfolioSignals";

export const SECTOR_PENALTY_PORTFOLIO_VERSION = "CloudTrend V8 Sector Penalty Portfolio Backtest";

export type PortfolioMarket = "ALL" | PortfolioMarketCode;
export type PortfolioSplit = "ALL" | "OOS";
export type PositionWeightMode = "EQUAL_WEIGHT" | "MAX_20" | "MAX_10";
export type MarketRegime = "BULL" | "SIDEWAYS" | "BEAR" | "UNKNOWN";

export interface SectorPenaltyPortfolioBacktestOptions {
  limit?: number;
  initialCapital?: number;
  roundTripCostBps?: number[];
  maxPositions?: number[];
  weightModes?: PositionWeightMode[];
}

export interface PortfolioEquityPoint {
  date: string;
  equity: number;
  dailyReturn: number;
  cash: number;
  cashWeight: number;
  activePositions: number;
  drawdown: number;
}

interface AcceptedTrade extends PortfolioCandidateTrade {
  entryNotional: number;
  entryFee: number;
  exitGross: number;
  exitFee: number;
  netReturn: number;
}

interface Position {
  candidate: PortfolioCandidateTrade;
  shares: number;
  entryNotional: number;
  entryFee: number;
  lastMark: number;
}

interface SimulationResult {
  points: PortfolioEquityPoint[];
  trades: AcceptedTrade[];
  totalFees: number;
  buyNotional: number;
  sellNotional: number;
  candidateSignals: number;
  skippedForCapacity: number;
  skippedAlreadyHeld: number;
  skippedForCash: number;
}

export interface SectorPenaltyPortfolioMetricRow {
  rowKey: string;
  scenario: string;
  label: string;
  group: "A" | "B" | "C" | "D";
  split: PortfolioSplit;
  market: PortfolioMarket;
  priceLeadershipOverheatThreshold: number | null;
  entryThreshold: number;
  upsideExitThreshold: number;
  downsideExitThreshold: number;
  maxHoldingDays: number;
  roundTripCostBps: number;
  maxPositions: number;
  weightMode: PositionWeightMode;
  targetPositionWeight: number;
  initialCapital: number;
  finalEquity: number | null;
  totalReturn: number | null;
  cagr: number | null;
  annualizedVolatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  mdd: number | null;
  worstMonthlyReturn: number | null;
  trades: number;
  annualizedTrades: number | null;
  avgTradeReturn: number | null;
  medianTradeReturn: number | null;
  winRate: number | null;
  profitFactor: number | null;
  payoffRatio: number | null;
  worstTradeReturn: number | null;
  avgMae: number | null;
  avgMfe: number | null;
  averageHoldingDays: number | null;
  avgActivePositions: number | null;
  peakActivePositions: number;
  activeDayRate: number | null;
  avgCashWeight: number | null;
  annualizedTurnover: number | null;
  totalFees: number;
  costDragVsZero: number | null;
  candidateSignals: number;
  skippedForCapacity: number;
  skippedAlreadyHeld: number;
  skippedForCash: number;
  exposureUtilization: number | null;
}

export interface PeriodReturnRow { rowKey: string; period: string; return: number; }
export interface RegimeReturnRow { rowKey: string; regime: MarketRegime; dayCount: number; compoundedReturn: number | null; avgDailyReturn: number | null; }
export interface CurveBundle { rowKey: string; scenario: string; market: PortfolioMarket; split: PortfolioSplit; roundTripCostBps: number; maxPositions: number; weightMode: PositionWeightMode; points: PortfolioEquityPoint[]; }

export interface SectorPenaltyPortfolioBacktestResult {
  version: typeof SECTOR_PENALTY_PORTFOLIO_VERSION;
  metadata: { from: string; to: string; oosStart: string | null; symbolCount: number; sectorCount: number; scoreMax: 10; sectorSlotPoints: 0.5; sectorPenaltyPoints: 0.5; regimeDefinition: string; };
  scenarioDefinitions: PortfolioStrategyDefinition[];
  portfolioAssumptions: {
    initialCapital: number;
    entryExecution: "NEXT_OPEN";
    scoreExitExecution: "NEXT_OPEN";
    maxHoldingExitExecution: "SAME_DAY_CLOSE";
    cashAllowed: true;
    duplicateEntryAllowed: false;
    reentryRule: "NEW_ONSET_AFTER_EXIT_ONLY";
    wholeShareExecution: true;
    roundTripCostBps: number[];
    maxPositions: number[];
    weightModes: Array<{ id: PositionWeightMode; label: string; perPositionTarget: string }>;
    priority: string[];
    costConvention: string;
    turnoverConvention: string;
  };
  rows: SectorPenaltyPortfolioMetricRow[];
  bestRows: { byCagr: SectorPenaltyPortfolioMetricRow[]; bySharpe: SectorPenaltyPortfolioMetricRow[]; practicalAllMarket: SectorPenaltyPortfolioMetricRow[] };
  yearlyReturns: PeriodReturnRow[];
  monthlyReturns: PeriodReturnRow[];
  regimeReturns: RegimeReturnRow[];
  equityCurve: CurveBundle[];
  drawdownSeries: Array<{ rowKey: string; points: Array<{ date: string; drawdown: number }> }>;
  notes: string[];
}

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function median(xs: number[]) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2; }
function stdev(xs: number[]) { if (xs.length < 2) return null; const m = mean(xs)!; return Math.sqrt(Math.max(0, xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))); }
function compound(returns: number[]) { return returns.length ? (returns.reduce((eq, r) => eq * (1 + r), 1) - 1) * 100 : null; }
function targetWeight(mode: PositionWeightMode, maxPositions: number) { const equal = 1 / maxPositions; return mode === "MAX_20" ? Math.min(equal, 0.2) : mode === "MAX_10" ? Math.min(equal, 0.1) : equal; }
function rowKey(s: PortfolioStrategyDefinition, split: PortfolioSplit, market: PortfolioMarket, cost: number, maxPositions: number, mode: PositionWeightMode) { return [s.id, split, market, `c${cost}`, `p${maxPositions}`, mode].join("|"); }
function key(market: string, symbol: string) { return `${market}:${symbol}`; }

function candidatePriority(a: PortfolioCandidateTrade, b: PortfolioCandidateTrade, threshold: number | null) {
  if (b.adjustedScore10 !== a.adjustedScore10) return b.adjustedScore10 - a.adjustedScore10;
  const ar = a.scoreRise5d ?? -Infinity, br = b.scoreRise5d ?? -Infinity; if (br !== ar) return br - ar;
  if (threshold !== null) {
    const rank = (x: PortfolioCandidateTrade) => x.sectorOverheated === false ? 0 : x.sectorOverheated === null ? 1 : 2;
    const d = rank(a) - rank(b); if (d) return d;
  }
  if (b.signalTradingValue !== a.signalTradingValue) return b.signalTradingValue - a.signalTradingValue;
  return a.symbol.localeCompare(b.symbol);
}

function lookupSeries(series: PortfolioSeries[]) {
  return new Map(series.map((s) => [key(s.market, s.symbol), s]));
}

function markPrice(position: Position, date: string, timing: "OPEN" | "CLOSE", seriesMap: Map<string, PortfolioSeries>) {
  const s = seriesMap.get(key(position.candidate.market, position.candidate.symbol)); const i = s?.dateIndex.get(date); const bar = i === undefined ? undefined : s?.bars[i]; const price = timing === "OPEN" ? bar?.open : bar?.close; return finite(price) && price > 0 ? price : position.lastMark;
}

function simulatePortfolio(
  candidates: PortfolioCandidateTrade[],
  series: PortfolioSeries[],
  dates: string[],
  strategy: PortfolioStrategyDefinition,
  initialCapital: number,
  roundTripCostBps: number,
  maxPositions: number,
  weightMode: PositionWeightMode,
): SimulationResult {
  const seriesMap = lookupSeries(series), halfCost = Math.max(0, roundTripCostBps) / 20_000, weight = targetWeight(weightMode, maxPositions);
  const byEntry = new Map<string, PortfolioCandidateTrade[]>();
  for (const c of candidates) { const list = byEntry.get(c.entryDate) ?? []; list.push(c); byEntry.set(c.entryDate, list); }
  for (const list of byEntry.values()) list.sort((a, b) => candidatePriority(a, b, strategy.priceLeadershipOverheatThreshold));
  const positions = new Map<string, Position>(), accepted: AcceptedTrade[] = [], points: PortfolioEquityPoint[] = [];
  let cash = initialCapital, previousEquity = initialCapital, peak = initialCapital, totalFees = 0, buyNotional = 0, sellNotional = 0, skippedForCapacity = 0, skippedAlreadyHeld = 0, skippedForCash = 0;

  const closePosition = (positionKey: string, position: Position, price: number) => {
    const exitGross = position.shares * price, exitFee = exitGross * halfCost; cash += exitGross - exitFee; totalFees += exitFee; sellNotional += exitGross;
    const costBasis = position.entryNotional + position.entryFee; const netReturn = costBasis > 0 ? ((exitGross - exitFee) / costBasis - 1) * 100 : 0;
    accepted.push({ ...position.candidate, entryNotional: position.entryNotional, entryFee: position.entryFee, exitGross, exitFee, netReturn }); positions.delete(positionKey);
  };

  for (const date of dates) {
    for (const position of positions.values()) position.lastMark = markPrice(position, date, "OPEN", seriesMap);
    for (const [positionKey, position] of [...positions]) if (position.candidate.exitDate === date && position.candidate.exitTiming === "OPEN") closePosition(positionKey, position, position.candidate.exitPrice);
    const openMarked = [...positions.values()].reduce((sum, p) => sum + p.shares * p.lastMark, 0), openEquity = cash + openMarked;
    for (const candidate of byEntry.get(date) ?? []) {
      const positionKey = key(candidate.market, candidate.symbol);
      if (positions.has(positionKey)) { skippedAlreadyHeld++; continue; }
      if (positions.size >= maxPositions) { skippedForCapacity++; continue; }
      const targetNotional = openEquity * weight; const maxAffordable = cash / (1 + halfCost); const notionalBudget = Math.min(targetNotional, maxAffordable); const shares = Math.floor(notionalBudget / candidate.entryPrice);
      if (shares < 1) { skippedForCash++; continue; }
      const entryNotional = shares * candidate.entryPrice, entryFee = entryNotional * halfCost; if (entryNotional + entryFee > cash + 1e-6) { skippedForCash++; continue; }
      cash -= entryNotional + entryFee; totalFees += entryFee; buyNotional += entryNotional; positions.set(positionKey, { candidate, shares, entryNotional, entryFee, lastMark: candidate.entryPrice });
    }
    for (const position of positions.values()) position.lastMark = markPrice(position, date, "CLOSE", seriesMap);
    for (const [positionKey, position] of [...positions]) if (position.candidate.exitDate === date && position.candidate.exitTiming === "CLOSE") closePosition(positionKey, position, position.candidate.exitPrice);
    const marked = [...positions.values()].reduce((sum, p) => sum + p.shares * p.lastMark, 0), equity = cash + marked; peak = Math.max(peak, equity); const dailyReturn = previousEquity > 0 ? (equity / previousEquity - 1) * 100 : 0; const drawdown = peak > 0 ? (equity / peak - 1) * 100 : 0;
    points.push({ date, equity, dailyReturn, cash, cashWeight: equity > 0 ? cash / equity * 100 : 100, activePositions: positions.size, drawdown }); previousEquity = equity;
  }
  return { points, trades: accepted, totalFees, buyNotional, sellNotional, candidateSignals: candidates.length, skippedForCapacity, skippedAlreadyHeld, skippedForCash };
}

function periodReturns(points: PortfolioEquityPoint[], keyFn: (date: string) => string) {
  const groups = new Map<string, number[]>(); for (const point of points) { const k = keyFn(point.date), list = groups.get(k) ?? []; list.push(point.dailyReturn / 100); groups.set(k, list); }
  return [...groups].map(([period, rs]) => ({ period, return: compound(rs)! }));
}

function benchmarkRegimeMap(dataset: MarketDataset, market: PortfolioMarket) {
  const maps = new Map<string, number[]>(); const codes = market === "ALL" ? ["KOSPI", "KOSDAQ"] : [market];
  for (const code of codes) { const bars = dataset.indexSeries.find((s) => s.indexCode === code)?.bars ?? []; for (let i = 60; i < bars.length; i++) { const past = bars[i - 60]?.close, cur = bars[i]?.close; if (!finite(past) || !finite(cur) || past <= 0) continue; const list = maps.get(bars[i]!.tradeDate) ?? []; list.push(cur / past - 1); maps.set(bars[i]!.tradeDate, list); } }
  const out = new Map<string, MarketRegime>(); for (const [date, rs] of maps) { const r = mean(rs); out.set(date, r === null ? "UNKNOWN" : r >= 0.05 ? "BULL" : r <= -0.05 ? "BEAR" : "SIDEWAYS"); } return out;
}

function metricRow(strategy: PortfolioStrategyDefinition, split: PortfolioSplit, market: PortfolioMarket, cost: number, maxPositions: number, mode: PositionWeightMode, initialCapital: number, simulation: SimulationResult): SectorPenaltyPortfolioMetricRow {
  const points = simulation.points, trades = simulation.trades, daily = points.map((p) => p.dailyReturn / 100), finalEquity = points.at(-1)?.equity ?? initialCapital, totalReturn = (finalEquity / initialCapital - 1) * 100, years = points.length / 252, cagr = years > 0 && finalEquity > 0 ? ((finalEquity / initialCapital) ** (1 / years) - 1) * 100 : null;
  const avgDaily = mean(daily), sd = stdev(daily), downside = daily.filter((r) => r < 0), downsideDev = downside.length ? Math.sqrt(downside.reduce((a, r) => a + r ** 2, 0) / downside.length) : null;
  const rets = trades.map((t) => t.netReturn), wins = rets.filter((r) => r > 0), losses = rets.filter((r) => r < 0), avgWin = mean(wins), avgLoss = mean(losses), winSum = wins.reduce((a, b) => a + b, 0), lossSum = losses.reduce((a, b) => a + b, 0);
  const monthly = periodReturns(points, (d) => d.slice(0, 7)).map((x) => x.return), avgEquity = mean(points.map((p) => p.equity)), avgActive = mean(points.map((p) => p.activePositions));
  return {
    rowKey: rowKey(strategy, split, market, cost, maxPositions, mode), scenario: strategy.id, label: strategy.label, group: strategy.group, split, market, priceLeadershipOverheatThreshold: strategy.priceLeadershipOverheatThreshold, entryThreshold: strategy.entryThreshold, upsideExitThreshold: strategy.upsideExitThreshold, downsideExitThreshold: strategy.downsideExitThreshold, maxHoldingDays: strategy.maxHoldingDays, roundTripCostBps: cost, maxPositions, weightMode: mode, targetPositionWeight: targetWeight(mode, maxPositions) * 100, initialCapital, finalEquity, totalReturn, cagr,
    annualizedVolatility: sd === null ? null : sd * Math.sqrt(252) * 100, sharpe: sd && avgDaily !== null ? avgDaily / sd * Math.sqrt(252) : null, sortino: downsideDev && avgDaily !== null ? avgDaily / downsideDev * Math.sqrt(252) : null, mdd: points.length ? Math.min(...points.map((p) => p.drawdown)) : null, worstMonthlyReturn: monthly.length ? Math.min(...monthly) : null,
    trades: trades.length, annualizedTrades: years > 0 ? trades.length / years : null, avgTradeReturn: mean(rets), medianTradeReturn: median(rets), winRate: trades.length ? wins.length / trades.length * 100 : null, profitFactor: lossSum < 0 ? winSum / -lossSum : null, payoffRatio: avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null, worstTradeReturn: rets.length ? Math.min(...rets) : null, avgMae: mean(trades.map((t) => t.mae).filter(finite)), avgMfe: mean(trades.map((t) => t.mfe).filter(finite)), averageHoldingDays: mean(trades.map((t) => t.holdingDays)), avgActivePositions: avgActive, peakActivePositions: points.length ? Math.max(...points.map((p) => p.activePositions)) : 0, activeDayRate: points.length ? points.filter((p) => p.activePositions > 0).length / points.length * 100 : null, avgCashWeight: mean(points.map((p) => p.cashWeight)), annualizedTurnover: avgEquity && points.length ? ((simulation.buyNotional + simulation.sellNotional) / 2 / avgEquity) * (252 / points.length) * 100 : null, totalFees: simulation.totalFees, costDragVsZero: null, candidateSignals: simulation.candidateSignals, skippedForCapacity: simulation.skippedForCapacity, skippedAlreadyHeld: simulation.skippedAlreadyHeld, skippedForCash: simulation.skippedForCash, exposureUtilization: avgActive !== null ? Math.min(100, avgActive / maxPositions * 100) : null,
  };
}

function calendarFor(dataset: MarketDataset, market: PortfolioMarket) {
  const codes = market === "ALL" ? ["KOSPI", "KOSDAQ"] : [market], dates = new Set<string>(); for (const code of codes) for (const bar of dataset.indexSeries.find((s) => s.indexCode === code)?.bars ?? []) dates.add(bar.tradeDate); if (!dates.size) for (const bars of Object.values(dataset.bars)) for (const bar of bars) dates.add(bar.tradeDate); return [...dates].sort();
}

function selectBest(rows: SectorPenaltyPortfolioMetricRow[], metric: "cagr" | "sharpe", count = 10) { return rows.filter((r) => r.split === "ALL" && r.market === "ALL" && r.trades >= 20 && r[metric] !== null).sort((a, b) => (b[metric] ?? -Infinity) - (a[metric] ?? -Infinity)).slice(0, count); }
function practicalRows(rows: SectorPenaltyPortfolioMetricRow[]) { return rows.filter((r) => r.split === "ALL" && r.market === "ALL" && r.roundTripCostBps === 15 && r.maxPositions === 10 && r.weightMode === "MAX_10" && r.trades >= 20).sort((a, b) => { const as = (a.cagr ?? -100) + (a.sharpe ?? -10) * 10 + (a.profitFactor ?? 0) * 5 + (a.mdd ?? -100) * 0.2; const bs = (b.cagr ?? -100) + (b.sharpe ?? -10) * 10 + (b.profitFactor ?? 0) * 5 + (b.mdd ?? -100) * 0.2; return bs - as; }).slice(0, 10); }

function rerunForRow(row: SectorPenaltyPortfolioMetricRow, dataset: MarketDataset, series: PortfolioSeries[], candidates: PortfolioCandidateTrade[], strategy: PortfolioStrategyDefinition, oosStart: string | null) {
  const marketSeries = row.market === "ALL" ? series : series.filter((s) => s.market === row.market), marketCandidates = row.market === "ALL" ? candidates : candidates.filter((c) => c.market === row.market), calendar = calendarFor(dataset, row.market), start = row.split === "OOS" ? oosStart : null, dates = start ? calendar.filter((d) => d >= start) : calendar, filtered = start ? marketCandidates.filter((c) => c.signalDate >= start) : marketCandidates; return simulatePortfolio(filtered, marketSeries, dates, strategy, row.initialCapital, row.roundTripCostBps, row.maxPositions, row.weightMode);
}

export function runSectorPenaltyPortfolioBacktest(dataset: MarketDataset, options: SectorPenaltyPortfolioBacktestOptions = {}): SectorPenaltyPortfolioBacktestResult | null {
  const limit = Math.max(1, Math.round(options.limit ?? 613)), initialCapital = Math.max(1, options.initialCapital ?? 100_000_000), costs = [...new Set((options.roundTripCostBps ?? [0, 15, 30]).map((v) => Math.max(0, Math.round(v))))].sort((a, b) => a - b), positionLimits = [...new Set((options.maxPositions ?? [5, 10, 20]).map((v) => Math.max(1, Math.round(v))))].sort((a, b) => a - b), weightModes = options.weightModes ?? ["EQUAL_WEIGHT", "MAX_20", "MAX_10"];
  const context = buildPortfolioSignalContext(dataset, limit); if (!context.symbolCount) return null; const allDates = calendarFor(dataset, "ALL"), from = allDates[0] ?? "", to = allDates.at(-1) ?? "", oosStart = allDates[Math.max(0, Math.floor(allDates.length * 0.8))] ?? null;
  const rows: SectorPenaltyPortfolioMetricRow[] = [], yearlyReturns: PeriodReturnRow[] = [], monthlyReturns: PeriodReturnRow[] = [], regimeReturns: RegimeReturnRow[] = []; const candidateCache = new Map<string, PortfolioCandidateTrade[]>();
  for (const strategy of PORTFOLIO_STRATEGIES) {
    const series = context.seriesByThreshold.get(strategy.priceLeadershipOverheatThreshold) ?? [], candidates = buildPortfolioCandidates(series, strategy); candidateCache.set(strategy.id, candidates);
    for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
      const marketSeries = market === "ALL" ? series : series.filter((s) => s.market === market), marketCandidates = market === "ALL" ? candidates : candidates.filter((c) => c.market === market), calendar = calendarFor(dataset, market), regimeMap = benchmarkRegimeMap(dataset, market);
      for (const split of ["ALL", "OOS"] as const) {
        const start = split === "OOS" ? oosStart : null, dates = start ? calendar.filter((d) => d >= start) : calendar, splitCandidates = start ? marketCandidates.filter((c) => c.signalDate >= start) : marketCandidates;
        for (const cost of costs) for (const maxPositions of positionLimits) for (const mode of weightModes) {
          const simulation = simulatePortfolio(splitCandidates, marketSeries, dates, strategy, initialCapital, cost, maxPositions, mode), row = metricRow(strategy, split, market, cost, maxPositions, mode, initialCapital, simulation); rows.push(row);
          for (const x of periodReturns(simulation.points, (d) => d.slice(0, 4))) yearlyReturns.push({ rowKey: row.rowKey, ...x }); for (const x of periodReturns(simulation.points, (d) => d.slice(0, 7))) monthlyReturns.push({ rowKey: row.rowKey, ...x });
          for (const regime of ["BULL", "SIDEWAYS", "BEAR", "UNKNOWN"] as const) { const daily = simulation.points.filter((p) => (regimeMap.get(p.date) ?? "UNKNOWN") === regime).map((p) => p.dailyReturn / 100); regimeReturns.push({ rowKey: row.rowKey, regime, dayCount: daily.length, compoundedReturn: compound(daily), avgDailyReturn: daily.length ? mean(daily)! * 100 : null }); }
        }
      }
    }
  }
  const zeroMap = new Map(rows.filter((r) => r.roundTripCostBps === 0).map((r) => [[r.scenario, r.split, r.market, r.maxPositions, r.weightMode].join("|"), r.totalReturn])); for (const row of rows) { const zero = zeroMap.get([row.scenario, row.split, row.market, row.maxPositions, row.weightMode].join("|")); row.costDragVsZero = zero !== undefined && zero !== null && row.totalReturn !== null ? zero - row.totalReturn : null; }
  const byCagr = selectBest(rows, "cagr"), bySharpe = selectBest(rows, "sharpe"), practicalAllMarket = practicalRows(rows), requestedCurveRows = [...byCagr, ...bySharpe, ...practicalAllMarket, ...rows.filter((r) => r.scenario === "baseline-e75-u90-d30-h30" && r.split === "ALL" && r.market === "ALL" && r.roundTripCostBps === 15 && r.maxPositions === 10 && r.weightMode === "MAX_10")]; const curveKeys = new Set(requestedCurveRows.map((r) => r.rowKey));
  const equityCurve: CurveBundle[] = [], drawdownSeries: Array<{ rowKey: string; points: Array<{ date: string; drawdown: number }> }> = [];
  for (const curveKey of curveKeys) { const row = rows.find((r) => r.rowKey === curveKey); if (!row) continue; const strategy = PORTFOLIO_STRATEGIES.find((s) => s.id === row.scenario); if (!strategy) continue; const series = context.seriesByThreshold.get(strategy.priceLeadershipOverheatThreshold) ?? [], candidates = candidateCache.get(strategy.id) ?? [], simulation = rerunForRow(row, dataset, series, candidates, strategy, oosStart); equityCurve.push({ rowKey: row.rowKey, scenario: row.scenario, market: row.market, split: row.split, roundTripCostBps: row.roundTripCostBps, maxPositions: row.maxPositions, weightMode: row.weightMode, points: simulation.points }); drawdownSeries.push({ rowKey: row.rowKey, points: simulation.points.map((p) => ({ date: p.date, drawdown: p.drawdown })) }); }
  return {
    version: SECTOR_PENALTY_PORTFOLIO_VERSION,
    metadata: { from, to, oosStart, symbolCount: context.symbolCount, sectorCount: context.sectorCount, scoreMax: 10, sectorSlotPoints: 0.5, sectorPenaltyPoints: 0.5, regimeDefinition: "각 시장 벤치마크의 60거래일 수익률이 +5% 이상이면 BULL, -5% 이하이면 BEAR, 그 사이는 SIDEWAYS. ALL은 KOSPI/KOSDAQ 60일 수익률 평균." },
    scenarioDefinitions: PORTFOLIO_STRATEGIES,
    portfolioAssumptions: { initialCapital, entryExecution: "NEXT_OPEN", scoreExitExecution: "NEXT_OPEN", maxHoldingExitExecution: "SAME_DAY_CLOSE", cashAllowed: true, duplicateEntryAllowed: false, reentryRule: "NEW_ONSET_AFTER_EXIT_ONLY", wholeShareExecution: true, roundTripCostBps: costs, maxPositions: positionLimits, weightModes: [{ id: "EQUAL_WEIGHT", label: "동시보유 한도 기준 동일 슬롯 비중", perPositionTarget: "1 / maxPositions" }, { id: "MAX_20", label: "1종목 최대 20%", perPositionTarget: "min(1 / maxPositions, 20%)" }, { id: "MAX_10", label: "1종목 최대 10%", perPositionTarget: "min(1 / maxPositions, 10%)" }].filter((x) => weightModes.includes(x.id as PositionWeightMode)) as Array<{ id: PositionWeightMode; label: string; perPositionTarget: string }>, priority: ["adjustedScore10 내림차순", "scoreRise5d 내림차순", "해당 전략의 섹터 Price Leadership 과열 기준 미만 우선", "신호일 거래대금 내림차순"], costConvention: "입력 bps는 총 왕복비용이며 진입과 청산에 절반씩 적용한다.", turnoverConvention: "연환산 회전율 = (매수금액+매도금액)/2/평균자산 × 252/운용일수." },
    rows, bestRows: { byCagr, bySharpe, practicalAllMarket }, yearlyReturns, monthlyReturns, regimeReturns, equityCurve, drawdownSeries,
    notes: ["직전 V8 Fast와 같은 9.5점 기술점수 + 섹터 슬롯 0.5점 - 섹터 과열 페널티 0.5점 산식을 사용한다.", "후보는 모든 새 onset을 생성한 뒤 실제 보유 중인 종목만 중복 진입을 차단한다. 용량 부족으로 놓친 onset은 지연 진입하지 않고 이후 새 onset이 생겨야 다시 후보가 된다.", "점수 청산은 교차 확인 다음 거래일 시가, 최대보유 청산은 계획 만기일 종가다.", "진입 시 고정 슬롯 비중으로 정수 주식을 매수하고 자동 리밸런싱하지 않으며 미투자 현금을 허용한다.", "MAX_20은 테스트한 최대보유 5/10/20에서 동일 슬롯 비중과 같고, MAX_10은 최대 5종목 설정에서 추가 현금 버퍼를 만든다.", "OOS는 전체 거래일 마지막 20% 시작일부터 새 신호만 허용하고 현금 100%로 재시작한다.", "시장국면 성과는 독립 구간 백테스트가 아니라 해당 국면 일별 포트폴리오 수익률의 조건부 복리다."]
  };
}
