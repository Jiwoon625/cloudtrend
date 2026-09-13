import type { MarketDataset } from "./dataset";
import { adjustSectorPenaltyScore } from "./sectorScoreAdjustment";
import { buildPortfolioSignalContext, type PortfolioSeries } from "./sectorPenaltyPortfolioSignals";
import type { DailyPrice } from "./types";

export const V8_EXIT_HOLDING_VERSION = "CloudTrend V8 Exit Threshold and Holding Validation" as const;
export const V8_EXIT_HOLDING_PL_OVERHEAT_THRESHOLD = 80 as const;
export const V8_EXIT_UPSIDE_THRESHOLDS = [90, 95] as const;
export const V8_EXIT_DOWNSIDE_THRESHOLDS = [25, 30, 40] as const;
export const V8_EXIT_MAX_HOLDING_DAYS = [20, 30, 40, 60] as const;

export type V8ExitMarket = "KOSPI" | "KOSDAQ";
export type V8ExitSplit = "ALL" | "DEVELOPMENT" | "VALIDATION" | "OOS";
export type V8ExitMode = "TIME_ONLY" | "UPSIDE_ONLY" | "DOWNSIDE_ONLY" | "BOTH";
export type V8ExitReason = "TIME" | "UPSIDE_SCORE" | "DOWNSIDE_SCORE";
export type V8ExitTiming = "OPEN" | "CLOSE";

export interface V8ExitScenario {
  id: string;
  market: V8ExitMarket;
  entryThreshold: number;
  exitMode: V8ExitMode;
  upsideExitThreshold: number | null;
  downsideExitThreshold: number | null;
  maxHoldingDays: number;
}

export interface V8ExitHoldingOptions {
  limit?: number;
  warmupDays?: number;
  roundTripCostBps?: number;
  priceLeadershipOverheatThreshold?: number;
  marketEntryThresholds?: Partial<Record<V8ExitMarket, number[]>>;
  upsideExitThresholds?: number[];
  downsideExitThresholds?: number[];
  maxHoldingDays?: number[];
}

export interface V8ExitHoldingMetricRow {
  scope: "SPLIT" | "YEAR";
  split: V8ExitSplit | null;
  year: number | null;
  market: V8ExitMarket;
  scenarioId: string;
  entryThreshold: number;
  exitMode: V8ExitMode;
  upsideExitThreshold: number | null;
  downsideExitThreshold: number | null;
  maxHoldingDays: number;
  rawOnsets: number;
  acceptedTrades: number;
  skippedReentry: number;
  unresolvedOnsets: number;
  independentSignalRate: number | null;
  signalDates: number;
  avgSignalsPerDate: number | null;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  payoffRatio: number | null;
  profitFactor: number | null;
  avgExcessReturn: number | null;
  medianExcessReturn: number | null;
  excessWinRate: number | null;
  avgMae: number | null;
  avgMfe: number | null;
  avgHoldingDays: number | null;
  medianHoldingDays: number | null;
  timeExitRate: number | null;
  upsideExitRate: number | null;
  downsideExitRate: number | null;
  dailyAvgReturnHacMean: number | null;
  dailyAvgReturnHacT: number | null;
  dailyAvgReturnCiLow: number | null;
  dailyAvgReturnCiHigh: number | null;
  dailyAvgExcessHacMean: number | null;
  dailyAvgExcessHacT: number | null;
  dailyAvgExcessCiLow: number | null;
  dailyAvgExcessCiHigh: number | null;
}

