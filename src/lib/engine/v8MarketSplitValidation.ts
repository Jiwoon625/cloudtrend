import type { MarketDataset } from "./dataset";
import { adjustSectorPenaltyScore } from "./sectorScoreAdjustment";
import { buildPortfolioSignalContext, type PortfolioSeries } from "./sectorPenaltyPortfolioSignals";
import type { DailyPrice } from "./types";
import {
  crossedDownPercentForTest,
  crossedUpPercentForTest,
  neweyWestMeanForExitTest,
  shouldBlockOnsetForTest,
} from "./v8ExitHoldingValidation";

export const V8_MARKET_SPLIT_VERSION = "CloudTrend V8 Market Split Validation" as const;
export const V8_MARKET_SPLIT_PL_OVERHEAT_THRESHOLD = 80 as const;
export const V8_MARKET_SPLIT_UPSIDE_EXIT = 90 as const;
export const V8_MARKET_SPLIT_DOWNSIDE_EXIT = 25 as const;
export const V8_MARKET_SPLIT_MAX_HOLDING = 60 as const;

export type V8MarketCode = "KOSPI" | "KOSDAQ";
export type V8MarketSplit = "ALL" | "DEVELOPMENT" | "VALIDATION" | "OOS";
export type V8RelativeStrengthOverlay =
  | "NONE"
  | "RS20_POS"
  | "RS60_POS"
  | "RS20_60_POS"
  | "RS20_GE5"
  | "RS60_GE5"
  | "RS20_60_GE5";

export interface V8MarketSplitOptions {
  limit?: number;
  warmupDays?: number;
  roundTripCostBps?: number;
  priceLeadershipOverheatThreshold?: number;
  marketEntryThresholds?: Partial<Record<V8MarketCode, number[]>>;
  overlays?: V8RelativeStrengthOverlay[];
}

export interface V8MarketSplitMetricRow {
  scope: "SPLIT" | "YEAR";
  split: V8MarketSplit | null;
  year: number | null;
  market: V8MarketCode;
  entryThreshold: number;
  overlay: V8RelativeStrengthOverlay;
  rawOnsets: number;
  overlayEligibleOnsets: number;
  unavailableRelativeStrength: number;
  filteredByOverlay: number;
  skippedReentry: number;
  unresolvedOnsets: number;
  acceptedTrades: number;
  overlayPassRate: number | null;
  avgRs20: number | null;
  avgRs60: number | null;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  profitFactor: number | null;
  avgExcessReturn: number | null;
  medianExcessReturn: number | null;
  excessWinRate: number | null;
  avgMae: number | null;
  avgMfe: number | null;
  avgHoldingDays: number | null;
  upsideExitRate: number | null;
  downsideExitRate: number | null;
  timeExitRate: number | null;
  dailyAvgExcessHacMean: number | null;
  dailyAvgExcessHacT: number | null;
  dailyAvgExcessCiLow: number | null;
  dailyAvgExcessCiHigh: number | null;
}

export interface V8MarketSplitResult {
  version: typeof V8_MARKET_SPLIT_VERSION;
  from: string;
  to: string;
  symbolCount: number;
  warmupDays: number;
  roundTripCostBps: number;
  priceLeadershipOverheatThreshold: number;
  marketEntryThresholds: Record<V8MarketCode, number[]>;
  overlays: V8RelativeStrengthOverlay[];
  scorePolicy: {
    scoreMax: 10;
    baseScoreMax: 9.5;
    sectorSlotPoints: 0.5;
    missingSectorPriceLeadership: "no-sector-slot";
    normalSectorPriceLeadership: "+0.5";
    overheatedSectorPriceLeadership: "no-net-sector-slot";
    sameScaleForBothMarkets: true;
  };
  strategyPolicy: {
    upsideExitThreshold: 90;
    downsideExitThreshold: 25;
    maxHoldingDays: 60;
    entryExecution: "NEXT_OPEN";
    scoreExitExecution: "CROSSING_SIGNAL_NEXT_OPEN";
    timeExitExecution: "MAX_HOLDING_DAY_CLOSE";
    reentry: "NEW_ONSET_AFTER_EXIT_ONLY";
  };
  splitPolicy: {
    method: "chronological-60-20-20";
    developmentFrom: string | null;
    validationFrom: string | null;
    oosFrom: string | null;
  };
  rows: V8MarketSplitMetricRow[];
  notes: string[];
}

