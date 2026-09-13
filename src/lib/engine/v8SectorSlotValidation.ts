import type { MarketDataset } from "./dataset";
import { buildPortfolioSignalContext, type PortfolioSeries } from "./sectorPenaltyPortfolioSignals";
import type { DailyPrice } from "./types";

export const V8_SECTOR_SLOT_VERSION = "CloudTrend V8 Sector Price Leadership Slot Validation" as const;
export const V8_SECTOR_SLOT_THRESHOLDS = [65, 75, 80] as const;
export const V8_SECTOR_SLOT_HORIZONS = [5, 10, 20, 30, 40, 60] as const;
export const V8_SECTOR_SLOT_OVERHEAT_THRESHOLDS = [70, 75, 80, 85] as const;

export type V8SectorMarket = "ALL" | "KOSPI" | "KOSDAQ";
export type V8SectorSplit = "ALL" | "DEVELOPMENT" | "VALIDATION" | "OOS";
export type V8SectorPolicyId = "BASE_9P5" | "BONUS_ONLY" | "GATED_70" | "GATED_75" | "GATED_80" | "GATED_85";
export type V8SectorCohort = "ALL_ONSETS" | "SLOT_ONLY_ONSETS";
type StockMarket = Exclude<V8SectorMarket, "ALL">;

export interface V8SectorPolicy {
  id: V8SectorPolicyId;
  label: string;
  sectorSlotPoints: 0 | 0.5;
  overheatThreshold: number | null;
  missingPl: "NO_SLOT";
}

export interface V8SectorSlotOptions {
  limit?: number;
  warmupDays?: number;
  roundTripCostBps?: number;
  entryThresholds?: number[];
  horizons?: number[];
  overheatThresholds?: number[];
}

export interface V8SectorForwardRow {
  scope: "SPLIT" | "YEAR";
  split: V8SectorSplit | null;
  year: number | null;
  market: V8SectorMarket;
  policyId: V8SectorPolicyId;
  entryThreshold: number;
  horizon: number;
  cohort: V8SectorCohort;
  count: number;
  signalDates: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  profitFactor: number | null;
  avgExcessReturn: number | null;
  medianExcessReturn: number | null;
  excessWinRate: number | null;
  avgMae: number | null;
  avgMfe: number | null;
  dailyAvgExcessHacMean: number | null;
  dailyAvgExcessHacT: number | null;
  dailyAvgExcessCiLow: number | null;
  dailyAvgExcessCiHigh: number | null;
}

export interface V8SectorStrategyRow {
  scope: "SPLIT" | "YEAR";
  split: V8SectorSplit | null;
  year: number | null;
  market: StockMarket;
  policyId: V8SectorPolicyId;
  entryThreshold: number;
  upsideExitThreshold: 90;
  downsideExitThreshold: 25;
  maxHoldingDays: 60;
  rawOnsets: number;
  acceptedTrades: number;
  skippedReentry: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  profitFactor: number | null;
  avgExcessReturn: number | null;
  medianExcessReturn: number | null;
  excessWinRate: number | null;
  avgHoldingDays: number | null;
  avgMae: number | null;
  avgMfe: number | null;
  timeExitRate: number | null;
  upsideExitRate: number | null;
  downsideExitRate: number | null;
}

export interface V8SectorSlotResult {
  version: typeof V8_SECTOR_SLOT_VERSION;
  from: string;
  to: string;
  symbolCount: number;
  warmupDays: number;
  roundTripCostBps: number;
  policies: V8SectorPolicy[];
  entryThresholds: number[];
  horizons: number[];
  splitPolicy: {
    method: "chronological-60-20-20";
    developmentFrom: string | null;
    validationFrom: string | null;
    oosFrom: string | null;
  };
  forwardRows: V8SectorForwardRow[];
  strategyRows: V8SectorStrategyRow[];
  notes: string[];
}

