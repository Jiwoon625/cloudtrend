import { computeIndicators } from "./indicators";
import { historicalTechnicalScore } from "./scoring";
import type { MarketDataset } from "./dataset";
import type { DailyPrice, Instrument } from "./types";

export type PortfolioMarketCode = "KOSPI" | "KOSDAQ";
export type PortfolioExitReason = "UPSIDE_SCORE" | "DOWNSIDE_SCORE" | "TIME";
export type PortfolioExitTiming = "OPEN" | "CLOSE";

export interface PortfolioStrategyDefinition {
  id: string;
  group: "A" | "B" | "C" | "D";
  label: string;
  priceLeadershipOverheatThreshold: number | null;
  entryThreshold: number;
  upsideExitThreshold: number;
  downsideExitThreshold: number;
  maxHoldingDays: number;
}

export interface PortfolioSeries {
  symbol: string;
  name: string;
  market: PortfolioMarketCode;
  sectorCode: string;
  sectorName: string;
  bars: DailyPrice[];
  dateIndex: Map<string, number>;
  baseScores: Array<number | null>;
  sectorPriceLeadership: Array<number | null>;
}

export interface PortfolioCandidateTrade {
  scenarioId: string;
  symbol: string;
  name: string;
  market: PortfolioMarketCode;
  sectorCode: string;
  sectorName: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  signalIndex: number;
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: PortfolioExitReason;
  exitTiming: PortfolioExitTiming;
  holdingDays: number;
  adjustedScore10: number;
  baseScore9p5: number | null;
  scoreRise5d: number | null;
  sectorPriceLeadership: number | null;
  sectorOverheated: boolean | null;
  signalTradingValue: number;
  grossReturn: number;
  mae: number | null;
  mfe: number | null;
}

export const PORTFOLIO_FEATURE_CACHE_VERSION = "sector-v8-features-v1" as const;

export interface PortfolioFeatureCache {
  version: typeof PORTFOLIO_FEATURE_CACHE_VERSION;
  limit: number;
  datasetVersion: string;
  asOfDate: string;
  series: Array<{
    symbol: string;
    barCount: number;
    firstDate: string;
    lastDate: string;
    baseScores: Array<number | null>;
  }>;
  sectorPriceLeadership: Array<[string, number]>;
}

export interface PortfolioSignalContext {
  series: PortfolioSeries[];
  sectorPriceLeadershipByDate: Map<string, number>;
  allDates: string[];
  symbolCount: number;
  sectorCount: number;
  featureCacheUsed: boolean;
  featureCacheVersion: typeof PORTFOLIO_FEATURE_CACHE_VERSION;
}

const SCORE_MAX = 10;
const SECTOR_SLOT = 0.5;
const SECTOR_PENALTY = 0.5;