export interface V8ExitHoldingResult {
  version: typeof V8_EXIT_HOLDING_VERSION;
  from: string;
  to: string;
  symbolCount: number;
  warmupDays: number;
  roundTripCostBps: number;
  priceLeadershipOverheatThreshold: number;
  marketEntryThresholds: Record<V8ExitMarket, number[]>;
  upsideExitThresholds: number[];
  downsideExitThresholds: number[];
  maxHoldingDays: number[];
  scenarios: V8ExitScenario[];
  splitPolicy: {
    method: "chronological-60-20-20";
    developmentFrom: string | null;
    validationFrom: string | null;
    oosFrom: string | null;
  };
  scorePolicy: {
    baseScoreMax: 9.5;
    sectorSlotPoints: 0.5;
    missingSectorPriceLeadership: "no-sector-slot";
    normalSectorPriceLeadership: "+0.5";
    overheatedSectorPriceLeadership: "no-net-sector-slot";
  };
  executionPolicy: {
    onset: "previous-score-below-entry-threshold-and-current-score-at-or-above-entry-threshold";
    entry: "NEXT_OPEN";
    scoreExit: "CROSSING_SIGNAL_NEXT_OPEN";
    timeExit: "MAX_HOLDING_DAY_CLOSE";
    reentry: "NEW_ONSET_AFTER_EXIT_ONLY";
  };
  rows: V8ExitHoldingMetricRow[];
  notes: string[];
}

interface PreparedSeries {
  source: PortfolioSeries;
  scores: Array<number | null>;
}

interface ExitTrade {
  signalIndex: number;
  entryIndex: number;
  exitIndex: number;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  exitTiming: V8ExitTiming;
  exitReason: V8ExitReason;
  entryPrice: number;
  exitPrice: number;
  holdingDays: number;
  ret: number;
  excess: number | null;
  mae: number | null;
  mfe: number | null;
}

interface DailyAcc { retSum: number; retN: number; excessSum: number; excessN: number; }
interface MetricAcc {
  rawOnsets: number;
  acceptedTrades: number;
  skippedReentry: number;
  unresolvedOnsets: number;
  dates: Set<string>;
  returns: number[];
  excessReturns: number[];
  holdings: number[];
  positive: number;
  winSum: number;
  winN: number;
  lossSum: number;
  lossN: number;
  profitSum: number;
  lossAbsSum: number;
  excessPositive: number;
  maeSum: number;
  maeN: number;
  mfeSum: number;
  mfeN: number;
  timeExits: number;
  upsideExits: number;
  downsideExits: number;
  daily: Map<string, DailyAcc>;
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)]! + sorted[Math.ceil(mid)]!) / 2;
}