interface ForwardAcc {
  dates: Set<string>;
  returns: number[];
  excess: number[];
  positive: number;
  excessPositive: number;
  profitSum: number;
  lossAbsSum: number;
  mae: number[];
  mfe: number[];
  daily: Map<string, { sum: number; n: number }>;
}

interface StrategyTrade {
  signalDate: string;
  entryIndex: number;
  exitIndex: number;
  exitTiming: "OPEN" | "CLOSE";
  exitReason: "TIME" | "UP" | "DOWN";
  ret: number;
  excess: number | null;
  holdingDays: number;
  mae: number | null;
  mfe: number | null;
}

interface StrategyAcc {
  rawOnsets: number;
  accepted: number;
  skipped: number;
  returns: number[];
  excess: number[];
  positive: number;
  excessPositive: number;
  profitSum: number;
  lossAbsSum: number;
  holdings: number[];
  mae: number[];
  mfe: number[];
  time: number;
  up: number;
  down: number;
}

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function median(xs: number[]) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = (s.length - 1) / 2; return (s[Math.floor(m)]! + s[Math.ceil(m)]!) / 2; }
function round(v: number | null, digits = 6) { if (!finite(v)) return null; const f = 10 ** digits; return Math.round(v * f) / f; }
function pct(score: number | null | undefined) { return finite(score) ? score * 10 : null; }

export function crossedUpSectorForTest(prev: number | null, cur: number | null, threshold: number) {
  const p = pct(prev), c = pct(cur);
  return p !== null && c !== null && p < threshold && c >= threshold;
}

function crossedDown(prev: number | null, cur: number | null, threshold: number) {
  const p = pct(prev), c = pct(cur);
  return p !== null && c !== null && p >= threshold && c < threshold;
}

export function policyScoreForTest(base: number | null, pl: number | null, policy: V8SectorPolicy): number | null {
  if (!finite(base)) return null;
  if (policy.id === "BASE_9P5") return Math.min(9.5, Math.max(0, Math.round(base * 100) / 100));
  if (!finite(pl)) return Math.min(10, Math.max(0, Math.round(base * 100) / 100));
  if (policy.id === "BONUS_ONLY") return Math.min(10, Math.max(0, Math.round((base + 0.5) * 100) / 100));
  const add = policy.overheatThreshold !== null && pl < policy.overheatThreshold ? 0.5 : 0;
  return Math.min(10, Math.max(0, Math.round((base + add) * 100) / 100));
}

export function neweyWestMeanSectorForTest(values: number[], lag: number) {
  const xs = values.filter(Number.isFinite);
  const n = xs.length;
  if (!n) return { mean: null, t: null, ciLow: null, ciHigh: null, n: 0 };
  const m = mean(xs)!;
  if (n < 2) return { mean: m, t: null, ciLow: m, ciHigh: m, n };
  const centered = xs.map((x) => x - m);
  let lrv = centered.reduce((s, x) => s + x * x, 0) / n;
  const L = Math.min(Math.max(0, Math.floor(lag)), n - 1);
  for (let l = 1; l <= L; l++) {
    let g = 0;
    for (let t = l; t < n; t++) g += centered[t]! * centered[t - l]!;
    g /= n;
    lrv += 2 * (1 - l / (L + 1)) * g;
  }
  const se = Math.sqrt(Math.max(0, lrv) / n);
  if (!(se > 0)) return { mean: m, t: null, ciLow: m, ciHigh: m, n };
  return { mean: m, t: m / se, ciLow: m - 1.96 * se, ciHigh: m + 1.96 * se, n };
}

function makePolicies(overheats: number[]): V8SectorPolicy[] {
  return [
    { id: "BASE_9P5", label: "Sector slot off · base 9.5", sectorSlotPoints: 0, overheatThreshold: null, missingPl: "NO_SLOT" },
    { id: "BONUS_ONLY", label: "+0.5 when sector PL is available", sectorSlotPoints: 0.5, overheatThreshold: null, missingPl: "NO_SLOT" },
    ...overheats.map((t) => ({
      id: `GATED_${t}` as V8SectorPolicyId,
      label: `+0.5 unless sector PL >= ${t}`,
      sectorSlotPoints: 0.5 as const,
      overheatThreshold: t,
      missingPl: "NO_SLOT" as const,
    })),
  ];
}