interface PreparedSeries {
  source: PortfolioSeries;
  scores: Array<number | null>;
}

interface Trade {
  signalDate: string;
  entryDate: string;
  exitDate: string;
  exitIndex: number;
  exitTiming: "OPEN" | "CLOSE";
  exitReason: "UPSIDE_SCORE" | "DOWNSIDE_SCORE" | "TIME";
  ret: number;
  excess: number | null;
  mae: number | null;
  mfe: number | null;
  holdingDays: number;
}

interface DailyAcc { excessSum: number; excessN: number; }
interface MetricAcc {
  rawOnsets: number;
  overlayEligibleOnsets: number;
  unavailableRelativeStrength: number;
  filteredByOverlay: number;
  skippedReentry: number;
  unresolvedOnsets: number;
  acceptedTrades: number;
  rs20Sum: number;
  rs20N: number;
  rs60Sum: number;
  rs60N: number;
  returns: number[];
  excess: number[];
  positive: number;
  excessPositive: number;
  profitSum: number;
  lossAbsSum: number;
  maeSum: number;
  maeN: number;
  mfeSum: number;
  mfeN: number;
  holding: number[];
  upside: number;
  downside: number;
  time: number;
  daily: Map<string, DailyAcc>;
}

const finite = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value);
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)]! + sorted[Math.ceil(mid)]!) / 2;
}
function round(value: number | null, digits = 6) {
  if (!finite(value)) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}
function pct(score: number | null | undefined) { return finite(score) ? score * 10 : null; }

export function relativeStrengthForTest(stockNow: number, stockPast: number, indexNow: number, indexPast: number) {
  if (![stockNow, stockPast, indexNow, indexPast].every((v) => Number.isFinite(v) && v > 0)) return null;
  return ((stockNow / stockPast - 1) - (indexNow / indexPast - 1)) * 100;
}

export function overlayPassForTest(overlay: V8RelativeStrengthOverlay, rs20: number | null, rs60: number | null) {
  if (overlay === "NONE") return true;
  if (overlay === "RS20_POS") return finite(rs20) && rs20 > 0;
  if (overlay === "RS60_POS") return finite(rs60) && rs60 > 0;
  if (overlay === "RS20_60_POS") return finite(rs20) && finite(rs60) && rs20 > 0 && rs60 > 0;
  if (overlay === "RS20_GE5") return finite(rs20) && rs20 >= 5;
  if (overlay === "RS60_GE5") return finite(rs60) && rs60 >= 5;
  return finite(rs20) && finite(rs60) && rs20 >= 5 && rs60 >= 5;
}

function makeAcc(): MetricAcc {
  return {
    rawOnsets: 0, overlayEligibleOnsets: 0, unavailableRelativeStrength: 0, filteredByOverlay: 0,
    skippedReentry: 0, unresolvedOnsets: 0, acceptedTrades: 0,
    rs20Sum: 0, rs20N: 0, rs60Sum: 0, rs60N: 0,
    returns: [], excess: [], positive: 0, excessPositive: 0, profitSum: 0, lossAbsSum: 0,
    maeSum: 0, maeN: 0, mfeSum: 0, mfeN: 0, holding: [], upside: 0, downside: 0, time: 0,
    daily: new Map<string, DailyAcc>(),
  };
}

function buildSplitPolicy(allDates: string[]) {
  const dates = [...new Set(allDates)].sort();
  if (!dates.length) return { developmentFrom: null, validationFrom: null, oosFrom: null };
  return {
    developmentFrom: dates[0] ?? null,
    validationFrom: dates[Math.min(dates.length - 1, Math.floor(dates.length * 0.6))] ?? null,
    oosFrom: dates[Math.min(dates.length - 1, Math.floor(dates.length * 0.8))] ?? null,
  };
}
function splitForDate(date: string, policy: { validationFrom: string | null; oosFrom: string | null }): Exclude<V8MarketSplit, "ALL"> {
  if (policy.oosFrom && date >= policy.oosFrom) return "OOS";
  if (policy.validationFrom && date >= policy.validationFrom) return "VALIDATION";
  return "DEVELOPMENT";
}
function metricKey(scope: "SPLIT" | "YEAR", split: V8MarketSplit | null, year: number | null) {
  return `${scope}|${split ?? ""}|${year ?? ""}`;
}