export const PORTFOLIO_STRATEGIES: PortfolioStrategyDefinition[] = [
  { id: "baseline-e75-u90-d30-h30", group: "A", label: "baseline · 75 onset · ↑90 / ↓30 · 30D", priceLeadershipOverheatThreshold: null, entryThreshold: 75, upsideExitThreshold: 90, downsideExitThreshold: 30, maxHoldingDays: 30 },
  { id: "pl80-e75-u90-d30-h30", group: "A", label: "PL≥80 · 75 onset · ↑90 / ↓30 · 30D", priceLeadershipOverheatThreshold: 80, entryThreshold: 75, upsideExitThreshold: 90, downsideExitThreshold: 30, maxHoldingDays: 30 },
  { id: "pl70-e75-u95-d25-h40", group: "B", label: "PL≥70 · 75 onset · ↑95 / ↓25 · 40D", priceLeadershipOverheatThreshold: 70, entryThreshold: 75, upsideExitThreshold: 95, downsideExitThreshold: 25, maxHoldingDays: 40 },
  { id: "pl75-e75-u95-d25-h40", group: "B", label: "PL≥75 · 75 onset · ↑95 / ↓25 · 40D", priceLeadershipOverheatThreshold: 75, entryThreshold: 75, upsideExitThreshold: 95, downsideExitThreshold: 25, maxHoldingDays: 40 },
  { id: "pl80-e75-u95-d25-h40", group: "B", label: "PL≥80 · 75 onset · ↑95 / ↓25 · 40D", priceLeadershipOverheatThreshold: 80, entryThreshold: 75, upsideExitThreshold: 95, downsideExitThreshold: 25, maxHoldingDays: 40 },
  { id: "pl85-e75-u95-d25-h40", group: "B", label: "PL≥85 · 75 onset · ↑95 / ↓25 · 40D", priceLeadershipOverheatThreshold: 85, entryThreshold: 75, upsideExitThreshold: 95, downsideExitThreshold: 25, maxHoldingDays: 40 },
  { id: "pl75-e75-u95-d30-h40", group: "C", label: "PL≥75 · 75 onset · ↑95 / ↓30 · 40D", priceLeadershipOverheatThreshold: 75, entryThreshold: 75, upsideExitThreshold: 95, downsideExitThreshold: 30, maxHoldingDays: 40 },
  { id: "pl80-e75-u95-d30-h40", group: "C", label: "PL≥80 · 75 onset · ↑95 / ↓30 · 40D", priceLeadershipOverheatThreshold: 80, entryThreshold: 75, upsideExitThreshold: 95, downsideExitThreshold: 30, maxHoldingDays: 40 },
  { id: "pl70-e65-u95-d25-h40", group: "D", label: "PL≥70 · 65 onset · ↑95 / ↓25 · 40D", priceLeadershipOverheatThreshold: 70, entryThreshold: 65, upsideExitThreshold: 95, downsideExitThreshold: 25, maxHoldingDays: 40 },
  { id: "pl75-e65-u95-d25-h40", group: "D", label: "PL≥75 · 65 onset · ↑95 / ↓25 · 40D", priceLeadershipOverheatThreshold: 75, entryThreshold: 65, upsideExitThreshold: 95, downsideExitThreshold: 25, maxHoldingDays: 40 },
];

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function median(xs: number[]) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2; }
function prefix(values: number[]) { const out = new Array<number>(values.length + 1).fill(0); for (let i = 0; i < values.length; i++) out[i + 1] = out[i]! + values[i]!; return out; }
function windowSum(sum: number[], endIndex: number, period: number) { const start = endIndex - period + 1; return start < 0 ? null : sum[endIndex + 1]! - sum[start]!; }
function periodReturn(bars: DailyPrice[], endIndex: number, period: number) { const past = bars[endIndex - period]?.close; const cur = bars[endIndex]?.close; return finite(past) && finite(cur) && past > 0 ? cur / past - 1 : null; }
function ratio(t: number, n: number) { return n ? (t / n) * 100 : null; }
function avgRatio(values: Array<number | null>) { const valid = values.filter(finite).map((v) => v / 100); return mean(valid); }
function percentileRatio(sortedAsc: number[], value: number | null) { if (!finite(value) || !sortedAsc.length) return null; let below = 0; for (const x of sortedAsc) if (x < value) below++; return below / sortedAsc.length; }
function combine(parts: Array<{ weight: number; ratio: number | null }>) { const available = parts.filter((p) => finite(p.ratio)); const w = available.reduce((s, p) => s + p.weight, 0); return w ? available.reduce((s, p) => s + p.weight * (p.ratio ?? 0), 0) / w * 100 : null; }
function percent(score: number | null | undefined) { return finite(score) ? score / SCORE_MAX * 100 : null; }
function crossedUp(prev: number | null | undefined, cur: number | null | undefined, threshold: number) { const p = percent(prev); const c = percent(cur); return p !== null && c !== null && p < threshold && c >= threshold; }
function crossedDown(prev: number | null | undefined, cur: number | null | undefined, threshold: number) { const p = percent(prev); const c = percent(cur); return p !== null && c !== null && p >= threshold && c < threshold; }

function rollingHigh(bars: DailyPrice[], window = 250, minimum = 60) {
  const out = new Array<number>(bars.length).fill(Number.NaN); const deque: number[] = []; let head = 0;
  for (let i = 0; i < bars.length; i++) {
    while (head < deque.length && deque[head]! < i - window + 1) head++;
    while (deque.length > head && bars[deque[deque.length - 1]!]!.high <= bars[i]!.high) deque.pop();
    deque.push(i); if (i >= minimum - 1) out[i] = bars[deque[head]!]!.high;
    if (head > 256 && head * 2 > deque.length) { deque.splice(0, head); head = 0; }
  }
  return out;
}

