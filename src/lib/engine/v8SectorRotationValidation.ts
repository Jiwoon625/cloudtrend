import type { MarketDataset } from "./dataset";
import { DEFAULT_ROTATION_WEIGHTS } from "./sectorRotation";
import { adjustSectorPenaltyScore } from "./sectorScoreAdjustment";
import { buildPortfolioSignalContext, type PortfolioSeries } from "./sectorPenaltyPortfolioSignals";
import type { DailyPrice } from "./types";
import {
  crossedDownPercentForTest,
  crossedUpPercentForTest,
  neweyWestMeanForExitTest,
  shouldBlockOnsetForTest,
} from "./v8ExitHoldingValidation";

export const V8_SECTOR_ROTATION_VERSION = "CloudTrend V8 Sector Rotation vs Price Leadership Validation" as const;
export const V8_SECTOR_ROTATION_PL_OVERHEAT_THRESHOLD = 80 as const;
export const V8_SECTOR_ROTATION_UPSIDE_EXIT = 90 as const;
export const V8_SECTOR_ROTATION_DOWNSIDE_EXIT = 25 as const;
export const V8_SECTOR_ROTATION_MAX_HOLDING = 60 as const;

export type V8SectorRotationMarket = "KOSPI" | "KOSDAQ";
export type V8SectorFactor = "PRICE_LEADERSHIP" | "ROTATION_SCORE" | "MONEY_FLOW" | "ROTATION_MOMENTUM";
export type V8SectorSelection = "ALL" | "TOP50" | "TOP25" | "RAW_GE60" | "RAW_GE70" | "Q1" | "Q2" | "Q3" | "Q4";

export interface V8SectorRotationOptions {
  limit?: number;
  warmupDays?: number;
  roundTripCostBps?: number;
  years?: number[];
  marketEntryThresholds?: Partial<Record<V8SectorRotationMarket, number[]>>;
}

export interface V8SectorFeaturePoint {
  date: string;
  sectorCode: string;
  priceLeadership: number | null;
  moneyFlow: number | null;
  rotationMomentum: number | null;
  rotationScore: number | null;
  priceLeadershipRankPct: number | null;
  moneyFlowRankPct: number | null;
  rotationMomentumRankPct: number | null;
  rotationScoreRankPct: number | null;
  turnoverShare5d: number | null;
  turnoverShare20d: number | null;
  bothBuy5d: number | null;
}

export interface V8SectorRotationMetricRow {
  year: number;
  market: V8SectorRotationMarket;
  entryThreshold: number;
  factor: "CONTROL" | V8SectorFactor;
  selection: V8SectorSelection;
  baseTrades: number;
  availableTrades: number;
  acceptedTrades: number;
  retainedRate: number | null;
  avgFactorRaw: number | null;
  avgFactorRankPct: number | null;
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
  dailyAvgExcessHacMean: number | null;
  dailyAvgExcessHacT: number | null;
  dailyAvgExcessCiLow: number | null;
  dailyAvgExcessCiHigh: number | null;
}

export interface V8SectorRotationParityRow {
  sectorCode: string;
  priceLeadership: number | null;
  moneyFlow: number | null;
  rotationMomentum: number | null;
  rotationScore: number | null;
}