function round(value: number | null, digits = 6) {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pct(score: number | null | undefined) { return finite(score) ? score * 10 : null; }

export function crossedUpPercentForTest(prev: number | null, cur: number | null, threshold: number) {
  const p = pct(prev), c = pct(cur);
  return p !== null && c !== null && p < threshold && c >= threshold;
}

export function crossedDownPercentForTest(prev: number | null, cur: number | null, threshold: number) {
  const p = pct(prev), c = pct(cur);
  return p !== null && c !== null && p >= threshold && c < threshold;
}

export function shouldBlockOnsetForTest(signalIndex: number, lastExitIndex: number, lastExitTiming: V8ExitTiming | null) {
  if (lastExitIndex < 0) return false;
  if (signalIndex < lastExitIndex) return true;
  return signalIndex === lastExitIndex && lastExitTiming === "CLOSE";
}

export function neweyWestMeanForExitTest(values: number[], lag: number) {
  const xs = values.filter(Number.isFinite);
  const n = xs.length;
  if (!n) return { mean: null, t: null, ciLow: null, ciHigh: null, n: 0 };
  const m = average(xs)!;
  if (n < 2) return { mean: m, t: null, ciLow: null, ciHigh: null, n };
  const centered = xs.map((value) => value - m);
  let lrv = centered.reduce((sum, value) => sum + value * value, 0) / n;
  const maxLag = Math.min(Math.max(0, Math.floor(lag)), n - 1);
  for (let l = 1; l <= maxLag; l++) {
    let gamma = 0;
    for (let t = l; t < n; t++) gamma += centered[t]! * centered[t - l]!;
    gamma /= n;
    lrv += 2 * (1 - l / (maxLag + 1)) * gamma;
  }
  const se = Math.sqrt(Math.max(0, lrv) / n);
  if (!(se > 0)) return { mean: m, t: null, ciLow: m, ciHigh: m, n };
  return { mean: m, t: m / se, ciLow: m - 1.96 * se, ciHigh: m + 1.96 * se, n };
}

function makeAcc(): MetricAcc {
  return {
    rawOnsets: 0, acceptedTrades: 0, skippedReentry: 0, unresolvedOnsets: 0,
    dates: new Set<string>(), returns: [], excessReturns: [], holdings: [], positive: 0,
    winSum: 0, winN: 0, lossSum: 0, lossN: 0, profitSum: 0, lossAbsSum: 0,
    excessPositive: 0, maeSum: 0, maeN: 0, mfeSum: 0, mfeN: 0,
    timeExits: 0, upsideExits: 0, downsideExits: 0, daily: new Map<string, DailyAcc>(),
  };
}

function addRaw(acc: MetricAcc, skipped: boolean, unresolved = false) {
  acc.rawOnsets++;
  if (skipped) acc.skippedReentry++;
  if (unresolved) acc.unresolvedOnsets++;
}

function addTrade(acc: MetricAcc, trade: ExitTrade) {
  acc.acceptedTrades++;
  acc.dates.add(trade.signalDate);
  acc.returns.push(trade.ret);
  acc.holdings.push(trade.holdingDays);
  acc.positive += trade.ret > 0 ? 1 : 0;
  if (trade.ret > 0) { acc.winSum += trade.ret; acc.winN++; acc.profitSum += trade.ret; }
  else if (trade.ret < 0) { acc.lossSum += trade.ret; acc.lossN++; acc.lossAbsSum += Math.abs(trade.ret); }
  if (finite(trade.excess)) {
    acc.excessReturns.push(trade.excess);
    acc.excessPositive += trade.excess > 0 ? 1 : 0;
  }
  if (finite(trade.mae)) { acc.maeSum += trade.mae; acc.maeN++; }
  if (finite(trade.mfe)) { acc.mfeSum += trade.mfe; acc.mfeN++; }
  if (trade.exitReason === "TIME") acc.timeExits++;
  else if (trade.exitReason === "UPSIDE_SCORE") acc.upsideExits++;
  else acc.downsideExits++;
  const daily = acc.daily.get(trade.signalDate) ?? { retSum: 0, retN: 0, excessSum: 0, excessN: 0 };
  daily.retSum += trade.ret; daily.retN++;
  if (finite(trade.excess)) { daily.excessSum += trade.excess; daily.excessN++; }
  acc.daily.set(trade.signalDate, daily);
}

function buildSplitPolicy(allDates: string[]) {
  const dates = [...new Set(allDates)].sort();
  if (!dates.length) return { developmentFrom: null, validationFrom: null, oosFrom: null };
  const validationIndex = Math.min(dates.length - 1, Math.floor(dates.length * 0.6));
  const oosIndex = Math.min(dates.length - 1, Math.floor(dates.length * 0.8));
  return {
    developmentFrom: dates[0] ?? null,
    validationFrom: dates[validationIndex] ?? null,
    oosFrom: dates[oosIndex] ?? null,
  };
}

function splitForDate(date: string, policy: { validationFrom: string | null; oosFrom: string | null }): Exclude<V8ExitSplit, "ALL"> {
  if (policy.oosFrom && date >= policy.oosFrom) return "OOS";
  if (policy.validationFrom && date >= policy.validationFrom) return "VALIDATION";
  return "DEVELOPMENT";
}

function benchmarkMaps(dataset: MarketDataset) {
  const out = new Map<V8ExitMarket, Map<string, DailyPrice>>();
  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    const series = dataset.indexSeries.find((item) => item.indexCode === market);
    out.set(market, new Map((series?.bars ?? []).map((bar) => [bar.tradeDate, bar])));
  }
  return out;
}

function benchmarkReturn(
  maps: Map<V8ExitMarket, Map<string, DailyPrice>>,
  market: V8ExitMarket,
  entryDate: string,
  exitDate: string,
  exitTiming: V8ExitTiming,
) {
  const entry = maps.get(market)?.get(entryDate);
  const exit = maps.get(market)?.get(exitDate);
  const exitPrice = exitTiming === "OPEN" ? exit?.open : exit?.close;
  if (!entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exitPrice) || exitPrice <= 0) return null;
  return (exitPrice / entry.open - 1) * 100;
}