interface Prepared { instrument: Instrument; bars: DailyPrice[]; dateIndex: Map<string, number>; closePrefix: number[]; turnoverPrefix: number[]; rollingHigh250: number[]; }
interface Agg { sectorCode: string; sectorName: string; r20: number[]; r60: number[]; r120: number[]; turnover5: number; turnover20: number; turnover5Count: number; turnover20Count: number; aboveMa20True: number; aboveMa20Valid: number; aboveMa60True: number; aboveMa60Valid: number; aboveMa120True: number; aboveMa120Valid: number; maAlignedTrue: number; maAlignedValid: number; nearHighTrue: number; nearHighValid: number; advancingTrue: number; advancingValid: number; }
interface RawSector { sectorCode: string; rs20: number | null; rs60: number | null; rs120: number | null; relativeTurnover: number | null; advancing: number | null; aboveMa20: number | null; aboveMa60: number | null; aboveMa120: number | null; maAligned: number | null; nearHigh: number | null; }

function prep(instrument: Instrument, bars: DailyPrice[]): Prepared { return { instrument, bars, dateIndex: new Map(bars.map((b, i) => [b.tradeDate, i])), closePrefix: prefix(bars.map((b) => b.close)), turnoverPrefix: prefix(bars.map((b) => b.tradingValue)), rollingHigh250: rollingHigh(bars) }; }
function createAgg(code: string, name: string): Agg { return { sectorCode: code, sectorName: name, r20: [], r60: [], r120: [], turnover5: 0, turnover20: 0, turnover5Count: 0, turnover20Count: 0, aboveMa20True: 0, aboveMa20Valid: 0, aboveMa60True: 0, aboveMa60Valid: 0, aboveMa120True: 0, aboveMa120Valid: 0, maAlignedTrue: 0, maAlignedValid: 0, nearHighTrue: 0, nearHighValid: 0, advancingTrue: 0, advancingValid: 0 }; }
function addBool(agg: Agg, key: "aboveMa20" | "aboveMa60" | "aboveMa120" | "maAligned" | "nearHigh" | "advancing", value: boolean | null) { if (value === null) return; (agg[`${key}True` as keyof Agg] as number) += value ? 1 : 0; (agg[`${key}Valid` as keyof Agg] as number) += 1; }