function buildSplitPolicy(allDates: string[]) {
  const d = [...new Set(allDates)].sort();
  if (!d.length) return { developmentFrom: null, validationFrom: null, oosFrom: null };
  return {
    developmentFrom: d[0] ?? null,
    validationFrom: d[Math.min(d.length - 1, Math.floor(d.length * 0.6))] ?? null,
    oosFrom: d[Math.min(d.length - 1, Math.floor(d.length * 0.8))] ?? null,
  };
}

function splitForDate(date: string, p: { validationFrom: string | null; oosFrom: string | null }): Exclude<V8SectorSplit, "ALL"> {
  if (p.oosFrom && date >= p.oosFrom) return "OOS";
  if (p.validationFrom && date >= p.validationFrom) return "VALIDATION";
  return "DEVELOPMENT";
}

function benchmarkMaps(dataset: MarketDataset) {
  const out = new Map<StockMarket, Map<string, DailyPrice>>();
  for (const m of ["KOSPI", "KOSDAQ"] as const) {
    const s = dataset.indexSeries.find((x) => x.indexCode === m);
    out.set(m, new Map((s?.bars ?? []).map((b) => [b.tradeDate, b])));
  }
  return out;
}

function benchmarkReturn(
  maps: Map<StockMarket, Map<string, DailyPrice>>,
  market: StockMarket,
  entryDate: string,
  exitDate: string,
  timing: "OPEN" | "CLOSE",
) {
  const e = maps.get(market)?.get(entryDate);
  const x = maps.get(market)?.get(exitDate);
  const xp = timing === "OPEN" ? x?.open : x?.close;
  if (!e || !x || !finite(e.open) || e.open <= 0 || !finite(xp) || xp <= 0) return null;
  return (xp / e.open - 1) * 100;
}

function excursion(
  bars: DailyPrice[], entryIndex: number, exitIndex: number, entryPrice: number, exitPrice: number, timing: "OPEN" | "CLOSE",
) {
  let lo = entryPrice, hi = entryPrice;
  for (let i = entryIndex; i <= exitIndex; i++) {
    const b = bars[i];
    if (!b) break;
    if (i === exitIndex && timing === "OPEN") { lo = Math.min(lo, exitPrice); hi = Math.max(hi, exitPrice); continue; }
    if (finite(b.low) && b.low > 0) lo = Math.min(lo, b.low);
    if (finite(b.high) && b.high > 0) hi = Math.max(hi, b.high);
  }
  return { mae: (lo / entryPrice - 1) * 100, mfe: (hi / entryPrice - 1) * 100 };
}

function makeForwardAcc(): ForwardAcc {
  return { dates: new Set(), returns: [], excess: [], positive: 0, excessPositive: 0, profitSum: 0, lossAbsSum: 0, mae: [], mfe: [], daily: new Map() };
}

function addForward(acc: ForwardAcc, date: string, ret: number, excess: number | null, mae: number, mfe: number) {
  acc.dates.add(date);
  acc.returns.push(ret);
  acc.positive += ret > 0 ? 1 : 0;
  if (ret > 0) acc.profitSum += ret;
  else if (ret < 0) acc.lossAbsSum += Math.abs(ret);
  if (finite(excess)) {
    acc.excess.push(excess);
    acc.excessPositive += excess > 0 ? 1 : 0;
    const d = acc.daily.get(date) ?? { sum: 0, n: 0 };
    d.sum += excess; d.n++;
    acc.daily.set(date, d);
  }
  acc.mae.push(mae); acc.mfe.push(mfe);
}