function excursion(bars: DailyPrice[], entryIndex: number, exitIndex: number, entryPrice: number, exitPrice: number, timing: V8ExitTiming) {
  let low = entryPrice, high = entryPrice;
  for (let i = entryIndex; i <= exitIndex; i++) {
    const bar = bars[i]; if (!bar) break;
    if (i === exitIndex && timing === "OPEN") {
      low = Math.min(low, exitPrice); high = Math.max(high, exitPrice); continue;
    }
    if (finite(bar.low) && bar.low > 0) low = Math.min(low, bar.low);
    if (finite(bar.high) && bar.high > 0) high = Math.max(high, bar.high);
  }
  return {
    mae: entryPrice > 0 ? (low / entryPrice - 1) * 100 : null,
    mfe: entryPrice > 0 ? (high / entryPrice - 1) * 100 : null,
  };
}

function simulateExit(
  prepared: PreparedSeries,
  signalIndex: number,
  scenario: V8ExitScenario,
  benchmarks: Map<V8ExitMarket, Map<string, DailyPrice>>,
  roundTripCostBps: number,
): ExitTrade | null {
  const bars = prepared.source.bars;
  const entryIndex = signalIndex + 1;
  const plannedExit = signalIndex + scenario.maxHoldingDays;
  const entry = bars[entryIndex];
  if (!entry || plannedExit >= bars.length || !finite(entry.open) || entry.open <= 0) return null;
  let exitIndex = -1;
  let exitPrice = 0;
  let exitReason: V8ExitReason = "TIME";
  let exitTiming: V8ExitTiming = "CLOSE";
  for (let j = entryIndex; j <= plannedExit; j++) {
    const bar = bars[j];
    if (!bar || ![bar.open, bar.close, bar.low, bar.high].every((value) => finite(value) && value > 0)) return null;
    if (j > entryIndex) {
      const scoreIndex = j - 1;
      const prev = prepared.scores[scoreIndex - 1] ?? null;
      const cur = prepared.scores[scoreIndex] ?? null;
      if (scenario.downsideExitThreshold !== null && crossedDownPercentForTest(prev, cur, scenario.downsideExitThreshold)) {
        exitIndex = j; exitPrice = bar.open; exitReason = "DOWNSIDE_SCORE"; exitTiming = "OPEN"; break;
      }
      if (scenario.upsideExitThreshold !== null && crossedUpPercentForTest(prev, cur, scenario.upsideExitThreshold)) {
        exitIndex = j; exitPrice = bar.open; exitReason = "UPSIDE_SCORE"; exitTiming = "OPEN"; break;
      }
    }
    if (j === plannedExit) { exitIndex = j; exitPrice = bar.close; }
  }
  if (exitIndex < 0 || exitPrice <= 0) return null;
  const ex = excursion(bars, entryIndex, exitIndex, entry.open, exitPrice, exitTiming);
  const gross = (exitPrice / entry.open - 1) * 100;
  const ret = gross - roundTripCostBps / 100;
  const bench = benchmarkReturn(benchmarks, scenario.market, entry.tradeDate, bars[exitIndex]!.tradeDate, exitTiming);
  return {
    signalIndex, entryIndex, exitIndex,
    signalDate: bars[signalIndex]!.tradeDate,
    entryDate: entry.tradeDate,
    exitDate: bars[exitIndex]!.tradeDate,
    exitTiming, exitReason,
    entryPrice: entry.open, exitPrice,
    holdingDays: exitIndex - entryIndex + 1,
    ret,
    excess: finite(bench) ? ret - bench : null,
    mae: ex.mae, mfe: ex.mfe,
  };
}

function scenarioId(market: V8ExitMarket, entry: number, mode: V8ExitMode, up: number | null, down: number | null, hold: number) {
  return `${market.toLowerCase()}-e${entry}-${mode.toLowerCase()}-u${up ?? "x"}-d${down ?? "x"}-h${hold}`;
}