export interface V8SectorRotationResult {
  version: typeof V8_SECTOR_ROTATION_VERSION;
  from: string;
  to: string;
  symbolCount: number;
  sectorCount: number;
  warmupDays: number;
  roundTripCostBps: number;
  years: number[];
  marketEntryThresholds: Record<V8SectorRotationMarket, number[]>;
  scorePolicy: {
    scoreMax: 10;
    baseScoreMax: 9.5;
    sectorSlotPoints: 0.5;
    priceLeadershipOverheatThreshold: 80;
    policy: "UNCHANGED_V8_10_POINT_SCORE";
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
  sectorPolicy: {
    rotationWeights: { priceLeadership: number; moneyFlow: number; rotationMomentum: number };
    comparison: "PL_VS_FULL_ROTATION_WITH_EQUAL_CROSS_SECTIONAL_RANK_FILTERS";
    rankSelections: ["TOP50", "TOP25"];
    rawSelections: ["RAW_GE60", "RAW_GE70"];
    quartiles: ["Q1", "Q2", "Q3", "Q4"];
    useAtSignalCloseOnly: true;
  };
  featureCoverage: Array<{
    year: number;
    factor: V8SectorFactor;
    observations: number;
    available: number;
    availabilityRate: number | null;
  }>;
  latestSectorFeatures: V8SectorRotationParityRow[];
  rows: V8SectorRotationMetricRow[];
  notes: string[];
}

interface PreparedFlowSeries {
  source: PortfolioSeries;
  turnoverPrefix: number[];
  foreignPrefix: number[];
  foreignNullPrefix: number[];
  institutionPrefix: number[];
  institutionNullPrefix: number[];
}

interface SectorFlowRaw {
  sectorCode: string;
  turnover5: number;
  turnover20: number;
  turnover5Count: number;
  turnover20Count: number;
  foreign5: number;
  foreign5Count: number;
  institution5: number;
  institution5Count: number;
  bothBuyTrue: number;
  bothBuyValid: number;
}

interface SectorFlowFrame {
  date: string;
  sectorCode: string;
  moneyFlow: number | null;
  turnoverShare5d: number | null;
  turnoverShare20d: number | null;
  bothBuy5d: number | null;
}

interface SectorFeatureInternal extends V8SectorFeaturePoint {}

interface PreparedTradeSeries {
  source: PortfolioSeries;
  scores: Array<number | null>;
}

interface Trade {
  year: number;
  market: V8SectorRotationMarket;
  entryThreshold: number;
  symbol: string;
  sectorCode: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  exitIndex: number;
  exitTiming: "OPEN" | "CLOSE";
  ret: number;
  excess: number | null;
  mae: number | null;
  mfe: number | null;
  holdingDays: number;
  features: V8SectorFeaturePoint | null;
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);
const average = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
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
function prefix(values: number[]) {
  const out = new Array<number>(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) out[i + 1] = out[i]! + values[i]!;
  return out;
}
function nullablePrefix(values: Array<number | null>) {
  return {
    sum: prefix(values.map((v) => finite(v) ? v : 0)),
    missing: prefix(values.map((v) => finite(v) ? 0 : 1)),
  };
}
function windowFromPrefix(sum: number[], endIndex: number, period: number) {
  const start = endIndex - period + 1;
  return start < 0 ? null : sum[endIndex + 1]! - sum[start]!;
}
function nullableWindow(sum: number[], missing: number[], endIndex: number, period: number) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  const miss = missing[endIndex + 1]! - missing[start]!;
  return miss > 0 ? null : sum[endIndex + 1]! - sum[start]!;
}
function ratio(trueCount: number, validCount: number) {
  return validCount ? (trueCount / validCount) * 100 : null;
}
export function percentileRankPctForSectorTest(sortedAsc: number[], value: number | null) {
  if (!finite(value) || !sortedAsc.length) return null;
  let below = 0;
  for (const x of sortedAsc) if (x < value) below++;
  return (below / sortedAsc.length) * 100;
}
function combineWeighted(parts: Array<{ weight: number; value: number | null }>) {
  const available = parts.filter((p) => finite(p.value));
  const w = available.reduce((s, p) => s + p.weight, 0);
  return w > 0 ? available.reduce((s, p) => s + p.weight * p.value!, 0) / w : null;
}
export function rotationScoreForSectorTest(price: number | null, flow: number | null, momentum: number | null) {
  return combineWeighted([
    { weight: DEFAULT_ROTATION_WEIGHTS.priceLeadership, value: price },
    { weight: DEFAULT_ROTATION_WEIGHTS.moneyFlow, value: flow },
    { weight: DEFAULT_ROTATION_WEIGHTS.rotationMomentum, value: momentum },
  ]);
}
export function sectorSelectionPassForTest(selection: V8SectorSelection, raw: number | null, rankPct: number | null) {
  if (selection === "ALL") return true;
  if (!finite(raw) || !finite(rankPct)) return false;
  if (selection === "TOP50") return rankPct >= 50;
  if (selection === "TOP25") return rankPct >= 75;
  if (selection === "RAW_GE60") return raw >= 60;
  if (selection === "RAW_GE70") return raw >= 70;
  if (selection === "Q1") return rankPct < 25;
  if (selection === "Q2") return rankPct >= 25 && rankPct < 50;
  if (selection === "Q3") return rankPct >= 50 && rankPct < 75;
  return rankPct >= 75;
}