function finalizeForward(
  meta: Omit<V8SectorForwardRow, "count" | "signalDates" | "avgReturn" | "medianReturn" | "winRate" | "profitFactor" | "avgExcessReturn" | "medianExcessReturn" | "excessWinRate" | "avgMae" | "avgMfe" | "dailyAvgExcessHacMean" | "dailyAvgExcessHacT" | "dailyAvgExcessCiLow" | "dailyAvgExcessCiHigh">,
  acc: ForwardAcc,
): V8SectorForwardRow {
  const n = acc.returns.length;
  const daily = [...acc.daily.values()].filter((d) => d.n).map((d) => d.sum / d.n);
  const hac = neweyWestMeanSectorForTest(daily, meta.horizon - 1);
  return {
    ...meta,
    count: n,
    signalDates: acc.dates.size,
    avgReturn: round(mean(acc.returns)),
    medianReturn: round(median(acc.returns)),
    winRate: n ? round(acc.positive / n * 100) : null,
    profitFactor: acc.lossAbsSum > 0 ? round(acc.profitSum / acc.lossAbsSum) : null,
    avgExcessReturn: round(mean(acc.excess)),
    medianExcessReturn: round(median(acc.excess)),
    excessWinRate: acc.excess.length ? round(acc.excessPositive / acc.excess.length * 100) : null,
    avgMae: round(mean(acc.mae)),
    avgMfe: round(mean(acc.mfe)),
    dailyAvgExcessHacMean: round(hac.mean),
    dailyAvgExcessHacT: round(hac.t),
    dailyAvgExcessCiLow: round(hac.ciLow),
    dailyAvgExcessCiHigh: round(hac.ciHigh),
  };
}

function makeStrategyAcc(): StrategyAcc {
  return { rawOnsets: 0, accepted: 0, skipped: 0, returns: [], excess: [], positive: 0, excessPositive: 0, profitSum: 0, lossAbsSum: 0, holdings: [], mae: [], mfe: [], time: 0, up: 0, down: 0 };
}

function simulateStrategy(
  source: PortfolioSeries,
  scores: Array<number | null>,
  signalIndex: number,
  market: StockMarket,
  benchmarks: Map<StockMarket, Map<string, DailyPrice>>,
  costBps: number,
): StrategyTrade | null {
  const bars = source.bars;
  const entryIndex = signalIndex + 1;
  const planned = signalIndex + 60;
  const entry = bars[entryIndex];
  if (!entry || planned >= bars.length || !finite(entry.open) || entry.open <= 0) return null;
  let exitIndex = -1, exitPrice = 0;
  let timing: "OPEN" | "CLOSE" = "CLOSE";
  let reason: "TIME" | "UP" | "DOWN" = "TIME";
  for (let j = entryIndex; j <= planned; j++) {
    const b = bars[j];
    if (!b || ![b.open, b.close, b.low, b.high].every((v) => finite(v) && v > 0)) return null;
    if (j > entryIndex) {
      const si = j - 1;
      const prev = scores[si - 1] ?? null;
      const cur = scores[si] ?? null;
      if (crossedDown(prev, cur, 25)) { exitIndex = j; exitPrice = b.open; timing = "OPEN"; reason = "DOWN"; break; }
      if (crossedUpSectorForTest(prev, cur, 90)) { exitIndex = j; exitPrice = b.open; timing = "OPEN"; reason = "UP"; break; }
    }
    if (j === planned) { exitIndex = j; exitPrice = b.close; }
  }
  if (exitIndex < 0) return null;
  const ex = excursion(bars, entryIndex, exitIndex, entry.open, exitPrice, timing);
  const ret = (exitPrice / entry.open - 1) * 100 - costBps / 100;
  const bench = benchmarkReturn(benchmarks, market, entry.tradeDate, bars[exitIndex]!.tradeDate, timing);
  return {
    signalDate: bars[signalIndex]!.tradeDate,
    entryIndex, exitIndex, exitTiming: timing, exitReason: reason,
    ret, excess: finite(bench) ? ret - bench : null,
    holdingDays: exitIndex - entryIndex + 1,
    mae: ex.mae, mfe: ex.mfe,
  };
}