function makeScenarios(
  market: V8ExitMarket,
  entries: number[],
  ups: number[],
  downs: number[],
  holds: number[],
): V8ExitScenario[] {
  const out: V8ExitScenario[] = [];
  for (const entry of entries) for (const hold of holds) {
    out.push({ id: scenarioId(market, entry, "TIME_ONLY", null, null, hold), market, entryThreshold: entry, exitMode: "TIME_ONLY", upsideExitThreshold: null, downsideExitThreshold: null, maxHoldingDays: hold });
    for (const up of ups) out.push({ id: scenarioId(market, entry, "UPSIDE_ONLY", up, null, hold), market, entryThreshold: entry, exitMode: "UPSIDE_ONLY", upsideExitThreshold: up, downsideExitThreshold: null, maxHoldingDays: hold });
    for (const down of downs) out.push({ id: scenarioId(market, entry, "DOWNSIDE_ONLY", null, down, hold), market, entryThreshold: entry, exitMode: "DOWNSIDE_ONLY", upsideExitThreshold: null, downsideExitThreshold: down, maxHoldingDays: hold });
    for (const up of ups) for (const down of downs) out.push({ id: scenarioId(market, entry, "BOTH", up, down, hold), market, entryThreshold: entry, exitMode: "BOTH", upsideExitThreshold: up, downsideExitThreshold: down, maxHoldingDays: hold });
  }
  return out;
}

function finalize(
  meta: { scope: "SPLIT" | "YEAR"; split: V8ExitSplit | null; year: number | null; scenario: V8ExitScenario },
  acc: MetricAcc,
): V8ExitHoldingMetricRow {
  const returns = acc.returns;
  const excess = acc.excessReturns;
  const dailyReturnMeans = [...acc.daily.values()].filter((d) => d.retN > 0).map((d) => d.retSum / d.retN);
  const dailyExcessMeans = [...acc.daily.values()].filter((d) => d.excessN > 0).map((d) => d.excessSum / d.excessN);
  const rawHac = neweyWestMeanForExitTest(dailyReturnMeans, meta.scenario.maxHoldingDays - 1);
  const excessHac = neweyWestMeanForExitTest(dailyExcessMeans, meta.scenario.maxHoldingDays - 1);
  const n = acc.acceptedTrades;
  return {
    scope: meta.scope, split: meta.split, year: meta.year,
    market: meta.scenario.market, scenarioId: meta.scenario.id,
    entryThreshold: meta.scenario.entryThreshold, exitMode: meta.scenario.exitMode,
    upsideExitThreshold: meta.scenario.upsideExitThreshold, downsideExitThreshold: meta.scenario.downsideExitThreshold,
    maxHoldingDays: meta.scenario.maxHoldingDays,
    rawOnsets: acc.rawOnsets, acceptedTrades: n, skippedReentry: acc.skippedReentry, unresolvedOnsets: acc.unresolvedOnsets,
    independentSignalRate: acc.rawOnsets ? round((n / acc.rawOnsets) * 100) : null,
    signalDates: acc.dates.size, avgSignalsPerDate: acc.dates.size ? round(n / acc.dates.size) : null,
    avgReturn: round(average(returns)), medianReturn: round(median(returns)),
    winRate: n ? round((acc.positive / n) * 100) : null,
    avgWin: acc.winN ? round(acc.winSum / acc.winN) : null,
    avgLoss: acc.lossN ? round(acc.lossSum / acc.lossN) : null,
    payoffRatio: acc.winN && acc.lossN && acc.lossSum !== 0 ? round((acc.winSum / acc.winN) / Math.abs(acc.lossSum / acc.lossN)) : null,
    profitFactor: acc.lossAbsSum > 0 ? round(acc.profitSum / acc.lossAbsSum) : acc.profitSum > 0 ? null : 0,
    avgExcessReturn: round(average(excess)), medianExcessReturn: round(median(excess)),
    excessWinRate: excess.length ? round((acc.excessPositive / excess.length) * 100) : null,
    avgMae: acc.maeN ? round(acc.maeSum / acc.maeN) : null,
    avgMfe: acc.mfeN ? round(acc.mfeSum / acc.mfeN) : null,
    avgHoldingDays: round(average(acc.holdings)), medianHoldingDays: round(median(acc.holdings)),
    timeExitRate: n ? round((acc.timeExits / n) * 100) : null,
    upsideExitRate: n ? round((acc.upsideExits / n) * 100) : null,
    downsideExitRate: n ? round((acc.downsideExits / n) * 100) : null,
    dailyAvgReturnHacMean: round(rawHac.mean), dailyAvgReturnHacT: round(rawHac.t), dailyAvgReturnCiLow: round(rawHac.ciLow), dailyAvgReturnCiHigh: round(rawHac.ciHigh),
    dailyAvgExcessHacMean: round(excessHac.mean), dailyAvgExcessHacT: round(excessHac.t), dailyAvgExcessCiLow: round(excessHac.ciLow), dailyAvgExcessCiHigh: round(excessHac.ciHigh),
  };
}