function buildSectorPriceLeadershipMap(dataset: MarketDataset) {
  const kospi = dataset.indexSeries.find((s) => s.indexCode === "KOSPI");
  if (!kospi || kospi.bars.length < 130) return new Map<string, number>();
  const sectorNames = new Map(dataset.sectors.map((s) => [s.code, s.name]));
  const prepared = dataset.instruments.filter((inst) => inst.instrumentType === "STOCK" && inst.isActive && inst.sectorCode !== "MARKET_IDX" && inst.sectorCode !== "ETC").map((inst) => prep(inst, dataset.bars[inst.symbol] ?? [])).filter((x) => x.bars.length >= 130);
  const out = new Map<string, number>();
  for (let mi = 120; mi < kospi.bars.length; mi++) {
    const date = kospi.bars[mi]!.tradeDate; const mr20 = periodReturn(kospi.bars, mi, 20); const mr60 = periodReturn(kospi.bars, mi, 60); const mr120 = periodReturn(kospi.bars, mi, 120); const aggs = new Map<string, Agg>();
    for (const item of prepared) {
      const i = item.dateIndex.get(date); if (i === undefined || i < 120) continue; const bar = item.bars[i]!; const prev = item.bars[i - 1]; if (!prev) continue;
      const ma = (p: number) => { const v = windowSum(item.closePrefix, i, p); return v === null ? null : v / p; }; const tv = (p: number) => { const v = windowSum(item.turnoverPrefix, i, p); return v === null ? null : v / p; };
      const ma20 = ma(20), ma60 = ma(60), ma120 = ma(120), tv5 = tv(5), tv20 = tv(20); const code = item.instrument.sectorCode; const agg = aggs.get(code) ?? createAgg(code, sectorNames.get(code) ?? item.instrument.sectorName);
      const r20 = periodReturn(item.bars, i, 20), r60 = periodReturn(item.bars, i, 60), r120 = periodReturn(item.bars, i, 120); if (finite(r20)) agg.r20.push(r20); if (finite(r60)) agg.r60.push(r60); if (finite(r120)) agg.r120.push(r120);
      if (finite(tv5)) { agg.turnover5 += tv5; agg.turnover5Count++; } if (finite(tv20)) { agg.turnover20 += tv20; agg.turnover20Count++; }
      addBool(agg, "aboveMa20", ma20 === null ? null : bar.close > ma20); addBool(agg, "aboveMa60", ma60 === null ? null : bar.close > ma60); addBool(agg, "aboveMa120", ma120 === null ? null : bar.close > ma120); addBool(agg, "maAligned", ma20 === null || ma60 === null || ma120 === null ? null : ma20 > ma60 && ma60 > ma120); addBool(agg, "nearHigh", Number.isFinite(item.rollingHigh250[i]) ? bar.close >= item.rollingHigh250[i]! * 0.95 : null); addBool(agg, "advancing", bar.close > prev.close); aggs.set(code, agg);
    }
    const raw: RawSector[] = [...aggs.values()].map((a) => { const e20 = median(a.r20), e60 = median(a.r60), e120 = median(a.r120); return { sectorCode: a.sectorCode, rs20: finite(e20) && finite(mr20) ? (e20 - mr20) * 100 : null, rs60: finite(e60) && finite(mr60) ? (e60 - mr60) * 100 : null, rs120: finite(e120) && finite(mr120) ? (e120 - mr120) * 100 : null, relativeTurnover: a.turnover20Count && a.turnover5Count && a.turnover20 > 0 ? a.turnover5 / a.turnover20 : null, advancing: ratio(a.advancingTrue, a.advancingValid), aboveMa20: ratio(a.aboveMa20True, a.aboveMa20Valid), aboveMa60: ratio(a.aboveMa60True, a.aboveMa60Valid), aboveMa120: ratio(a.aboveMa120True, a.aboveMa120Valid), maAligned: ratio(a.maAlignedTrue, a.maAlignedValid), nearHigh: ratio(a.nearHighTrue, a.nearHighValid) }; });
    const rs20s = raw.map((r) => r.rs20).filter(finite).sort((a, b) => a - b), rs60s = raw.map((r) => r.rs60).filter(finite).sort((a, b) => a - b), rs120s = raw.map((r) => r.rs120).filter(finite).sort((a, b) => a - b);
    for (const r of raw) {
      const trend = avgRatio([r.aboveMa20, r.aboveMa60, r.aboveMa120]); const breadth = avgRatio([r.advancing, r.aboveMa20, r.maAligned]);
      const price = combine([{ weight: 20, ratio: percentileRatio(rs20s, r.rs20) }, { weight: 20, ratio: percentileRatio(rs60s, r.rs60) }, { weight: 10, ratio: percentileRatio(rs120s, r.rs120) }, { weight: 15, ratio: trend }, { weight: 20, ratio: breadth }, { weight: 10, ratio: r.nearHigh === null ? null : r.nearHigh / 100 }, { weight: 5, ratio: r.relativeTurnover === null ? null : Math.min(1, Math.max(0, (r.relativeTurnover - 0.7) / 0.8)) }]);
      if (finite(price)) out.set(`${date}|${r.sectorCode}`, price);
    }
  }
  return out;
}

function selectInstruments(dataset: MarketDataset, limit: number) {
  return [...dataset.instruments]
    .filter((inst) => inst.instrumentType === "STOCK")
    .sort((a, b) => (dataset.bars[b.symbol]?.at(-1)?.tradingValue ?? 0) - (dataset.bars[a.symbol]?.at(-1)?.tradingValue ?? 0))
    .slice(0, limit);
}