function addStrategy(acc: StrategyAcc, trade: StrategyTrade) {
  acc.accepted++;
  acc.returns.push(trade.ret);
  acc.positive += trade.ret > 0 ? 1 : 0;
  if (trade.ret > 0) acc.profitSum += trade.ret;
  else if (trade.ret < 0) acc.lossAbsSum += Math.abs(trade.ret);
  if (finite(trade.excess)) { acc.excess.push(trade.excess); acc.excessPositive += trade.excess > 0 ? 1 : 0; }
  acc.holdings.push(trade.holdingDays);
  if (finite(trade.mae)) acc.mae.push(trade.mae);
  if (finite(trade.mfe)) acc.mfe.push(trade.mfe);
  if (trade.exitReason === "TIME") acc.time++;
  else if (trade.exitReason === "UP") acc.up++;
  else acc.down++;
}

function finalizeStrategy(
  meta: Omit<V8SectorStrategyRow, "rawOnsets" | "acceptedTrades" | "skippedReentry" | "avgReturn" | "medianReturn" | "winRate" | "profitFactor" | "avgExcessReturn" | "medianExcessReturn" | "excessWinRate" | "avgHoldingDays" | "avgMae" | "avgMfe" | "timeExitRate" | "upsideExitRate" | "downsideExitRate">,
  acc: StrategyAcc,
): V8SectorStrategyRow {
  const n = acc.accepted;
  return {
    ...meta,
    rawOnsets: acc.rawOnsets,
    acceptedTrades: n,
    skippedReentry: acc.skipped,
    avgReturn: round(mean(acc.returns)),
    medianReturn: round(median(acc.returns)),
    winRate: n ? round(acc.positive / n * 100) : null,
    profitFactor: acc.lossAbsSum > 0 ? round(acc.profitSum / acc.lossAbsSum) : null,
    avgExcessReturn: round(mean(acc.excess)),
    medianExcessReturn: round(median(acc.excess)),
    excessWinRate: acc.excess.length ? round(acc.excessPositive / acc.excess.length * 100) : null,
    avgHoldingDays: round(mean(acc.holdings)),
    avgMae: round(mean(acc.mae)),
    avgMfe: round(mean(acc.mfe)),
    timeExitRate: n ? round(acc.time / n * 100) : null,
    upsideExitRate: n ? round(acc.up / n * 100) : null,
    downsideExitRate: n ? round(acc.down / n * 100) : null,
  };
}