function prepareFlowSeries(series: PortfolioSeries): PreparedFlowSeries {
  const foreign = nullablePrefix(series.bars.map((b) => b.foreignNetBuyValue));
  const institution = nullablePrefix(series.bars.map((b) => b.institutionNetBuyValue));
  return {
    source: series,
    turnoverPrefix: prefix(series.bars.map((b) => b.tradingValue)),
    foreignPrefix: foreign.sum,
    foreignNullPrefix: foreign.missing,
    institutionPrefix: institution.sum,
    institutionNullPrefix: institution.missing,
  };
}

function makeSectorFlowRaw(sectorCode: string): SectorFlowRaw {
  return {
    sectorCode,
    turnover5: 0,
    turnover20: 0,
    turnover5Count: 0,
    turnover20Count: 0,
    foreign5: 0,
    foreign5Count: 0,
    institution5: 0,
    institution5Count: 0,
    bothBuyTrue: 0,
    bothBuyValid: 0,
  };
}

function buildSectorFlowFrames(
  dataset: MarketDataset,
  series: PortfolioSeries[],
): { frames: Map<string, SectorFlowFrame>; dates: string[]; sectorCodes: string[] } {
  const kospiDates = dataset.indexSeries
    .find((s) => s.indexCode.toUpperCase() === "KOSPI")
    ?.bars.map((b) => b.tradeDate) ?? [];
  const prepared = series.map(prepareFlowSeries);
  const sectorCodes = [...new Set(series.map((s) => s.sectorCode))].sort();
  const frames = new Map<string, SectorFlowFrame>();

  for (const date of kospiDates) {
    const rawBySector = new Map<string, SectorFlowRaw>();
    for (const item of prepared) {
      const i = item.source.dateIndex.get(date);
      if (i === undefined || i < 19) continue;
      const t5sum = windowFromPrefix(item.turnoverPrefix, i, 5);
      const t20sum = windowFromPrefix(item.turnoverPrefix, i, 20);
      const t5 = finite(t5sum) ? t5sum / 5 : null;
      const t20 = finite(t20sum) ? t20sum / 20 : null;
      const f5 = nullableWindow(item.foreignPrefix, item.foreignNullPrefix, i, 5);
      const ins5 = nullableWindow(item.institutionPrefix, item.institutionNullPrefix, i, 5);
      const code = item.source.sectorCode;
      const agg = rawBySector.get(code) ?? makeSectorFlowRaw(code);
      if (finite(t5)) { agg.turnover5 += t5; agg.turnover5Count++; }
      if (finite(t20)) { agg.turnover20 += t20; agg.turnover20Count++; }
      if (finite(f5)) { agg.foreign5 += f5; agg.foreign5Count++; }
      if (finite(ins5)) { agg.institution5 += ins5; agg.institution5Count++; }
      if (finite(f5) && finite(ins5)) {
        agg.bothBuyValid++;
        if (f5 > 0 && ins5 > 0) agg.bothBuyTrue++;
      }
      rawBySector.set(code, agg);
    }

    const raws = [...rawBySector.values()];
    const total5 = raws.reduce((s, r) => s + (r.turnover5Count ? r.turnover5 : 0), 0);
    const total20 = raws.reduce((s, r) => s + (r.turnover20Count ? r.turnover20 : 0), 0);
    const enriched = raws.map((r) => {
      const share5 = total5 > 0 ? (r.turnover5 / total5) * 100 : 0;
      const share20 = total20 > 0 ? (r.turnover20 / total20) * 100 : 0;
      const fgnIntensity = r.foreign5Count && r.turnover20Count && r.turnover20 > 0 ? r.foreign5 / r.turnover20 : null;
      const insIntensity = r.institution5Count && r.turnover20Count && r.turnover20 > 0 ? r.institution5 / r.turnover20 : null;
      return {
        ...r,
        share5,
        share20,
        shareChange: share5 - share20,
        fgnIntensity,
        insIntensity,
        bothBuy5d: ratio(r.bothBuyTrue, r.bothBuyValid),
      };
    });
    const fgnSorted = enriched.map((r) => r.fgnIntensity).filter(finite).sort((a, b) => a - b);
    const insSorted = enriched.map((r) => r.insIntensity).filter(finite).sort((a, b) => a - b);
    const shareSorted = enriched.map((r) => r.shareChange).filter(finite).sort((a, b) => a - b);

    for (const r of enriched) {
      const moneyFlow = combineWeighted([
        { weight: 25, value: percentileRankPctForSectorTest(fgnSorted, r.fgnIntensity) },
        { weight: 20, value: percentileRankPctForSectorTest(insSorted, r.insIntensity) },
        { weight: 10, value: r.bothBuy5d },
        { weight: 15, value: percentileRankPctForSectorTest(shareSorted, r.shareChange) },
      ]);
      frames.set(`${date}|${r.sectorCode}`, {
        date,
        sectorCode: r.sectorCode,
        moneyFlow,
        turnoverShare5d: r.share5,
        turnoverShare20d: r.share20,
        bothBuy5d: r.bothBuy5d,
      });
    }
  }

  return { frames, dates: kospiDates, sectorCodes };
}

