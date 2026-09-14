import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildPortfolioSignalContext, type PortfolioSeries } from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import { policyScoreForTest, type V8SectorPolicy } from "../src/lib/engine/v8SectorSlotValidation";
import { prepareV8VfFeatureSeries } from "../src/lib/engine/v8VfFeatureValidation";
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { DailyPrice } from "../src/lib/engine/types";
import { visitDelimitedRows } from "../src/lib/sourceData";
import { codeVersion, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

const STUDY = "V8-9b" as const;
const ENGINE_VERSION = "CloudTrend V8-9b Supply Penalty Structure Validation" as const;
const FOS_YEARS = [2018, 2022, 2025] as const;
const PURGE_TRADING_DAYS = 60;
const WARMUP_DAYS = 120;
const MAX_HOLDING_DAYS = 60;
const UPSIDE_EXIT_THRESHOLD = 90;
const PL_OVERHEAT_THRESHOLD = 80;

type FosYear = (typeof FOS_YEARS)[number];
type Market = "KOSPI" | "KOSDAQ";
type TriggerId = "SHORT5" | "SHORT20" | "LEND5" | "LEND20" | "HIGH_CLOSE";
type ApplyMode = "ENTRY_ONLY" | "FULL_SCORE";
type Model = "BASELINE" | "PENALTY";

interface Options {
  supabaseUserId: string | null;
  outputRoot: string;
  upload: boolean;
  limit: number;
  roundTripCostBps: number;
}

interface SupplyPoint {
  date: string;
  shortVolumeRate: number | null;
  lendingBalanceQuantity: number | null;
}

interface SupplyArrays {
  shortVolumeRate: Float64Array;
  lendingBalanceQuantity: Float64Array;
}

interface Scenario {
  id: string;
  label: string;
  triggers: TriggerId[];
  penaltyPerTrigger: 0.25 | 0.5;
}

interface Trade {
  symbol: string;
  market: Market;
  foldYear: FosYear;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  exitReason: "UPSIDE_SCORE" | "TIME";
  holdingDays: number;
  ret: number;
  excess: number | null;
  mae: number | null;
  mfe: number | null;
  signalScore: number;
  activePenaltyCount: number;
  totalPenalty: number;
}

interface Metric {
  trades: number;
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
  upsideExitRate: number | null;
  avgSignalScore: number | null;
  avgActivePenaltyCount: number | null;
  avgTotalPenalty: number | null;
}

interface FoldRow extends Metric {
  scenarioId: string;
  scenarioLabel: string;
  applyMode: ApplyMode;
  model: Model;
  market: Market;
  entryThreshold: 75 | 80;
  foldYear: FosYear;
}

interface ComparisonRow {
  scenarioId: string;
  scenarioLabel: string;
  triggers: TriggerId[];
  penaltyPerTrigger: number;
  applyMode: ApplyMode;
  market: Market;
  entryThreshold: 75 | 80;
  usableFoldYears: FosYear[];
  totalBaselineTrades: number;
  totalPenaltyTrades: number;
  tradeCountChange: number;
  equalWeightBaselineAvgExcess: number | null;
  equalWeightPenaltyAvgExcess: number | null;
  deltaAvgExcess: number | null;
  equalWeightBaselineMedianExcess: number | null;
  equalWeightPenaltyMedianExcess: number | null;
  deltaMedianExcess: number | null;
  equalWeightBaselineProfitFactor: number | null;
  equalWeightPenaltyProfitFactor: number | null;
  deltaProfitFactor: number | null;
  foldsImprovedAvgExcess: number;
  foldsImprovedMedianExcess: number;
  worstFoldDeltaAvgExcess: number | null;
  bestFoldDeltaAvgExcess: number | null;
  classification: "PASS_STRONG" | "PASS_TENTATIVE" | "MIXED" | "REJECT" | "NO_COVERAGE";
  foldDeltas: Array<{
    year: FosYear;
    baselineTrades: number;
    penaltyTrades: number;
    deltaAvgExcess: number | null;
    deltaMedianExcess: number | null;
    deltaProfitFactor: number | null;
  }>;
}

const GATED_80_POLICY: V8SectorPolicy = {
  id: "GATED_80",
  label: "+0.5 unless sector PL >= 80",
  sectorSlotPoints: 0.5,
  overheatThreshold: 80,
  missingPl: "NO_SLOT",
};

const SCENARIOS: Scenario[] = [
  { id: "SHORT5_P025", label: "공매도 거래량비중 5D 증가 · -0.25", triggers: ["SHORT5"], penaltyPerTrigger: 0.25 },
  { id: "SHORT5_P050", label: "공매도 거래량비중 5D 증가 · -0.50", triggers: ["SHORT5"], penaltyPerTrigger: 0.5 },
  { id: "SHORT20_P025", label: "공매도 거래량비중 20D 증가 · -0.25", triggers: ["SHORT20"], penaltyPerTrigger: 0.25 },
  { id: "SHORT20_P050", label: "공매도 거래량비중 20D 증가 · -0.50", triggers: ["SHORT20"], penaltyPerTrigger: 0.5 },
  { id: "LEND5_P025", label: "대차잔고 5D 증가 · -0.25", triggers: ["LEND5"], penaltyPerTrigger: 0.25 },
  { id: "LEND5_P050", label: "대차잔고 5D 증가 · -0.50", triggers: ["LEND5"], penaltyPerTrigger: 0.5 },
  { id: "LEND20_P025", label: "대차잔고 20D 증가 · -0.25", triggers: ["LEND20"], penaltyPerTrigger: 0.25 },
  { id: "LEND20_P050", label: "대차잔고 20D 증가 · -0.50", triggers: ["LEND20"], penaltyPerTrigger: 0.5 },
  { id: "HIGH_CLOSE_P025", label: "고가마감거래량 · -0.25", triggers: ["HIGH_CLOSE"], penaltyPerTrigger: 0.25 },
  { id: "HIGH_CLOSE_P050", label: "고가마감거래량 · -0.50", triggers: ["HIGH_CLOSE"], penaltyPerTrigger: 0.5 },
  { id: "SHORT20_LEND20_P025", label: "공매도20D+대차20D 증가 · 각 -0.25", triggers: ["SHORT20", "LEND20"], penaltyPerTrigger: 0.25 },
  { id: "SHORT20_LEND20_P050", label: "공매도20D+대차20D 증가 · 각 -0.50", triggers: ["SHORT20", "LEND20"], penaltyPerTrigger: 0.5 },
  { id: "ALL3_20_P025", label: "공매도20D+대차20D+고가마감거래량 · 각 -0.25", triggers: ["SHORT20", "LEND20", "HIGH_CLOSE"], penaltyPerTrigger: 0.25 },
  { id: "ALL3_20_P050", label: "공매도20D+대차20D+고가마감거래량 · 각 -0.50", triggers: ["SHORT20", "LEND20", "HIGH_CLOSE"], penaltyPerTrigger: 0.5 },
];

function usage(): never {
  throw new Error([
    "Usage:",
    "  npx vite-node scripts/run-v8-supply-penalty-validation-3fos.ts --supabase-user-id <uuid> [--upload]",
    "Options:",
    "  --output <dir>  default: v8-supply-penalty-3fos-runs",
    "  --limit <count>  default: 613",
    "  --round-trip-cost-bps <bps>  default: 0",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v8-supply-penalty-3fos-runs",
    upload: false,
    limit: 613,
    roundTripCostBps: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--supabase-user-id") options.supabaseUserId = argv[++i] ?? usage();
    else if (arg === "--output") options.outputRoot = argv[++i] ?? usage();
    else if (arg === "--upload") options.upload = true;
    else if (arg === "--limit") options.limit = Number(argv[++i] ?? usage());
    else if (arg === "--round-trip-cost-bps") options.roundTripCostBps = Number(argv[++i] ?? usage());
    else usage();
  }
  if (!options.supabaseUserId) usage();
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 2000) throw new Error("limit은 1~2000 정수여야 합니다.");
  if (!Number.isFinite(options.roundTripCostBps) || options.roundTripCostBps < 0 || options.roundTripCostBps > 1000) {
    throw new Error("round-trip-cost-bps는 0~1000이어야 합니다.");
  }
  return options;
}

const finite = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value);
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function median(values: number[]) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)]! + s[Math.ceil(m)]!) / 2;
}
function round(value: number | null, digits = 6) {
  if (!finite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function parseNumber(value: string | undefined): number | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "-" || /^(null|none|nan|na)$/i.test(raw)) return null;
  const parsed = Number(raw.replace(/[, ₩원%]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value: string | undefined): string | null {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/[^\d]/g, "").slice(0, 8);
  if (digits.length !== 8) return null;
  const y = Number(digits.slice(0, 4));
  const m = Number(digits.slice(4, 6));
  const d = Number(digits.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function normalizeSymbol(value: string | undefined) {
  let symbol = String(value ?? "").trim().toUpperCase().replace(/^A(?=\d{6}$)/, "").replace(/\.0$/, "");
  if (/^\d{1,6}$/.test(symbol)) symbol = symbol.padStart(6, "0");
  return symbol;
}

function compactHeader(value: string) {
  return value.trim().replace(/^\uFEFF/, "").replace(/[^0-9a-zA-Z가-힣]/g, "").toLowerCase();
}

function indexOfAny(index: Map<string, number>, aliases: string[]) {
  for (const alias of aliases) {
    const found = index.get(compactHeader(alias));
    if (found !== undefined) return found;
  }
  return -1;
}

function parseSupplyRows(rawTexts: string[], eligibleSymbols: Set<string>) {
  const bySymbol = new Map<string, SupplyPoint[]>();
  for (const text of rawTexts) {
    let idx: Record<string, number> | null = null;
    visitDelimitedRows(text, (cells, rowIndex) => {
      if (rowIndex === 0) {
        const headerIndex = new Map(cells.map((header, i) => [compactHeader(header), i]));
        idx = {
          symbol: indexOfAny(headerIndex, ["symbol", "stockcode", "code", "ticker"]),
          date: indexOfAny(headerIndex, ["date", "tradedate"]),
          shortVolumeRate: indexOfAny(headerIndex, ["shortsellingvolumerate", "shortsellingtradingvolumerelativeimportance"]),
          lendingBalanceQuantity: indexOfAny(headerIndex, ["lendingbalancequantity"]),
        };
        return;
      }
      if (!idx || idx.symbol < 0 || idx.date < 0) return;
      const symbol = normalizeSymbol(cells[idx.symbol]);
      if (!eligibleSymbols.has(symbol)) return;
      const date = normalizeDate(cells[idx.date]);
      if (!date) return;
      const row: SupplyPoint = {
        date,
        shortVolumeRate: idx.shortVolumeRate >= 0 ? parseNumber(cells[idx.shortVolumeRate]) : null,
        lendingBalanceQuantity: idx.lendingBalanceQuantity >= 0 ? parseNumber(cells[idx.lendingBalanceQuantity]) : null,
      };
      const xs = bySymbol.get(symbol) ?? [];
      xs.push(row);
      bySymbol.set(symbol, xs);
    });
  }
  for (const [symbol, rows] of bySymbol) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const merged: SupplyPoint[] = [];
    for (const row of rows) {
      const last = merged.at(-1);
      if (!last || last.date !== row.date) {
        merged.push(row);
        continue;
      }
      if (!finite(last.shortVolumeRate) && finite(row.shortVolumeRate)) last.shortVolumeRate = row.shortVolumeRate;
      if (!finite(last.lendingBalanceQuantity) && finite(row.lendingBalanceQuantity)) last.lendingBalanceQuantity = row.lendingBalanceQuantity;
    }
    bySymbol.set(symbol, merged);
  }
  return bySymbol;
}

function nanArray(length: number) {
  const out = new Float64Array(length);
  out.fill(Number.NaN);
  return out;
}

function alignSupply(bars: DailyPrice[], rows: SupplyPoint[] | undefined): SupplyArrays {
  const out: SupplyArrays = { shortVolumeRate: nanArray(bars.length), lendingBalanceQuantity: nanArray(bars.length) };
  if (!rows?.length) return out;
  let j = 0;
  for (let i = 0; i < bars.length && j < rows.length; i++) {
    const date = bars[i]!.tradeDate;
    while (j < rows.length && rows[j]!.date < date) j++;
    if (j >= rows.length || rows[j]!.date !== date) continue;
    if (finite(rows[j]!.shortVolumeRate)) out.shortVolumeRate[i] = rows[j]!.shortVolumeRate!;
    if (finite(rows[j]!.lendingBalanceQuantity)) out.lendingBalanceQuantity[i] = rows[j]!.lendingBalanceQuantity!;
  }
  return out;
}

function delta(values: Float64Array, i: number, lookback: number) {
  if (i - lookback < 0) return null;
  const cur = values[i], lag = values[i - lookback];
  return Number.isFinite(cur) && Number.isFinite(lag) ? cur - lag : null;
}

function pctChange(values: Float64Array, i: number, lookback: number) {
  if (i - lookback < 0) return null;
  const cur = values[i], lag = values[i - lookback];
  if (!Number.isFinite(cur) || !Number.isFinite(lag) || lag <= 0 || cur < 0) return null;
  return (cur / lag - 1) * 100;
}

function triggerStatus(
  trigger: TriggerId,
  i: number,
  supply: SupplyArrays,
  highClose: Int8Array | undefined,
): { available: boolean; active: boolean } {
  if (trigger === "HIGH_CLOSE") {
    const state = highClose?.[i] ?? -1;
    return { available: state !== -1, active: state === 1 };
  }
  if (trigger === "SHORT5" || trigger === "SHORT20") {
    const value = delta(supply.shortVolumeRate, i, trigger === "SHORT5" ? 5 : 20);
    return { available: finite(value), active: finite(value) && value > 0 };
  }
  const value = pctChange(supply.lendingBalanceQuantity, i, trigger === "LEND5" ? 5 : 20);
  return { available: finite(value), active: finite(value) && value > 0 };
}

function baselineScore(source: PortfolioSeries, i: number) {
  return policyScoreForTest(source.baseScores[i] ?? null, source.sectorPriceLeadership[i] ?? null, GATED_80_POLICY);
}

function scoreWithScenario(
  source: PortfolioSeries,
  i: number,
  supply: SupplyArrays,
  highClose: Int8Array | undefined,
  scenario: Scenario,
  penalized: boolean,
  requireAvailability: boolean,
) {
  const base = baselineScore(source, i);
  if (!finite(base)) return { score: null as number | null, activeCount: 0, totalPenalty: 0 };
  let activeCount = 0;
  for (const trigger of scenario.triggers) {
    const status = triggerStatus(trigger, i, supply, highClose);
    if (requireAvailability && !status.available) return { score: null as number | null, activeCount: 0, totalPenalty: 0 };
    if (status.available && status.active) activeCount++;
  }
  const totalPenalty = penalized ? activeCount * scenario.penaltyPerTrigger : 0;
  return { score: Math.max(0, Math.round((base - totalPenalty) * 100) / 100), activeCount, totalPenalty };
}

function crossedUp(prev: number | null, cur: number | null, threshold: number) {
  return finite(prev) && finite(cur) && prev * 10 < threshold && cur * 10 >= threshold;
}

function benchmarkMaps(dataset: MarketDataset) {
  return new Map<Market, Map<string, DailyPrice>>([
    ["KOSPI", new Map((dataset.indexSeries.find((s) => s.indexCode.toUpperCase() === "KOSPI")?.bars ?? []).map((b) => [b.tradeDate, b]))],
    ["KOSDAQ", new Map((dataset.indexSeries.find((s) => s.indexCode.toUpperCase() === "KOSDAQ")?.bars ?? []).map((b) => [b.tradeDate, b]))],
  ]);
}

function benchmarkReturn(
  maps: Map<Market, Map<string, DailyPrice>>,
  market: Market,
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

function excursion(bars: DailyPrice[], entryIndex: number, exitIndex: number, entryPrice: number, exitPrice: number, exitTiming: "OPEN" | "CLOSE") {
  let low = entryPrice, high = entryPrice;
  for (let i = entryIndex; i <= exitIndex; i++) {
    const bar = bars[i];
    if (!bar) break;
    if (i === exitIndex && exitTiming === "OPEN") {
      low = Math.min(low, exitPrice); high = Math.max(high, exitPrice); continue;
    }
    if (finite(bar.low) && bar.low > 0) low = Math.min(low, bar.low);
    if (finite(bar.high) && bar.high > 0) high = Math.max(high, bar.high);
  }
  return { mae: (low / entryPrice - 1) * 100, mfe: (high / entryPrice - 1) * 100 };
}

function simulateTrade(
  source: PortfolioSeries,
  scenario: Scenario,
  model: Model,
  applyMode: ApplyMode,
  signalIndex: number,
  supply: SupplyArrays,
  highClose: Int8Array | undefined,
  benchmarks: Map<Market, Map<string, DailyPrice>>,
  costBps: number,
  foldYear: FosYear,
): Trade | null {
  const market = source.market as Market;
  const entryIndex = signalIndex + 1;
  const plannedExit = signalIndex + MAX_HOLDING_DAYS;
  const entry = source.bars[entryIndex];
  if (!entry || plannedExit >= source.bars.length || !finite(entry.open) || entry.open <= 0) return null;
  const signal = scoreWithScenario(source, signalIndex, supply, highClose, scenario, model === "PENALTY", true);
  if (!finite(signal.score)) return null;

  let exitIndex = plannedExit;
  let exitPrice = source.bars[plannedExit]!.close;
  let exitTiming: "OPEN" | "CLOSE" = "CLOSE";
  let exitReason: "UPSIDE_SCORE" | "TIME" = "TIME";

  for (let j = entryIndex + 1; j <= plannedExit; j++) {
    const decisionIndex = j - 1;
    let prev: number | null = null;
    let cur: number | null = null;
    if (applyMode === "FULL_SCORE") {
      prev = scoreWithScenario(source, decisionIndex - 1, supply, highClose, scenario, model === "PENALTY", true).score;
      cur = scoreWithScenario(source, decisionIndex, supply, highClose, scenario, model === "PENALTY", true).score;
    } else {
      prev = baselineScore(source, decisionIndex - 1);
      cur = baselineScore(source, decisionIndex);
    }
    if (crossedUp(prev, cur, UPSIDE_EXIT_THRESHOLD)) {
      const bar = source.bars[j];
      if (!bar || !finite(bar.open) || bar.open <= 0) return null;
      exitIndex = j;
      exitPrice = bar.open;
      exitTiming = "OPEN";
      exitReason = "UPSIDE_SCORE";
      break;
    }
  }

  if (!finite(exitPrice) || exitPrice <= 0) return null;
  const exitDate = source.bars[exitIndex]!.tradeDate;
  const ret = (exitPrice / entry.open - 1) * 100 - costBps / 100;
  const benchmark = benchmarkReturn(benchmarks, market, entry.tradeDate, exitDate, exitTiming);
  const ex = excursion(source.bars, entryIndex, exitIndex, entry.open, exitPrice, exitTiming);
  return {
    symbol: source.symbol,
    market,
    foldYear,
    signalDate: source.bars[signalIndex]!.tradeDate,
    entryDate: entry.tradeDate,
    exitDate,
    exitReason,
    holdingDays: exitIndex - entryIndex + 1,
    ret,
    excess: finite(benchmark) ? ret - benchmark : null,
    mae: ex.mae,
    mfe: ex.mfe,
    signalScore: signal.score,
    activePenaltyCount: model === "PENALTY" ? signal.activeCount : 0,
    totalPenalty: model === "PENALTY" ? signal.totalPenalty : 0,
  };
}

function summarize(trades: Trade[]): Metric {
  const returns = trades.map((t) => t.ret).filter(Number.isFinite);
  const excess = trades.map((t) => t.excess).filter(finite);
  const wins = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x < 0);
  const profit = wins.reduce((a, b) => a + b, 0);
  const loss = losses.reduce((a, b) => a + Math.abs(b), 0);
  const mae = trades.map((t) => t.mae).filter(finite);
  const mfe = trades.map((t) => t.mfe).filter(finite);
  return {
    trades: trades.length,
    avgReturn: round(mean(returns)),
    medianReturn: round(median(returns)),
    winRate: returns.length ? round(wins.length / returns.length * 100) : null,
    profitFactor: loss > 0 ? round(profit / loss) : null,
    avgExcessReturn: round(mean(excess)),
    medianExcessReturn: round(median(excess)),
    excessWinRate: excess.length ? round(excess.filter((x) => x > 0).length / excess.length * 100) : null,
    avgHoldingDays: round(mean(trades.map((t) => t.holdingDays))),
    avgMae: round(mean(mae)),
    avgMfe: round(mean(mfe)),
    upsideExitRate: trades.length ? round(trades.filter((t) => t.exitReason === "UPSIDE_SCORE").length / trades.length * 100) : null,
    avgSignalScore: round(mean(trades.map((t) => t.signalScore))),
    avgActivePenaltyCount: round(mean(trades.map((t) => t.activePenaltyCount))),
    avgTotalPenalty: round(mean(trades.map((t) => t.totalPenalty))),
  };
}

function sharedTradingDates(dataset: MarketDataset) {
  const kospi = new Set(dataset.indexSeries.find((s) => s.indexCode.toUpperCase() === "KOSPI")?.bars.map((b) => b.tradeDate) ?? []);
  const kosdaq = new Set(dataset.indexSeries.find((s) => s.indexCode.toUpperCase() === "KOSDAQ")?.bars.map((b) => b.tradeDate) ?? []);
  return [...kospi].filter((d) => kosdaq.has(d)).sort();
}

function buildFoldPolicies(dataset: MarketDataset) {
  const dates = sharedTradingDates(dataset);
  return FOS_YEARS.map((year) => {
    const oos = dates.filter((d) => Number(d.slice(0, 4)) === year);
    if (!oos.length) throw new Error(`${year} OOS 거래일이 없습니다.`);
    const start = dates.indexOf(oos[0]!);
    const trainEndIndex = start - PURGE_TRADING_DAYS - 1;
    if (trainEndIndex < 0) throw new Error(`${year} Fold 이전 학습·purge 구간이 부족합니다.`);
    return {
      fold: `FOS-${year}`,
      year,
      trainFrom: dates[0]!,
      trainEnd: dates[trainEndIndex]!,
      purgeFrom: dates[trainEndIndex + 1]!,
      purgeTo: dates[start - 1]!,
      purgeTradingDays: PURGE_TRADING_DAYS,
      oosFrom: oos[0]!,
      oosTo: oos.at(-1)!,
      oosTradingDays: oos.length,
    };
  });
}

function entryThreshold(market: Market): 75 | 80 {
  return market === "KOSDAQ" ? 80 : 75;
}

function foldSupported(scenario: Scenario, year: FosYear) {
  if (scenario.triggers.some((t) => t === "LEND5" || t === "LEND20")) return year === 2022 || year === 2025;
  if (scenario.triggers.some((t) => t === "SHORT5" || t === "SHORT20")) return year === 2022 || year === 2025;
  return true;
}

function buildFoldRows(
  context: ReturnType<typeof buildPortfolioSignalContext>,
  supplyBySymbol: Map<string, SupplyPoint[]>,
  highCloseBySymbol: Map<string, Int8Array>,
  benchmarks: Map<Market, Map<string, DailyPrice>>,
  scenario: Scenario,
  applyMode: ApplyMode,
  model: Model,
  costBps: number,
): FoldRow[] {
  const tradesByKey = new Map<string, Trade[]>();
  for (const source of context.series) {
    const market = source.market as Market;
    const threshold = entryThreshold(market);
    const supply = alignSupply(source.bars, supplyBySymbol.get(source.symbol));
    const highClose = highCloseBySymbol.get(source.symbol);
    let lastExitByYear = new Map<FosYear, number>();

    for (let i = WARMUP_DAYS + 20; i + 1 < source.bars.length; i++) {
      const year = Number(source.bars[i]!.tradeDate.slice(0, 4)) as FosYear;
      if (!FOS_YEARS.includes(year) || !foldSupported(scenario, year)) continue;
      const prev = scoreWithScenario(source, i - 1, supply, highClose, scenario, model === "PENALTY", true).score;
      const curResult = scoreWithScenario(source, i, supply, highClose, scenario, model === "PENALTY", true);
      const cur = curResult.score;
      if (!crossedUp(prev, cur, threshold)) continue;
      if (!finite(cur) || cur * 10 >= UPSIDE_EXIT_THRESHOLD) continue;
      const blockedUntil = lastExitByYear.get(year) ?? -1;
      if (i <= blockedUntil) continue;
      const trade = simulateTrade(source, scenario, model, applyMode, i, supply, highClose, benchmarks, costBps, year);
      if (!trade) continue;
      lastExitByYear.set(year, source.bars.findIndex((b) => b.tradeDate === trade.exitDate));
      const key = `${market}|${year}`;
      const xs = tradesByKey.get(key) ?? [];
      xs.push(trade);
      tradesByKey.set(key, xs);
    }
  }

  const rows: FoldRow[] = [];
  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    for (const year of FOS_YEARS) {
      if (!foldSupported(scenario, year)) continue;
      const trades = tradesByKey.get(`${market}|${year}`) ?? [];
      rows.push({
        scenarioId: scenario.id,
        scenarioLabel: scenario.label,
        applyMode,
        model,
        market,
        entryThreshold: entryThreshold(market),
        foldYear: year,
        ...summarize(trades),
      });
    }
  }
  return rows;
}

function averageField(rows: FoldRow[], pick: (row: FoldRow) => number | null) {
  return round(mean(rows.map(pick).filter(finite)));
}

function classifyComparison(usable: number, improved: number, deltaAvg: number | null, deltaMedian: number | null, worst: number | null) {
  if (!usable || !finite(deltaAvg)) return "NO_COVERAGE" as const;
  if (usable >= 2 && improved === usable && deltaAvg > 0 && finite(worst) && worst > 0 && (deltaMedian ?? -Infinity) >= 0) return "PASS_STRONG" as const;
  if (usable >= 2 && improved === usable && deltaAvg > 0 && finite(worst) && worst > 0) return "PASS_TENTATIVE" as const;
  if (deltaAvg > 0 && improved >= Math.ceil(usable / 2)) return "MIXED" as const;
  return "REJECT" as const;
}

function buildComparisons(rows: FoldRow[]): ComparisonRow[] {
  const out: ComparisonRow[] = [];
  for (const scenario of SCENARIOS) {
    for (const applyMode of ["ENTRY_ONLY", "FULL_SCORE"] as const) {
      for (const market of ["KOSPI", "KOSDAQ"] as const) {
        const base = rows.filter((r) => r.scenarioId === scenario.id && r.applyMode === applyMode && r.market === market && r.model === "BASELINE");
        const penalty = rows.filter((r) => r.scenarioId === scenario.id && r.applyMode === applyMode && r.market === market && r.model === "PENALTY");
        const foldDeltas = FOS_YEARS
          .filter((year) => foldSupported(scenario, year))
          .map((year) => {
            const b = base.find((r) => r.foldYear === year);
            const p = penalty.find((r) => r.foldYear === year);
            return {
              year,
              baselineTrades: b?.trades ?? 0,
              penaltyTrades: p?.trades ?? 0,
              deltaAvgExcess: finite(b?.avgExcessReturn) && finite(p?.avgExcessReturn) ? round(p.avgExcessReturn - b.avgExcessReturn) : null,
              deltaMedianExcess: finite(b?.medianExcessReturn) && finite(p?.medianExcessReturn) ? round(p.medianExcessReturn - b.medianExcessReturn) : null,
              deltaProfitFactor: finite(b?.profitFactor) && finite(p?.profitFactor) ? round(p.profitFactor - b.profitFactor) : null,
            };
          });
        const usable = foldDeltas.filter((d) => finite(d.deltaAvgExcess) && d.baselineTrades > 0 && d.penaltyTrades > 0);
        const avgBase = averageField(base.filter((r) => usable.some((u) => u.year === r.foldYear)), (r) => r.avgExcessReturn);
        const avgPenalty = averageField(penalty.filter((r) => usable.some((u) => u.year === r.foldYear)), (r) => r.avgExcessReturn);
        const medianBase = averageField(base.filter((r) => usable.some((u) => u.year === r.foldYear)), (r) => r.medianExcessReturn);
        const medianPenalty = averageField(penalty.filter((r) => usable.some((u) => u.year === r.foldYear)), (r) => r.medianExcessReturn);
        const pfBase = averageField(base.filter((r) => usable.some((u) => u.year === r.foldYear)), (r) => r.profitFactor);
        const pfPenalty = averageField(penalty.filter((r) => usable.some((u) => u.year === r.foldYear)), (r) => r.profitFactor);
        const deltaAvg = finite(avgBase) && finite(avgPenalty) ? round(avgPenalty - avgBase) : null;
        const deltaMedian = finite(medianBase) && finite(medianPenalty) ? round(medianPenalty - medianBase) : null;
        const foldAvgDeltas = usable.map((u) => u.deltaAvgExcess).filter(finite);
        const improved = foldAvgDeltas.filter((x) => x > 0).length;
        out.push({
          scenarioId: scenario.id,
          scenarioLabel: scenario.label,
          triggers: scenario.triggers,
          penaltyPerTrigger: scenario.penaltyPerTrigger,
          applyMode,
          market,
          entryThreshold: entryThreshold(market),
          usableFoldYears: usable.map((u) => u.year),
          totalBaselineTrades: base.filter((r) => usable.some((u) => u.year === r.foldYear)).reduce((s, r) => s + r.trades, 0),
          totalPenaltyTrades: penalty.filter((r) => usable.some((u) => u.year === r.foldYear)).reduce((s, r) => s + r.trades, 0),
          tradeCountChange: penalty.filter((r) => usable.some((u) => u.year === r.foldYear)).reduce((s, r) => s + r.trades, 0) - base.filter((r) => usable.some((u) => u.year === r.foldYear)).reduce((s, r) => s + r.trades, 0),
          equalWeightBaselineAvgExcess: avgBase,
          equalWeightPenaltyAvgExcess: avgPenalty,
          deltaAvgExcess: deltaAvg,
          equalWeightBaselineMedianExcess: medianBase,
          equalWeightPenaltyMedianExcess: medianPenalty,
          deltaMedianExcess: deltaMedian,
          equalWeightBaselineProfitFactor: pfBase,
          equalWeightPenaltyProfitFactor: pfPenalty,
          deltaProfitFactor: finite(pfBase) && finite(pfPenalty) ? round(pfPenalty - pfBase) : null,
          foldsImprovedAvgExcess: improved,
          foldsImprovedMedianExcess: usable.filter((u) => (u.deltaMedianExcess ?? -Infinity) > 0).length,
          worstFoldDeltaAvgExcess: round(foldAvgDeltas.length ? Math.min(...foldAvgDeltas) : null),
          bestFoldDeltaAvgExcess: round(foldAvgDeltas.length ? Math.max(...foldAvgDeltas) : null),
          classification: classifyComparison(usable.length, improved, deltaAvg, deltaMedian, foldAvgDeltas.length ? Math.min(...foldAvgDeltas) : null),
          foldDeltas,
        });
      }
    }
  }
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = trustedSupabaseClient();
  const inputs = await loadAnalysisSourceInputs(client, options.supabaseUserId!, "backtest", { lightweight: true });
  const texts = inputs.map((input) => input.text);
  const parsed = parseManualMarketData(texts);
  const inputQuality = buildV8InputQualityReport(inputs);
  if (!inputQuality.validForV8) throw new Error(`V8 필수 입력열 검증 실패: ${JSON.stringify(inputQuality.filesInvalidRequiredColumns)}`);

  const foldPolicies = buildFoldPolicies(parsed.dataset);
  const context = buildPortfolioSignalContext(parsed.dataset, options.limit);
  if (!context.series.length) throw new Error("V8-9b 포트폴리오 신호 컨텍스트가 비어 있습니다.");
  const eligibleSymbols = new Set(context.series.map((s) => s.symbol));
  const supplyBySymbol = parseSupplyRows(texts, eligibleSymbols);
  const vfSeries = prepareV8VfFeatureSeries(parsed.dataset, options.limit, WARMUP_DAYS);
  const highCloseBySymbol = new Map(vfSeries.map((s) => [s.symbol, s.states.VOLUME_SURGE]));
  const benchmarks = benchmarkMaps(parsed.dataset);

  const foldRows: FoldRow[] = [];
  for (const scenario of SCENARIOS) {
    for (const applyMode of ["ENTRY_ONLY", "FULL_SCORE"] as const) {
      for (const model of ["BASELINE", "PENALTY"] as const) {
        foldRows.push(...buildFoldRows(context, supplyBySymbol, highCloseBySymbol, benchmarks, scenario, applyMode, model, options.roundTripCostBps));
      }
    }
  }
  const comparisons = buildComparisons(foldRows).sort((a, b) =>
    (b.deltaAvgExcess ?? -Infinity) - (a.deltaAvgExcess ?? -Infinity) ||
    (b.deltaMedianExcess ?? -Infinity) - (a.deltaMedianExcess ?? -Infinity),
  );

  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
    study: STUDY,
    engineVersion: ENGINE_VERSION,
    run: {
      id: runId,
      createdAt,
      codeVersion: codeVersion(),
      datasetVersion: parsed.dataset.version,
      asOfDate: parsed.dataset.asOfDate,
      limit: options.limit,
      roundTripCostBps: options.roundTripCostBps,
    },
    design: {
      primaryOos: "3-FOS",
      foldYears: [...FOS_YEARS],
      folds: foldPolicies,
      scoreBaseline: "10-point GATED_80 sector-PL score",
      shortSellingFeature: "short-selling volume-rate change only; amount/value feature excluded by design",
      missingPolicy: "missing-is-null-never-zero; matched baseline requires the same feature availability at entry",
      penaltyActivation: "penalty when candidate change > 0; high-close-volume penalty when VOLUME_SURGE state is true",
      penaltyWeights: [0.25, 0.5],
      applicationModes: ["ENTRY_ONLY", "FULL_SCORE"],
      marketEntries: { KOSPI: 75, KOSDAQ: 80 },
      exit: { upsideScore: 90, maxHoldingDays: 60, downsideExit: null },
      sectorPlOverheatThreshold: PL_OVERHEAT_THRESHOLD,
      scoreChange: "research-only; production 10-point score unchanged",
    },
    sourceFiles: inputs.map((input) => ({
      id: input.id,
      fileName: input.fileName,
      bytes: input.bytes,
      savedAt: input.savedAt,
      minDate: input.sourceRecord?.min_date ?? null,
      maxDate: input.sourceRecord?.max_date ?? null,
      rowCount: input.sourceRecord?.row_count ?? null,
    })),
    dataQuality: inputQuality,
    scenarios: SCENARIOS,
    foldRows,
    comparisons,
    decisionSupport: {
      passStrong: comparisons.filter((r) => r.classification === "PASS_STRONG"),
      passTentative: comparisons.filter((r) => r.classification === "PASS_TENTATIVE"),
      topByAvgExcessDelta: comparisons.slice(0, 20),
    },
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "supply-penalty-validation-3fos.json"), JSON.stringify(payload, null, 2));

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/v8-supply-penalty-validation-3fos/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  process.stdout.write(`${JSON.stringify({
    outputDir,
    remotePath,
    study: STUDY,
    run: payload.run,
    design: payload.design,
    passStrong: payload.decisionSupport.passStrong,
    passTentative: payload.decisionSupport.passTentative,
    topByAvgExcessDelta: payload.decisionSupport.topByAvgExcessDelta,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