function benchmarkMaps(dataset: MarketDataset) {
  const out = new Map<V8MarketCode, Map<string, DailyPrice>>();
  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    const series = dataset.indexSeries.find((item) => item.indexCode === market);
    out.set(market, new Map((series?.bars ?? []).map((bar) => [bar.tradeDate, bar])));
  }
  return out;
}

function relativeStrengthAt(series: PortfolioSeries, signalIndex: number, lookback: number, benchmark: Map<string, DailyPrice>) {
  const cur = series.bars[signalIndex];
  const past = series.bars[signalIndex - lookback];
  if (!cur || !past || !finite(cur.close) || !finite(past.close) || cur.close <= 0 || past.close <= 0) return null;
  const indexCur = benchmark.get(cur.tradeDate);
  const indexPast = benchmark.get(past.tradeDate);
  if (!indexCur || !indexPast || !finite(indexCur.close) || !finite(indexPast.close) || indexCur.close <= 0 || indexPast.close <= 0) return null;
  return relativeStrengthForTest(cur.close, past.close, indexCur.close, indexPast.close);
}

function benchmarkReturn(
  maps: Map<V8MarketCode, Map<string, DailyPrice>>,
  market: V8MarketCode,
  entryDate: string,
  exitDate: string,
  exitTiming: "OPEN" | "CLOSE",
) {
  const entry = maps.get(market)?.get(entryDate);
  const exit = maps.get(market)?.get(exitDate);
  const exitPrice = exitTiming === "OPEN" ? exit?.open : exit?.close;
  if (!entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exitPrice) || exitPrice <= 0) return null;
  return (exitPrice / entry.open - 1) * 100;
}

function excursion(bars: DailyPrice[], entryIndex: number, exitIndex: number, entryPrice: number, exitPrice: number, timing: "OPEN" | "CLOSE") {
  let low = entryPrice, high = entryPrice;
  for (let i = entryIndex; i <= exitIndex; i++) {
    const bar = bars[i]; if (!bar) break;
    if (i === exitIndex && timing === "OPEN") { low = Math.min(low, exitPrice); high = Math.max(high, exitPrice); continue; }
    if (finite(bar.low) && bar.low > 0) low = Math.min(low, bar.low);
    if (finite(bar.high) && bar.high > 0) high = Math.max(high, bar.high);
  }
  return { mae: (low / entryPrice - 1) * 100, mfe: (high / entryPrice - 1) * 100 };
}

function simulateTrade(
  item: PreparedSeries,
  signalIndex: number,
  market: V8MarketCode,
  benchmarks: Map<V8MarketCode, Map<string, DailyPrice>>,
  roundTripCostBps: number,
): Trade | null {
  const bars = item.source.bars;
  const entryIndex = signalIndex + 1;
  const plannedExit = signalIndex + V8_MARKET_SPLIT_MAX_HOLDING;
  const entry = bars[entryIndex];
  if (!entry || plannedExit >= bars.length || !finite(entry.open) || entry.open <= 0) return null;
  let exitIndex = -1;
  let exitPrice = 0;
  let exitTiming: "OPEN" | "CLOSE" = "CLOSE";
  let exitReason: Trade["exitReason"] = "TIME";
  for (let j = entryIndex; j <= plannedExit; j++) {
    const bar = bars[j];
    if (!bar || ![bar.open, bar.close, bar.low, bar.high].every((v) => finite(v) && v > 0)) return null;
    if (j > entryIndex) {
      const si = j - 1;
      const prev = item.scores[si - 1] ?? null;
      const cur = item.scores[si] ?? null;
      if (crossedDownPercentForTest(prev, cur, V8_MARKET_SPLIT_DOWNSIDE_EXIT)) {
        exitIndex = j; exitPrice = bar.open; exitTiming = "OPEN"; exitReason = "DOWNSIDE_SCORE"; break;
      }
      if (crossedUpPercentForTest(prev, cur, V8_MARKET_SPLIT_UPSIDE_EXIT)) {
        exitIndex = j; exitPrice = bar.open; exitTiming = "OPEN"; exitReason = "UPSIDE_SCORE"; break;
      }
    }
    if (j === plannedExit) { exitIndex = j; exitPrice = bar.close; }
  }
  if (exitIndex < 0 || exitPrice <= 0) return null;
  const ex = excursion(bars, entryIndex, exitIndex, entry.open, exitPrice, exitTiming);
  const ret = (exitPrice / entry.open - 1) * 100 - roundTripCostBps / 100;
  const bench = benchmarkReturn(benchmarks, market, entry.tradeDate, bars[exitIndex]!.tradeDate, exitTiming);
  return {
    signalDate: bars[signalIndex]!.tradeDate,
    entryDate: entry.tradeDate,
    exitDate: bars[exitIndex]!.tradeDate,
    exitIndex,
    exitTiming,
    exitReason,
    ret,
    excess: finite(bench) ? ret - bench : null,
    mae: ex.mae,
    mfe: ex.mfe,
    holdingDays: exitIndex - entryIndex + 1,
  };
}