function buildSectorFeatureMap(dataset: MarketDataset, limit: number) {
  const context = buildPortfolioSignalContext(dataset, limit);
  const { frames, dates, sectorCodes } = buildSectorFlowFrames(dataset, context.series);
  const featureMap = new Map<string, SectorFeatureInternal>();
  const dateIndex = new Map(dates.map((d, i) => [d, i]));

  for (const date of dates) {
    const di = dateIndex.get(date)!;
    const prevDate = di >= 5 ? dates[di - 5]! : null;
    const drafts = sectorCodes.map((sectorCode) => {
      const key = `${date}|${sectorCode}`;
      const flow = frames.get(key);
      const pl = context.sectorPriceLeadershipByDate.get(key) ?? null;
      const prevKey = prevDate ? `${prevDate}|${sectorCode}` : null;
      const prevFlow = prevKey ? frames.get(prevKey) : null;
      const prevPl = prevKey ? context.sectorPriceLeadershipByDate.get(prevKey) ?? null : null;
      const priceChange = finite(pl) && finite(prevPl) ? pl - prevPl : null;
      const flowChange = finite(flow?.moneyFlow ?? null) && finite(prevFlow?.moneyFlow ?? null)
        ? flow!.moneyFlow! - prevFlow!.moneyFlow!
        : null;
      const shareChange5d = finite(flow?.turnoverShare5d ?? null) && finite(flow?.turnoverShare20d ?? null)
        ? flow!.turnoverShare5d! - flow!.turnoverShare20d!
        : null;
      const bothBreadthChange = finite(flow?.bothBuy5d ?? null) && finite(prevFlow?.bothBuy5d ?? null)
        ? flow!.bothBuy5d! - prevFlow!.bothBuy5d!
        : null;
      return { sectorCode, pl, flow, priceChange, flowChange, shareChange5d, bothBreadthChange };
    });

    const changeSorted = [
      drafts.map((d) => d.priceChange).filter(finite).sort((a, b) => a - b),
      drafts.map((d) => d.flowChange).filter(finite).sort((a, b) => a - b),
      drafts.map((d) => d.shareChange5d).filter(finite).sort((a, b) => a - b),
      drafts.map((d) => d.bothBreadthChange).filter(finite).sort((a, b) => a - b),
    ];
    const scored = drafts.map((d) => {
      const momentumParts = [d.priceChange, d.flowChange, d.shareChange5d, d.bothBreadthChange]
        .map((v, i) => percentileRankPctForSectorTest(changeSorted[i]!, v))
        .filter(finite);
      const momentum = average(momentumParts);
      const rotation = rotationScoreForSectorTest(d.pl, d.flow?.moneyFlow ?? null, momentum);
      return {
        ...d,
        momentum,
        rotation,
      };
    });

    const plSorted = scored.map((d) => d.pl).filter(finite).sort((a, b) => a - b);
    const flowSorted = scored.map((d) => d.flow?.moneyFlow ?? null).filter(finite).sort((a, b) => a - b);
    const momentumSorted = scored.map((d) => d.momentum).filter(finite).sort((a, b) => a - b);
    const rotationSorted = scored.map((d) => d.rotation).filter(finite).sort((a, b) => a - b);

    for (const d of scored) {
      const key = `${date}|${d.sectorCode}`;
      featureMap.set(key, {
        date,
        sectorCode: d.sectorCode,
        priceLeadership: d.pl,
        moneyFlow: d.flow?.moneyFlow ?? null,
        rotationMomentum: d.momentum,
        rotationScore: d.rotation,
        priceLeadershipRankPct: percentileRankPctForSectorTest(plSorted, d.pl),
        moneyFlowRankPct: percentileRankPctForSectorTest(flowSorted, d.flow?.moneyFlow ?? null),
        rotationMomentumRankPct: percentileRankPctForSectorTest(momentumSorted, d.momentum),
        rotationScoreRankPct: percentileRankPctForSectorTest(rotationSorted, d.rotation),
        turnoverShare5d: d.flow?.turnoverShare5d ?? null,
        turnoverShare20d: d.flow?.turnoverShare20d ?? null,
        bothBuy5d: d.flow?.bothBuy5d ?? null,
      });
    }
  }

  return { context, featureMap, dates, sectorCodes };
}