function makeSeries(inst: Instrument, bars: DailyPrice[], baseScores: Array<number | null>): PortfolioSeries {
  return { symbol: inst.symbol, name: inst.name, market: inst.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI", sectorCode: inst.sectorCode, sectorName: inst.sectorName, bars, dateIndex: new Map(bars.map((b, i) => [b.tradeDate, i])), baseScores, sectorPriceLeadership: new Array<number | null>(bars.length).fill(null) };
}

function buildBaseSeries(dataset: MarketDataset, limit: number) {
  return selectInstruments(dataset, limit).map((inst): PortfolioSeries | null => {
    const bars = dataset.bars[inst.symbol] ?? []; if (bars.length < 130) return null; const baseScores = new Array<number | null>(bars.length).fill(null);
    for (let i = 120; i < bars.length; i++) baseScores[i] = historicalTechnicalScore(computeIndicators(bars, i)).points;
    return makeSeries(inst, bars, baseScores);
  }).filter((x): x is PortfolioSeries => x !== null);
}

function restoreBaseSeriesFromCache(dataset: MarketDataset, limit: number, cache: PortfolioFeatureCache) {
  if (cache.version !== PORTFOLIO_FEATURE_CACHE_VERSION || cache.limit !== limit || cache.datasetVersion !== dataset.version || cache.asOfDate !== dataset.asOfDate) return null;
  const cached = new Map(cache.series.map((item) => [item.symbol, item])); const restored: PortfolioSeries[] = [];
  for (const inst of selectInstruments(dataset, limit)) {
    const bars = dataset.bars[inst.symbol] ?? []; if (bars.length < 130) continue; const item = cached.get(inst.symbol);
    if (!item || item.barCount !== bars.length || item.baseScores.length !== bars.length || item.firstDate !== bars[0]?.tradeDate || item.lastDate !== bars.at(-1)?.tradeDate) return null;
    restored.push(makeSeries(inst, bars, item.baseScores));
  }
  return restored.length ? restored : null;
}

function attachSectorPriceLeadership(source: PortfolioSeries[], sectorPrice: Map<string, number>) {
  for (const s of source) for (let i = 0; i < s.bars.length; i++) s.sectorPriceLeadership[i] = sectorPrice.get(`${s.bars[i]!.tradeDate}|${s.sectorCode}`) ?? null;
  return source;
}

export function createPortfolioFeatureCache(context: PortfolioSignalContext, dataset: MarketDataset, limit: number): PortfolioFeatureCache {
  return {
    version: PORTFOLIO_FEATURE_CACHE_VERSION,
    limit,
    datasetVersion: dataset.version,
    asOfDate: dataset.asOfDate,
    series: context.series.map((s) => ({ symbol: s.symbol, barCount: s.bars.length, firstDate: s.bars[0]?.tradeDate ?? "", lastDate: s.bars.at(-1)?.tradeDate ?? "", baseScores: s.baseScores })),
    sectorPriceLeadership: [...context.sectorPriceLeadershipByDate.entries()],
  };
}

function adjustedScoreAt(s: PortfolioSeries, index: number, threshold: number | null) {
  const base = s.baseScores[index]; if (!finite(base)) return null; const sectorPl = s.sectorPriceLeadership[index] ?? null; const overheated = threshold !== null && sectorPl !== null && sectorPl >= threshold; return Math.min(10, Math.max(0, Math.round((base + SECTOR_SLOT - (overheated ? SECTOR_PENALTY : 0)) * 100) / 100));
}

function sectorOverheatedAt(s: PortfolioSeries, index: number, threshold: number | null) {
  if (threshold === null) return false; const pl = s.sectorPriceLeadership[index] ?? null; return pl === null ? null : pl >= threshold;
}

function scoreRise(s: PortfolioSeries, index: number, lag: number, threshold: number | null) {
  const cur = percent(adjustedScoreAt(s, index, threshold)); const prev = percent(adjustedScoreAt(s, index - lag, threshold)); return cur !== null && prev !== null ? cur - prev : null;
}

function excursion(s: PortfolioSeries, entryIndex: number, exitIndex: number, entryPrice: number, exitPrice: number, timing: PortfolioExitTiming) {
  let low = entryPrice, high = entryPrice; for (let i = entryIndex; i <= exitIndex; i++) { const bar = s.bars[i]; if (!bar) break; if (i === exitIndex && timing === "OPEN") { low = Math.min(low, exitPrice); high = Math.max(high, exitPrice); continue; } if (finite(bar.low) && bar.low > 0) low = Math.min(low, bar.low); if (finite(bar.high) && bar.high > 0) high = Math.max(high, bar.high); }
  return { mae: entryPrice > 0 ? (low / entryPrice - 1) * 100 : null, mfe: entryPrice > 0 ? (high / entryPrice - 1) * 100 : null };
}

function candidateFromSignal(s: PortfolioSeries, signalIndex: number, strategy: PortfolioStrategyDefinition): PortfolioCandidateTrade | null {
  const entryIndex = signalIndex + 1, plannedExit = signalIndex + strategy.maxHoldingDays, entry = s.bars[entryIndex]; if (!entry || !finite(entry.open) || entry.open <= 0) return null;
  let exitIndex = -1, exitPrice = 0; let exitReason: PortfolioExitReason = "TIME"; let exitTiming: PortfolioExitTiming = "CLOSE";
  for (let j = entryIndex; j <= Math.min(plannedExit, s.bars.length - 1); j++) {
    const bar = s.bars[j]!; if (![bar.open, bar.close, bar.low, bar.high].every((v) => finite(v) && v > 0)) return null;
    if (j > entryIndex) {
      const si = j - 1, prev = adjustedScoreAt(s, si - 1, strategy.priceLeadershipOverheatThreshold), cur = adjustedScoreAt(s, si, strategy.priceLeadershipOverheatThreshold);
      if (crossedDown(prev, cur, strategy.downsideExitThreshold)) { exitIndex = j; exitPrice = bar.open; exitReason = "DOWNSIDE_SCORE"; exitTiming = "OPEN"; break; }
      if (crossedUp(prev, cur, strategy.upsideExitThreshold)) { exitIndex = j; exitPrice = bar.open; exitReason = "UPSIDE_SCORE"; exitTiming = "OPEN"; break; }
    }
    if (j === plannedExit) { exitIndex = j; exitPrice = bar.close; break; }
  }
  if (exitIndex < 0 || exitPrice <= 0) return null; const ex = excursion(s, entryIndex, exitIndex, entry.open, exitPrice, exitTiming); const adjustedScore10 = adjustedScoreAt(s, signalIndex, strategy.priceLeadershipOverheatThreshold); if (!finite(adjustedScore10)) return null;
  return { scenarioId: strategy.id, symbol: s.symbol, name: s.name, market: s.market, sectorCode: s.sectorCode, sectorName: s.sectorName, signalDate: s.bars[signalIndex]!.tradeDate, entryDate: entry.tradeDate, exitDate: s.bars[exitIndex]!.tradeDate, signalIndex, entryIndex, exitIndex, entryPrice: entry.open, exitPrice, exitReason, exitTiming, holdingDays: exitIndex - entryIndex + 1, adjustedScore10, baseScore9p5: s.baseScores[signalIndex] ?? null, scoreRise5d: scoreRise(s, signalIndex, 5, strategy.priceLeadershipOverheatThreshold), sectorPriceLeadership: s.sectorPriceLeadership[signalIndex] ?? null, sectorOverheated: sectorOverheatedAt(s, signalIndex, strategy.priceLeadershipOverheatThreshold), signalTradingValue: s.bars[signalIndex]?.tradingValue ?? 0, grossReturn: (exitPrice / entry.open - 1) * 100, mae: ex.mae, mfe: ex.mfe };
}

export function buildPortfolioCandidates(series: PortfolioSeries[], strategy: PortfolioStrategyDefinition) {
  const out: PortfolioCandidateTrade[] = [];
  for (const s of series) for (let i = 1; i + 1 < s.bars.length; i++) {
    const prev = adjustedScoreAt(s, i - 1, strategy.priceLeadershipOverheatThreshold), curScore = adjustedScoreAt(s, i, strategy.priceLeadershipOverheatThreshold); if (!crossedUp(prev, curScore, strategy.entryThreshold)) continue; const cur = percent(curScore); if (cur === null || cur >= strategy.upsideExitThreshold) continue; const trade = candidateFromSignal(s, i, strategy); if (trade) out.push(trade);
  }
  return out;
}

export function buildPortfolioSignalContext(dataset: MarketDataset, limit = 613, cache?: PortfolioFeatureCache | null): PortfolioSignalContext {
  const normalizedLimit = Math.max(1, Math.round(limit)); const restored = cache ? restoreBaseSeriesFromCache(dataset, normalizedLimit, cache) : null; const source = restored ?? buildBaseSeries(dataset, normalizedLimit); const sectorPrice = restored && cache ? new Map(cache.sectorPriceLeadership) : buildSectorPriceLeadershipMap(dataset); attachSectorPriceLeadership(source, sectorPrice); const allDates = [...new Set(source.flatMap((s) => s.bars.map((b) => b.tradeDate)))].sort();
  return { series: source, sectorPriceLeadershipByDate: sectorPrice, allDates, symbolCount: source.length, sectorCount: new Set(source.map((s) => s.sectorCode)).size, featureCacheUsed: restored !== null, featureCacheVersion: PORTFOLIO_FEATURE_CACHE_VERSION };
}