export function buildV8SectorSlotValidation(dataset: MarketDataset, options: V8SectorSlotOptions = {}): V8SectorSlotResult | null {
  const limit = Math.max(1, Math.round(options.limit ?? 613));
  const warmupDays = Math.max(120, Math.round(options.warmupDays ?? 120));
  const cost = Math.max(0, options.roundTripCostBps ?? 0);
  const thresholds = [...new Set(options.entryThresholds ?? [...V8_SECTOR_SLOT_THRESHOLDS])].sort((a, b) => a - b);
  const horizons = [...new Set(options.horizons ?? [...V8_SECTOR_SLOT_HORIZONS])].sort((a, b) => a - b);
  const overheats = [...new Set(options.overheatThresholds ?? [...V8_SECTOR_SLOT_OVERHEAT_THRESHOLDS])].sort((a, b) => a - b);
  const policies = makePolicies(overheats);
  const context = buildPortfolioSignalContext(dataset, limit);
  if (!context.series.length || !context.allDates.length) return null;
  const splitPolicy = buildSplitPolicy(context.allDates);
  const benchmarks = benchmarkMaps(dataset);
  const forwardRows: V8SectorForwardRow[] = [];
  const strategyRows: V8SectorStrategyRow[] = [];

  for (const policy of policies) {
    for (const entryThreshold of thresholds) {
      for (const horizon of horizons) {
        const accs = new Map<string, { meta: Omit<V8SectorForwardRow, "count" | "signalDates" | "avgReturn" | "medianReturn" | "winRate" | "profitFactor" | "avgExcessReturn" | "medianExcessReturn" | "excessWinRate" | "avgMae" | "avgMfe" | "dailyAvgExcessHacMean" | "dailyAvgExcessHacT" | "dailyAvgExcessCiLow" | "dailyAvgExcessCiHigh">; acc: ForwardAcc }>();
        const getAcc = (scope: "SPLIT" | "YEAR", split: V8SectorSplit | null, year: number | null, market: V8SectorMarket, cohort: V8SectorCohort) => {
          const k = `${scope}|${split ?? ""}|${year ?? ""}|${market}|${cohort}`;
          let x = accs.get(k);
          if (!x) {
            x = { meta: { scope, split, year, market, policyId: policy.id, entryThreshold, horizon, cohort }, acc: makeForwardAcc() };
            accs.set(k, x);
          }
          return x.acc;
        };

        for (const source of context.series) {
          const market = source.market as StockMarket;
          const scores = source.baseScores.map((base, i) => policyScoreForTest(base, source.sectorPriceLeadership[i] ?? null, policy));
          const baseScores = source.baseScores;
          for (let i = warmupDays; i + horizon < source.bars.length; i++) {
            if (!crossedUpSectorForTest(scores[i - 1] ?? null, scores[i] ?? null, entryThreshold)) continue;
            const entry = source.bars[i + 1]!;
            const exit = source.bars[i + horizon]!;
            if (!finite(entry.open) || entry.open <= 0 || !finite(exit.close) || exit.close <= 0) continue;
            const ret = (exit.close / entry.open - 1) * 100 - cost / 100;
            const bench = benchmarkReturn(benchmarks, market, entry.tradeDate, exit.tradeDate, "CLOSE");
            const excess = finite(bench) ? ret - bench : null;
            const ex = excursion(source.bars, i + 1, i + horizon, entry.open, exit.close, "CLOSE");
            const date = source.bars[i]!.tradeDate;
            const split = splitForDate(date, splitPolicy);
            const year = Number(date.slice(0, 4));
            const baseOnset = crossedUpSectorForTest(baseScores[i - 1] ?? null, baseScores[i] ?? null, entryThreshold);
            const slotOnly = policy.id !== "BASE_9P5" && !baseOnset;
            const groups = [
              { scope: "SPLIT" as const, split: "ALL" as V8SectorSplit, year: null },
              { scope: "SPLIT" as const, split, year: null },
              { scope: "YEAR" as const, split: null, year },
            ];
            for (const g of groups) for (const mg of ["ALL", market] as const) {
              addForward(getAcc(g.scope, g.split, g.year, mg, "ALL_ONSETS"), date, ret, excess, ex.mae, ex.mfe);
              if (slotOnly) addForward(getAcc(g.scope, g.split, g.year, mg, "SLOT_ONLY_ONSETS"), date, ret, excess, ex.mae, ex.mfe);
            }
          }
        }
        for (const { meta, acc } of accs.values()) forwardRows.push(finalizeForward(meta, acc));
      }

      for (const market of ["KOSPI", "KOSDAQ"] as const) {
        if (market === "KOSPI" && ![65, 75].includes(entryThreshold)) continue;
        if (market === "KOSDAQ" && ![75, 80].includes(entryThreshold)) continue;
        const accs = new Map<string, { meta: Omit<V8SectorStrategyRow, "rawOnsets" | "acceptedTrades" | "skippedReentry" | "avgReturn" | "medianReturn" | "winRate" | "profitFactor" | "avgExcessReturn" | "medianExcessReturn" | "excessWinRate" | "avgHoldingDays" | "avgMae" | "avgMfe" | "timeExitRate" | "upsideExitRate" | "downsideExitRate">; acc: StrategyAcc }>();
        const getAcc = (scope: "SPLIT" | "YEAR", split: V8SectorSplit | null, year: number | null) => {
          const k = `${scope}|${split ?? ""}|${year ?? ""}`;
          let x = accs.get(k);
          if (!x) {
            x = { meta: { scope, split, year, market, policyId: policy.id, entryThreshold, upsideExitThreshold: 90, downsideExitThreshold: 25, maxHoldingDays: 60 }, acc: makeStrategyAcc() };
            accs.set(k, x);
          }
          return x.acc;
        };

        for (const source of context.series) {
          if (source.market !== market) continue;
          const scores = source.baseScores.map((base, i) => policyScoreForTest(base, source.sectorPriceLeadership[i] ?? null, policy));
          let lastExit = -1;
          let lastTiming: "OPEN" | "CLOSE" | null = null;
          for (let i = warmupDays; i + 1 < source.bars.length; i++) {
            if (!crossedUpSectorForTest(scores[i - 1] ?? null, scores[i] ?? null, entryThreshold)) continue;
            const curPct = pct(scores[i] ?? null);
            if (curPct !== null && curPct >= 90) continue;
            const date = source.bars[i]!.tradeDate;
            const split = splitForDate(date, splitPolicy);
            const year = Number(date.slice(0, 4));
            const groups = [
              { scope: "SPLIT" as const, split: "ALL" as V8SectorSplit, year: null },
              { scope: "SPLIT" as const, split, year: null },
              { scope: "YEAR" as const, split: null, year },
            ];
            for (const g of groups) getAcc(g.scope, g.split, g.year).rawOnsets++;
            const blocked = i < lastExit || (i === lastExit && lastTiming === "CLOSE");
            if (blocked) { for (const g of groups) getAcc(g.scope, g.split, g.year).skipped++; continue; }
            const trade = simulateStrategy(source, scores, i, market, benchmarks, cost);
            if (!trade) continue;
            lastExit = trade.exitIndex;
            lastTiming = trade.exitTiming;
            for (const g of groups) addStrategy(getAcc(g.scope, g.split, g.year), trade);
          }
        }
        for (const { meta, acc } of accs.values()) strategyRows.push(finalizeStrategy(meta, acc));
      }
    }
  }

  forwardRows.sort((a, b) => a.scope.localeCompare(b.scope) || String(a.split ?? a.year ?? "").localeCompare(String(b.split ?? b.year ?? "")) || a.market.localeCompare(b.market) || a.entryThreshold - b.entryThreshold || a.horizon - b.horizon || a.policyId.localeCompare(b.policyId) || a.cohort.localeCompare(b.cohort));
  strategyRows.sort((a, b) => a.scope.localeCompare(b.scope) || String(a.split ?? a.year ?? "").localeCompare(String(b.split ?? b.year ?? "")) || a.market.localeCompare(b.market) || a.entryThreshold - b.entryThreshold || a.policyId.localeCompare(b.policyId));

  return {
    version: V8_SECTOR_SLOT_VERSION,
    from: context.allDates[0] ?? dataset.asOfDate,
    to: context.allDates.at(-1) ?? dataset.asOfDate,
    symbolCount: context.series.length,
    warmupDays,
    roundTripCostBps: cost,
    policies,
    entryThresholds: thresholds,
    horizons,
    splitPolicy: { method: "chronological-60-20-20", ...splitPolicy },
    forwardRows,
    strategyRows,
    notes: [
      "BASE_9P5 is the counterfactual without the sector 0.5-point slot.",
      "BONUS_ONLY adds 0.5 whenever sector PL is available; gated policies withhold the slot when PL reaches the stated overheat threshold.",
      "Missing sector PL never receives the slot in any policy.",
      "SLOT_ONLY_ONSETS are policy onsets that would not have been onsets under BASE_9P5 on the same stock-date.",
      "Strategy validation uses the V8-4 balanced rule: next-open entry, upside 90 / downside 25 score exits at next open, maximum 60 trading days, and no re-entry while held.",
      "Signals already at or above the 90 upside-exit threshold are not entered, matching V8-4 execution semantics.",
    ],
  };
}