function factorValues(point: V8SectorFeaturePoint | null, factor: V8SectorFactor) {
  if (!point) return { raw: null, rank: null };
  if (factor === "PRICE_LEADERSHIP") return { raw: point.priceLeadership, rank: point.priceLeadershipRankPct };
  if (factor === "MONEY_FLOW") return { raw: point.moneyFlow, rank: point.moneyFlowRankPct };
  if (factor === "ROTATION_MOMENTUM") return { raw: point.rotationMomentum, rank: point.rotationMomentumRankPct };
  return { raw: point.rotationScore, rank: point.rotationScoreRankPct };
}

function benchmarkMaps(dataset: MarketDataset) {
  const out = new Map<V8SectorRotationMarket, Map<string, DailyPrice>>();
  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    const series = dataset.indexSeries.find((item) => item.indexCode.toUpperCase() === market);
    out.set(market, new Map((series?.bars ?? []).map((bar) => [bar.tradeDate, bar])));
  }
  return out;
}

function benchmarkReturn(
  maps: Map<V8SectorRotationMarket, Map<string, DailyPrice>>,
  market: V8SectorRotationMarket,
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
  let low = entryPrice;
  let high = entryPrice;
  for (let i = entryIndex; i <= exitIndex; i++) {
    const bar = bars[i];
    if (!bar) break;
    if (i === exitIndex && timing === "OPEN") {
      low = Math.min(low, exitPrice);
      high = Math.max(high, exitPrice);
      continue;
    }
    if (finite(bar.low) && bar.low > 0) low = Math.min(low, bar.low);
    if (finite(bar.high) && bar.high > 0) high = Math.max(high, bar.high);
  }
  return {
    mae: (low / entryPrice - 1) * 100,
    mfe: (high / entryPrice - 1) * 100,
  };
}