function addTrade(acc: MetricAcc, trade: Trade, rs20: number | null, rs60: number | null) {
  acc.acceptedTrades++;
  acc.returns.push(trade.ret);
  acc.positive += trade.ret > 0 ? 1 : 0;
  if (trade.ret > 0) acc.profitSum += trade.ret;
  else if (trade.ret < 0) acc.lossAbsSum += Math.abs(trade.ret);
  if (finite(trade.excess)) { acc.excess.push(trade.excess); acc.excessPositive += trade.excess > 0 ? 1 : 0; }
  if (finite(rs20)) { acc.rs20Sum += rs20; acc.rs20N++; }
  if (finite(rs60)) { acc.rs60Sum += rs60; acc.rs60N++; }
  if (finite(trade.mae)) { acc.maeSum += trade.mae; acc.maeN++; }
  if (finite(trade.mfe)) { acc.mfeSum += trade.mfe; acc.mfeN++; }
  acc.holding.push(trade.holdingDays);
  if (trade.exitReason === "UPSIDE_SCORE") acc.upside++;
  else if (trade.exitReason === "DOWNSIDE_SCORE") acc.downside++;
  else acc.time++;
  if (finite(trade.excess)) {
    const d = acc.daily.get(trade.signalDate) ?? { excessSum: 0, excessN: 0 };
    d.excessSum += trade.excess; d.excessN++;
    acc.daily.set(trade.signalDate, d);
  }
}

function finalize(
  meta: { scope: "SPLIT" | "YEAR"; split: V8MarketSplit | null; year: number | null; market: V8MarketCode; entryThreshold: number; overlay: V8RelativeStrengthOverlay },
  acc: MetricAcc,
): V8MarketSplitMetricRow {
  const n = acc.acceptedTrades;
  const daily = [...acc.daily.values()].filter((x) => x.excessN > 0).map((x) => x.excessSum / x.excessN);
  const hac = neweyWestMeanForExitTest(daily, V8_MARKET_SPLIT_MAX_HOLDING - 1);
  return {
    ...meta,
    rawOnsets: acc.rawOnsets,
    overlayEligibleOnsets: acc.overlayEligibleOnsets,
    unavailableRelativeStrength: acc.unavailableRelativeStrength,
    filteredByOverlay: acc.filteredByOverlay,
    skippedReentry: acc.skippedReentry,
    unresolvedOnsets: acc.unresolvedOnsets,
    acceptedTrades: n,
    overlayPassRate: acc.rawOnsets ? round((acc.overlayEligibleOnsets / acc.rawOnsets) * 100) : null,
    avgRs20: acc.rs20N ? round(acc.rs20Sum / acc.rs20N) : null,
    avgRs60: acc.rs60N ? round(acc.rs60Sum / acc.rs60N) : null,
    avgReturn: round(average(acc.returns)),
    medianReturn: round(median(acc.returns)),
    winRate: n ? round((acc.positive / n) * 100) : null,
    profitFactor: acc.lossAbsSum > 0 ? round(acc.profitSum / acc.lossAbsSum) : acc.profitSum > 0 ? null : 0,
    avgExcessReturn: round(average(acc.excess)),
    medianExcessReturn: round(median(acc.excess)),
    excessWinRate: acc.excess.length ? round((acc.excessPositive / acc.excess.length) * 100) : null,
    avgMae: acc.maeN ? round(acc.maeSum / acc.maeN) : null,
    avgMfe: acc.mfeN ? round(acc.mfeSum / acc.mfeN) : null,
    avgHoldingDays: round(average(acc.holding)),
    upsideExitRate: n ? round((acc.upside / n) * 100) : null,
    downsideExitRate: n ? round((acc.downside / n) * 100) : null,
    timeExitRate: n ? round((acc.time / n) * 100) : null,
    dailyAvgExcessHacMean: round(hac.mean),
    dailyAvgExcessHacT: round(hac.t),
    dailyAvgExcessCiLow: round(hac.ciLow),
    dailyAvgExcessCiHigh: round(hac.ciHigh),
  };
}