function metricKey(scope: "SPLIT" | "YEAR", split: V8ExitSplit | null, year: number | null) {
  return `${scope}|${split ?? ""}|${year ?? ""}`;
}

export function buildV8ExitHoldingValidation(dataset: MarketDataset, options: V8ExitHoldingOptions = {}): V8ExitHoldingResult | null {
  const limit = Math.max(1, Math.round(options.limit ?? 613));
  const warmupDays = Math.max(120, Math.round(options.warmupDays ?? 120));
  const roundTripCostBps = Math.max(0, options.roundTripCostBps ?? 0);
  const priceLeadershipOverheatThreshold = Math.max(0, Math.min(100, options.priceLeadershipOverheatThreshold ?? V8_EXIT_HOLDING_PL_OVERHEAT_THRESHOLD));
  const marketEntryThresholds: Record<V8ExitMarket, number[]> = {
    KOSPI: [...new Set(options.marketEntryThresholds?.KOSPI ?? [65, 75])].sort((a, b) => a - b),
    KOSDAQ: [...new Set(options.marketEntryThresholds?.KOSDAQ ?? [75, 80])].sort((a, b) => a - b),
  };
  const ups = [...new Set(options.upsideExitThresholds ?? [...V8_EXIT_UPSIDE_THRESHOLDS])].sort((a, b) => a - b);
  const downs = [...new Set(options.downsideExitThresholds ?? [...V8_EXIT_DOWNSIDE_THRESHOLDS])].sort((a, b) => a - b);
  const holds = [...new Set(options.maxHoldingDays ?? [...V8_EXIT_MAX_HOLDING_DAYS])].sort((a, b) => a - b);
  if (!ups.length || !downs.length || !holds.length) return null;
  const context = buildPortfolioSignalContext(dataset, limit);
  if (!context.series.length || !context.allDates.length) return null;
  const policy = buildSplitPolicy(context.allDates);
  const benchmarks = benchmarkMaps(dataset);
  const prepared: PreparedSeries[] = context.series.map((source) => ({
    source,
    scores: source.baseScores.map((base, i) => finite(base)
      ? adjustSectorPenaltyScore(base, source.sectorPriceLeadership[i] ?? null, priceLeadershipOverheatThreshold).score
      : null),
  }));
  const scenarios = (["KOSPI", "KOSDAQ"] as const).flatMap((market) =>
    makeScenarios(market, marketEntryThresholds[market], ups, downs, holds));
  const rows: V8ExitHoldingMetricRow[] = [];

  for (const scenario of scenarios) {
    const accs = new Map<string, { meta: { scope: "SPLIT" | "YEAR"; split: V8ExitSplit | null; year: number | null; scenario: V8ExitScenario }; acc: MetricAcc }>();
    const groupFor = (date: string) => {
      const split = splitForDate(date, policy);
      const year = Number(date.slice(0, 4));
      return [
        { scope: "SPLIT" as const, split: "ALL" as V8ExitSplit, year: null },
        { scope: "SPLIT" as const, split, year: null },
        { scope: "YEAR" as const, split: null, year },
      ];
    };
    const getAcc = (scope: "SPLIT" | "YEAR", split: V8ExitSplit | null, year: number | null) => {
      const key = metricKey(scope, split, year);
      let item = accs.get(key);
      if (!item) { item = { meta: { scope, split, year, scenario }, acc: makeAcc() }; accs.set(key, item); }
      return item.acc;
    };

    for (const item of prepared) {
      if (item.source.market !== scenario.market) continue;
      let lastExitIndex = -1;
      let lastExitTiming: V8ExitTiming | null = null;
      for (let i = warmupDays; i + 1 < item.source.bars.length; i++) {
        const prev = item.scores[i - 1] ?? null;
        const cur = item.scores[i] ?? null;
        if (!crossedUpPercentForTest(prev, cur, scenario.entryThreshold)) continue;
        const curPct = pct(cur);
        if (scenario.upsideExitThreshold !== null && curPct !== null && curPct >= scenario.upsideExitThreshold) continue;
        const date = item.source.bars[i]!.tradeDate;
        const groups = groupFor(date);
        const blocked = shouldBlockOnsetForTest(i, lastExitIndex, lastExitTiming);
        if (blocked) {
          for (const g of groups) addRaw(getAcc(g.scope, g.split, g.year), true);
          continue;
        }
        const trade = simulateExit(item, i, scenario, benchmarks, roundTripCostBps);
        if (!trade) {
          for (const g of groups) addRaw(getAcc(g.scope, g.split, g.year), false, true);
          continue;
        }
        for (const g of groups) {
          const acc = getAcc(g.scope, g.split, g.year);
          addRaw(acc, false);
          addTrade(acc, trade);
        }
        lastExitIndex = trade.exitIndex;
        lastExitTiming = trade.exitTiming;
      }
    }
    rows.push(...[...accs.values()].map(({ meta, acc }) => finalize(meta, acc)));
  }

  rows.sort((a, b) => a.scope.localeCompare(b.scope) || String(a.split ?? a.year ?? "").localeCompare(String(b.split ?? b.year ?? "")) || a.market.localeCompare(b.market) || a.entryThreshold - b.entryThreshold || a.maxHoldingDays - b.maxHoldingDays || a.exitMode.localeCompare(b.exitMode) || (a.upsideExitThreshold ?? -1) - (b.upsideExitThreshold ?? -1) || (a.downsideExitThreshold ?? -1) - (b.downsideExitThreshold ?? -1));
  return {
    version: V8_EXIT_HOLDING_VERSION,
    from: context.allDates[0] ?? dataset.asOfDate,
    to: context.allDates.at(-1) ?? dataset.asOfDate,
    symbolCount: context.series.length,
    warmupDays,
    roundTripCostBps,
    priceLeadershipOverheatThreshold,
    marketEntryThresholds,
    upsideExitThresholds: ups,
    downsideExitThresholds: downs,
    maxHoldingDays: holds,
    scenarios,
    splitPolicy: { method: "chronological-60-20-20", ...policy },
    scorePolicy: {
      baseScoreMax: 9.5,
      sectorSlotPoints: 0.5,
      missingSectorPriceLeadership: "no-sector-slot",
      normalSectorPriceLeadership: "+0.5",
      overheatedSectorPriceLeadership: "no-net-sector-slot",
    },
    executionPolicy: {
      onset: "previous-score-below-entry-threshold-and-current-score-at-or-above-entry-threshold",
      entry: "NEXT_OPEN",
      scoreExit: "CROSSING_SIGNAL_NEXT_OPEN",
      timeExit: "MAX_HOLDING_DAY_CLOSE",
      reentry: "NEW_ONSET_AFTER_EXIT_ONLY",
    },
    rows,
    notes: [
      "KOSDAQ entry thresholds 75/80 come from V8-3; KOSPI 65/75 are retained only as diagnostics because V8-3 OOS excess alpha was negative across KOSPI entry thresholds.",
      "Time-only, upside-only, downside-only, and combined score exits are compared at 20/30/40/60 trading-day maximum holding windows.",
      "Score exits are triggered by a close-to-close threshold crossing and executed at the next trading-day open to avoid look-ahead.",
      "Re-entry is blocked while a position is active; a new onset is eligible only after the prior trade exits.",
      "Sector Price Leadership missing values receive no +0.5 sector slot, matching the V8 score policy used in V8-2 and V8-3.",
      "Market excess return uses the matching KOSPI/KOSDAQ benchmark from entry open to the same exit open/close; no benchmark fallback is used.",
    ],
  };
}