function simulateTrade(
  item: PreparedTradeSeries,
  signalIndex: number,
  market: V8SectorRotationMarket,
  entryThreshold: number,
  benchmarks: Map<V8SectorRotationMarket, Map<string, DailyPrice>>,
  roundTripCostBps: number,
  featureMap: Map<string, SectorFeatureInternal>,
): Trade | null {
  const bars = item.source.bars;
  const entryIndex = signalIndex + 1;
  const plannedExit = signalIndex + V8_SECTOR_ROTATION_MAX_HOLDING;
  const entry = bars[entryIndex];
  if (!entry || plannedExit >= bars.length || !finite(entry.open) || entry.open <= 0) return null;
  let exitIndex = -1;
  let exitPrice = 0;
  let exitTiming: "OPEN" | "CLOSE" = "CLOSE";
  for (let j = entryIndex; j <= plannedExit; j++) {
    const bar = bars[j];
    if (!bar || ![bar.open, bar.close, bar.low, bar.high].every((v) => finite(v) && v > 0)) return null;
    if (j > entryIndex) {
      const si = j - 1;
      const prev = item.scores[si - 1] ?? null;
      const cur = item.scores[si] ?? null;
      if (crossedDownPercentForTest(prev, cur, V8_SECTOR_ROTATION_DOWNSIDE_EXIT)) {
        exitIndex = j;
        exitPrice = bar.open;
        exitTiming = "OPEN";
        break;
      }
      if (crossedUpPercentForTest(prev, cur, V8_SECTOR_ROTATION_UPSIDE_EXIT)) {
        exitIndex = j;
        exitPrice = bar.open;
        exitTiming = "OPEN";
        break;
      }
    }
    if (j === plannedExit) {
      exitIndex = j;
      exitPrice = bar.close;
      exitTiming = "CLOSE";
    }
  }
  if (exitIndex < 0 || exitPrice <= 0) return null;
  const exitDate = bars[exitIndex]!.tradeDate;
  const ret = (exitPrice / entry.open - 1) * 100 - roundTripCostBps / 100;
  const bench = benchmarkReturn(benchmarks, market, entry.tradeDate, exitDate, exitTiming);
  const ex = excursion(bars, entryIndex, exitIndex, entry.open, exitPrice, exitTiming);
  const signalDate = bars[signalIndex]!.tradeDate;
  return {
    year: Number(signalDate.slice(0, 4)),
    market,
    entryThreshold,
    symbol: item.source.symbol,
    sectorCode: item.source.sectorCode,
    signalDate,
    entryDate: entry.tradeDate,
    exitDate,
    exitIndex,
    exitTiming,
    ret,
    excess: finite(bench) ? ret - bench : null,
    mae: ex.mae,
    mfe: ex.mfe,
    holdingDays: exitIndex - entryIndex + 1,
    features: featureMap.get(`${signalDate}|${item.source.sectorCode}`) ?? null,
  };
}

function metricRow(
  meta: { year: number; market: V8SectorRotationMarket; entryThreshold: number; factor: "CONTROL" | V8SectorFactor; selection: V8SectorSelection },
  base: Trade[],
  selected: Trade[],
): V8SectorRotationMetricRow {
  const factorPairs = meta.factor === "CONTROL"
    ? []
    : selected.map((trade) => factorValues(trade.features, meta.factor)).filter((v) => finite(v.raw) && finite(v.rank));
  const returns = selected.map((t) => t.ret);
  const excess = selected.map((t) => t.excess).filter(finite);
  const positive = returns.filter((v) => v > 0).length;
  const excessPositive = excess.filter((v) => v > 0).length;
  const profits = returns.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const losses = returns.filter((v) => v < 0).reduce((a, b) => a + Math.abs(b), 0);
  const daily = new Map<string, { sum: number; n: number }>();
  for (const trade of selected) {
    if (!finite(trade.excess)) continue;
    const d = daily.get(trade.signalDate) ?? { sum: 0, n: 0 };
    d.sum += trade.excess;
    d.n++;
    daily.set(trade.signalDate, d);
  }
  const hac = neweyWestMeanForExitTest([...daily.values()].map((v) => v.sum / v.n), V8_SECTOR_ROTATION_MAX_HOLDING - 1);
  const availableTrades = meta.factor === "CONTROL"
    ? base.length
    : base.filter((trade) => {
        const v = factorValues(trade.features, meta.factor);
        return finite(v.raw) && finite(v.rank);
      }).length;
  return {
    ...meta,
    baseTrades: base.length,
    availableTrades,
    acceptedTrades: selected.length,
    retainedRate: base.length ? round((selected.length / base.length) * 100) : null,
    avgFactorRaw: factorPairs.length ? round(average(factorPairs.map((v) => v.raw!))) : null,
    avgFactorRankPct: factorPairs.length ? round(average(factorPairs.map((v) => v.rank!))) : null,
    avgReturn: round(average(returns)),
    medianReturn: round(median(returns)),
    winRate: returns.length ? round((positive / returns.length) * 100) : null,
    profitFactor: losses > 0 ? round(profits / losses) : profits > 0 ? null : 0,
    avgExcessReturn: round(average(excess)),
    medianExcessReturn: round(median(excess)),
    excessWinRate: excess.length ? round((excessPositive / excess.length) * 100) : null,
    avgMae: round(average(selected.map((t) => t.mae).filter(finite))),
    avgMfe: round(average(selected.map((t) => t.mfe).filter(finite))),
    avgHoldingDays: round(average(selected.map((t) => t.holdingDays))),
    dailyAvgExcessHacMean: round(hac.mean),
    dailyAvgExcessHacT: round(hac.t),
    dailyAvgExcessCiLow: round(hac.ciLow),
    dailyAvgExcessCiHigh: round(hac.ciHigh),
  };
}