export function buildV8MarketSplitValidation(dataset: MarketDataset, options: V8MarketSplitOptions = {}): V8MarketSplitResult | null {
  const limit = Math.max(1, Math.round(options.limit ?? 613));
  const warmupDays = Math.max(120, Math.round(options.warmupDays ?? 120));
  const roundTripCostBps = Math.max(0, options.roundTripCostBps ?? 0);
  const priceLeadershipOverheatThreshold = Math.max(0, Math.min(100, options.priceLeadershipOverheatThreshold ?? V8_MARKET_SPLIT_PL_OVERHEAT_THRESHOLD));
  const marketEntryThresholds: Record<V8MarketCode, number[]> = {
    KOSPI: [...new Set(options.marketEntryThresholds?.KOSPI ?? [65, 70, 75, 80])].sort((a, b) => a - b),
    KOSDAQ: [...new Set(options.marketEntryThresholds?.KOSDAQ ?? [75, 80])].sort((a, b) => a - b),
  };
  const overlays = [...new Set(options.overlays ?? ["NONE", "RS20_POS", "RS60_POS", "RS20_60_POS", "RS20_GE5", "RS60_GE5", "RS20_60_GE5"] as V8RelativeStrengthOverlay[])];
  const context = buildPortfolioSignalContext(dataset, limit);
  if (!context.series.length || !context.allDates.length) return null;
  const splitPolicy = buildSplitPolicy(context.allDates);
  const benchmarks = benchmarkMaps(dataset);
  const prepared: PreparedSeries[] = context.series.map((source) => ({
    source,
    scores: source.baseScores.map((base, i) => finite(base)
      ? adjustSectorPenaltyScore(base, source.sectorPriceLeadership[i] ?? null, priceLeadershipOverheatThreshold).score
      : null),
  }));
  const rows: V8MarketSplitMetricRow[] = [];

  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    const benchmark = benchmarks.get(market) ?? new Map<string, DailyPrice>();
    for (const entryThreshold of marketEntryThresholds[market]) {
      for (const overlay of overlays) {
        const accs = new Map<string, { meta: { scope: "SPLIT" | "YEAR"; split: V8MarketSplit | null; year: number | null; market: V8MarketCode; entryThreshold: number; overlay: V8RelativeStrengthOverlay }; acc: MetricAcc }>();
        const groups = (date: string) => {
          const split = splitForDate(date, splitPolicy);
          const year = Number(date.slice(0, 4));
          return [
            { scope: "SPLIT" as const, split: "ALL" as V8MarketSplit, year: null },
            { scope: "SPLIT" as const, split, year: null },
            { scope: "YEAR" as const, split: null, year },
          ];
        };
        const getAcc = (scope: "SPLIT" | "YEAR", split: V8MarketSplit | null, year: number | null) => {
          const key = metricKey(scope, split, year);
          let item = accs.get(key);
          if (!item) {
            item = { meta: { scope, split, year, market, entryThreshold, overlay }, acc: makeAcc() };
            accs.set(key, item);
          }
          return item.acc;
        };

        for (const item of prepared) {
          if (item.source.market !== market) continue;
          let lastExitIndex = -1;
          let lastExitTiming: "OPEN" | "CLOSE" | null = null;
          for (let i = warmupDays; i + 1 < item.source.bars.length; i++) {
            const prev = item.scores[i - 1] ?? null;
            const cur = item.scores[i] ?? null;
            if (!crossedUpPercentForTest(prev, cur, entryThreshold)) continue;
            const date = item.source.bars[i]!.tradeDate;
            const gs = groups(date);
            for (const g of gs) getAcc(g.scope, g.split, g.year).rawOnsets++;
            const curPct = pct(cur);
            if (curPct !== null && curPct >= V8_MARKET_SPLIT_UPSIDE_EXIT) {
              for (const g of gs) getAcc(g.scope, g.split, g.year).filteredByOverlay++;
              continue;
            }
            const rs20 = relativeStrengthAt(item.source, i, 20, benchmark);
            const rs60 = relativeStrengthAt(item.source, i, 60, benchmark);
            const needs20 = overlay.includes("20");
            const needs60 = overlay.includes("60");
            if ((needs20 && !finite(rs20)) || (needs60 && !finite(rs60))) {
              for (const g of gs) getAcc(g.scope, g.split, g.year).unavailableRelativeStrength++;
              continue;
            }
            if (!overlayPassForTest(overlay, rs20, rs60)) {
              for (const g of gs) getAcc(g.scope, g.split, g.year).filteredByOverlay++;
              continue;
            }
            for (const g of gs) getAcc(g.scope, g.split, g.year).overlayEligibleOnsets++;
            if (shouldBlockOnsetForTest(i, lastExitIndex, lastExitTiming)) {
              for (const g of gs) getAcc(g.scope, g.split, g.year).skippedReentry++;
              continue;
            }
            const trade = simulateTrade(item, i, market, benchmarks, roundTripCostBps);
            if (!trade) {
              for (const g of gs) getAcc(g.scope, g.split, g.year).unresolvedOnsets++;
              continue;
            }
            for (const g of gs) addTrade(getAcc(g.scope, g.split, g.year), trade, rs20, rs60);
            lastExitIndex = trade.exitIndex;
            lastExitTiming = trade.exitTiming;
          }
        }
        rows.push(...[...accs.values()].map(({ meta, acc }) => finalize(meta, acc)));
      }
    }
  }

  rows.sort((a, b) => a.scope.localeCompare(b.scope) || String(a.split ?? a.year ?? "").localeCompare(String(b.split ?? b.year ?? "")) || a.market.localeCompare(b.market) || a.entryThreshold - b.entryThreshold || a.overlay.localeCompare(b.overlay));
  return {
    version: V8_MARKET_SPLIT_VERSION,
    from: context.allDates[0] ?? dataset.asOfDate,
    to: context.allDates.at(-1) ?? dataset.asOfDate,
    symbolCount: context.series.length,
    warmupDays,
    roundTripCostBps,
    priceLeadershipOverheatThreshold,
    marketEntryThresholds,
    overlays,
    scorePolicy: {
      scoreMax: 10,
      baseScoreMax: 9.5,
      sectorSlotPoints: 0.5,
      missingSectorPriceLeadership: "no-sector-slot",
      normalSectorPriceLeadership: "+0.5",
      overheatedSectorPriceLeadership: "no-net-sector-slot",
      sameScaleForBothMarkets: true,
    },
    strategyPolicy: {
      upsideExitThreshold: 90,
      downsideExitThreshold: 25,
      maxHoldingDays: 60,
      entryExecution: "NEXT_OPEN",
      scoreExitExecution: "CROSSING_SIGNAL_NEXT_OPEN",
      timeExitExecution: "MAX_HOLDING_DAY_CLOSE",
      reentry: "NEW_ONSET_AFTER_EXIT_ONLY",
    },
    splitPolicy: { method: "chronological-60-20-20", ...splitPolicy },
    rows,
    notes: [
      "KOSPI and KOSDAQ both retain the same 10-point score scale and the same Sector Price Leadership +0.5 / PL>=80 no-slot policy.",
      "Market-specific behavior is tested only through entry thresholds and pre-entry market-relative-strength overlays; the score scale itself is not changed.",
      "RS20/RS60 equals stock close-to-close return minus the matching KOSPI/KOSDAQ close-to-close return over the same signal-date lookback window.",
      "Relative-strength overlays use only information available at the signal-date close and therefore do not introduce look-ahead.",
      "The exit policy is fixed at the V8-4 balanced candidate: score >=90 upside exit, score <25 downside exit, maximum 60 trading days, with score exits executed next open.",
    ],
  };
}