export function buildV8SectorRotationValidation(
  dataset: MarketDataset,
  options: V8SectorRotationOptions = {},
): V8SectorRotationResult | null {
  const limit = Math.max(1, Math.round(options.limit ?? 613));
  const warmupDays = Math.max(120, Math.round(options.warmupDays ?? 120));
  const roundTripCostBps = Math.max(0, options.roundTripCostBps ?? 0);
  const years = [...new Set(options.years ?? [2018, 2022, 2025])].sort((a, b) => a - b);
  const marketEntryThresholds: Record<V8SectorRotationMarket, number[]> = {
    KOSPI: [...new Set(options.marketEntryThresholds?.KOSPI ?? [75, 80])].sort((a, b) => a - b),
    KOSDAQ: [...new Set(options.marketEntryThresholds?.KOSDAQ ?? [75, 80])].sort((a, b) => a - b),
  };
  const built = buildSectorFeatureMap(dataset, limit);
  if (!built.context.series.length || !built.dates.length) return null;
  const benchmarks = benchmarkMaps(dataset);
  const prepared: PreparedTradeSeries[] = built.context.series.map((source) => ({
    source,
    scores: source.baseScores.map((base, i) => finite(base)
      ? adjustSectorPenaltyScore(
          base,
          source.sectorPriceLeadership[i] ?? null,
          V8_SECTOR_ROTATION_PL_OVERHEAT_THRESHOLD,
        ).score
      : null),
  }));
  const trades: Trade[] = [];

  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    for (const entryThreshold of marketEntryThresholds[market]) {
      for (const item of prepared) {
        if (item.source.market !== market) continue;
        let lastExitIndex = -1;
        let lastExitTiming: "OPEN" | "CLOSE" | null = null;
        for (let i = warmupDays; i + 1 < item.source.bars.length; i++) {
          const prev = item.scores[i - 1] ?? null;
          const cur = item.scores[i] ?? null;
          if (!crossedUpPercentForTest(prev, cur, entryThreshold)) continue;
          const date = item.source.bars[i]!.tradeDate;
          const year = Number(date.slice(0, 4));
          const curPct = finite(cur) ? cur * 10 : null;
          if (curPct !== null && curPct >= V8_SECTOR_ROTATION_UPSIDE_EXIT) continue;
          if (shouldBlockOnsetForTest(i, lastExitIndex, lastExitTiming)) continue;
          const trade = simulateTrade(item, i, market, entryThreshold, benchmarks, roundTripCostBps, built.featureMap);
          if (!trade) continue;
          if (years.includes(year)) trades.push(trade);
          lastExitIndex = trade.exitIndex;
          lastExitTiming = trade.exitTiming;
        }
      }
    }
  }

  const factors: V8SectorFactor[] = ["PRICE_LEADERSHIP", "ROTATION_SCORE", "MONEY_FLOW", "ROTATION_MOMENTUM"];
  const selections: Exclude<V8SectorSelection, "ALL">[] = ["TOP50", "TOP25", "RAW_GE60", "RAW_GE70", "Q1", "Q2", "Q3", "Q4"];
  const rows: V8SectorRotationMetricRow[] = [];
  for (const year of years) {
    for (const market of ["KOSPI", "KOSDAQ"] as const) {
      for (const entryThreshold of marketEntryThresholds[market]) {
        const base = trades.filter((t) => t.year === year && t.market === market && t.entryThreshold === entryThreshold);
        rows.push(metricRow({ year, market, entryThreshold, factor: "CONTROL", selection: "ALL" }, base, base));
        for (const factor of factors) {
          for (const selection of selections) {
            const selected = base.filter((trade) => {
              const v = factorValues(trade.features, factor);
              return sectorSelectionPassForTest(selection, v.raw, v.rank);
            });
            rows.push(metricRow({ year, market, entryThreshold, factor, selection }, base, selected));
          }
        }
      }
    }
  }

  const featureCoverage = years.flatMap((year) => factors.map((factor) => {
    const points = [...built.featureMap.values()].filter((p) => Number(p.date.slice(0, 4)) === year);
    const available = points.filter((p) => finite(factorValues(p, factor).raw)).length;
    return {
      year,
      factor,
      observations: points.length,
      available,
      availabilityRate: points.length ? round((available / points.length) * 100) : null,
    };
  }));
  const latestDate = built.dates.at(-1) ?? dataset.asOfDate;
  const latestSectorFeatures: V8SectorRotationParityRow[] = built.sectorCodes.map((sectorCode) => {
    const p = built.featureMap.get(`${latestDate}|${sectorCode}`);
    return {
      sectorCode,
      priceLeadership: p?.priceLeadership ?? null,
      moneyFlow: p?.moneyFlow ?? null,
      rotationMomentum: p?.rotationMomentum ?? null,
      rotationScore: p?.rotationScore ?? null,
    };
  });

  return {
    version: V8_SECTOR_ROTATION_VERSION,
    from: built.dates[0] ?? dataset.asOfDate,
    to: built.dates.at(-1) ?? dataset.asOfDate,
    symbolCount: built.context.series.length,
    sectorCount: built.sectorCodes.length,
    warmupDays,
    roundTripCostBps,
    years,
    marketEntryThresholds,
    scorePolicy: {
      scoreMax: 10,
      baseScoreMax: 9.5,
      sectorSlotPoints: 0.5,
      priceLeadershipOverheatThreshold: 80,
      policy: "UNCHANGED_V8_10_POINT_SCORE",
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
    sectorPolicy: {
      rotationWeights: { ...DEFAULT_ROTATION_WEIGHTS },
      comparison: "PL_VS_FULL_ROTATION_WITH_EQUAL_CROSS_SECTIONAL_RANK_FILTERS",
      rankSelections: ["TOP50", "TOP25"],
      rawSelections: ["RAW_GE60", "RAW_GE70"],
      quartiles: ["Q1", "Q2", "Q3", "Q4"],
      useAtSignalCloseOnly: true,
    },
    featureCoverage,
    latestSectorFeatures,
    rows,
    notes: [
      "The existing 10-point stock score is held fixed. Sector factors are diagnostic entry overlays only and do not refit stock-score weights.",
      "Price Leadership is the exact historical PL series already used by the V8 sector slot. Full Rotation Score uses the existing 40% PL / 45% Money Flow / 15% Rotation Momentum weights.",
      "Money Flow uses foreign 5D intensity, institution 5D intensity, simultaneous foreign+institution 5D buying breadth, and 5D-vs-20D turnover-share change, with missing components reweighted rather than zero-filled.",
      "Rotation Momentum uses cross-sector percentiles of 5D PL change, 5D Money Flow change, current 5D-vs-20D turnover-share spread, and 5D change in simultaneous-buy breadth.",
      "TOP50 and TOP25 use same-date cross-sectional sector ranks, allowing a scale-neutral PL-vs-Rotation comparison. RAW_GE60/70 are secondary diagnostics.",
      "All sector values use only information available at the signal-date close. Entry executes next open; score exits execute next open; time exit uses the 60th trading-day close.",
    ],
  };
}
