import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildPortfolioSignalContext, type PortfolioSeries } from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import { adjustSectorPenaltyScore } from "../src/lib/engine/sectorScoreAdjustment";
import { computeIndicators } from "../src/lib/engine/indicators";
import { DEFAULT_SCORING_CONFIG, technicalFlagsV3 } from "../src/lib/engine/scoring";
import type { DailyPrice } from "../src/lib/engine/types";
import { visitDelimitedRows } from "../src/lib/sourceData";
import { codeVersion, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

const FOLD_YEARS = [2018, 2022, 2025] as const;
const HORIZONS = [5, 20] as const;
const SUPPLY_LOOKBACK = 20;
const PL_OVERHEAT_THRESHOLD = 80;
const ENTRY_THRESHOLDS = { KOSPI: 75, KOSDAQ: 80 } as const;

type Market = keyof typeof ENTRY_THRESHOLDS;
type Trigger = "NONE" | "POSITIVE" | "Q70" | "Q80";

type PenaltyModel = {
  id: string;
  label: string;
  shortTrigger: Trigger;
  shortPenalty: number;
  lendingTrigger: Trigger;
  lendingPenalty: number;
  volumePenalty: number;
};

const MODELS: PenaltyModel[] = [
  { id: "SHORT_POS_025", label: "Short volume 20D increase · -0.25", shortTrigger: "POSITIVE", shortPenalty: 0.25, lendingTrigger: "NONE", lendingPenalty: 0, volumePenalty: 0 },
  { id: "SHORT_POS_050", label: "Short volume 20D increase · -0.50", shortTrigger: "POSITIVE", shortPenalty: 0.5, lendingTrigger: "NONE", lendingPenalty: 0, volumePenalty: 0 },
  { id: "SHORT_Q70_025", label: "Short volume 20D top30% increase · -0.25", shortTrigger: "Q70", shortPenalty: 0.25, lendingTrigger: "NONE", lendingPenalty: 0, volumePenalty: 0 },
  { id: "SHORT_Q70_050", label: "Short volume 20D top30% increase · -0.50", shortTrigger: "Q70", shortPenalty: 0.5, lendingTrigger: "NONE", lendingPenalty: 0, volumePenalty: 0 },
  { id: "SHORT_Q80_025", label: "Short volume 20D top20% increase · -0.25", shortTrigger: "Q80", shortPenalty: 0.25, lendingTrigger: "NONE", lendingPenalty: 0, volumePenalty: 0 },
  { id: "SHORT_Q80_050", label: "Short volume 20D top20% increase · -0.50", shortTrigger: "Q80", shortPenalty: 0.5, lendingTrigger: "NONE", lendingPenalty: 0, volumePenalty: 0 },
  { id: "LEND_POS_025", label: "Lending balance 20D increase · -0.25", shortTrigger: "NONE", shortPenalty: 0, lendingTrigger: "POSITIVE", lendingPenalty: 0.25, volumePenalty: 0 },
  { id: "LEND_POS_050", label: "Lending balance 20D increase · -0.50", shortTrigger: "NONE", shortPenalty: 0, lendingTrigger: "POSITIVE", lendingPenalty: 0.5, volumePenalty: 0 },
  { id: "LEND_Q70_025", label: "Lending balance 20D top30% increase · -0.25", shortTrigger: "NONE", shortPenalty: 0, lendingTrigger: "Q70", lendingPenalty: 0.25, volumePenalty: 0 },
  { id: "LEND_Q70_050", label: "Lending balance 20D top30% increase · -0.50", shortTrigger: "NONE", shortPenalty: 0, lendingTrigger: "Q70", lendingPenalty: 0.5, volumePenalty: 0 },
  { id: "LEND_Q80_025", label: "Lending balance 20D top20% increase · -0.25", shortTrigger: "NONE", shortPenalty: 0, lendingTrigger: "Q80", lendingPenalty: 0.25, volumePenalty: 0 },
  { id: "LEND_Q80_050", label: "Lending balance 20D top20% increase · -0.50", shortTrigger: "NONE", shortPenalty: 0, lendingTrigger: "Q80", lendingPenalty: 0.5, volumePenalty: 0 },
  { id: "VOLUME_025", label: "High-close-volume · -0.25", shortTrigger: "NONE", shortPenalty: 0, lendingTrigger: "NONE", lendingPenalty: 0, volumePenalty: 0.25 },
  { id: "VOLUME_050", label: "High-close-volume · -0.50", shortTrigger: "NONE", shortPenalty: 0, lendingTrigger: "NONE", lendingPenalty: 0, volumePenalty: 0.5 },
  { id: "SHORT_LEND_Q80_025", label: "Short Q80 + Lending Q80 · each -0.25", shortTrigger: "Q80", shortPenalty: 0.25, lendingTrigger: "Q80", lendingPenalty: 0.25, volumePenalty: 0 },
  { id: "SHORT_LEND_Q80_050", label: "Short Q80 + Lending Q80 · each -0.50", shortTrigger: "Q80", shortPenalty: 0.5, lendingTrigger: "Q80", lendingPenalty: 0.5, volumePenalty: 0 },
  { id: "ALL_Q80_025", label: "Short Q80 + Lending Q80 + Volume · each -0.25", shortTrigger: "Q80", shortPenalty: 0.25, lendingTrigger: "Q80", lendingPenalty: 0.25, volumePenalty: 0.25 },
  { id: "ALL_Q80_050", label: "Short Q80 + Lending Q80 + Volume · each -0.50", shortTrigger: "Q80", shortPenalty: 0.5, lendingTrigger: "Q80", lendingPenalty: 0.5, volumePenalty: 0.5 },
  { id: "MIX_Q80", label: "Short Q80 -0.50 + Lending Q80 -0.50 + Volume -0.25", shortTrigger: "Q80", shortPenalty: 0.5, lendingTrigger: "Q80", lendingPenalty: 0.5, volumePenalty: 0.25 },
];

interface SupplyPoint {
  date: string;
  shortVolumeRate: number | null;
  lendingBalanceQuantity: number | null;
}

interface PreparedSeries {
  source: PortfolioSeries;
  short20: Float64Array;
  lending20: Float64Array;
  volumeState: Int8Array;
}

interface Outcome {
  ret: number;
  excess: number;
  mae: number;
  mfe: number;
}

interface Metric {
  count: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  profitFactor: number | null;
  avgExcess: number | null;
  medianExcess: number | null;
  excessWinRate: number | null;
  avgMae: number | null;
  avgMfe: number | null;
}

const finite = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value);
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
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
function quantile(values: number[], q: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}
function parseNumber(value: string | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "-" || /^(null|none|nan|na)$/i.test(raw)) return null;
  const parsed = Number(raw.replace(/[, ₩원%]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
function normalizeDate(value: string | undefined) {
  const digits = String(value ?? "").replace(/[^\d]/g, "").slice(0, 8);
  if (digits.length !== 8) return null;
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
        const header = new Map(cells.map((name, i) => [compactHeader(name), i]));
        idx = {
          symbol: indexOfAny(header, ["symbol", "stockcode", "code", "ticker"]),
          date: indexOfAny(header, ["date", "tradedate"]),
          shortVolumeRate: indexOfAny(header, ["shortsellingvolumerate", "shortsellingtradingvolumerelativeimportance"]),
          lendingBalanceQuantity: indexOfAny(header, ["lendingbalancequantity"]),
        };
        return;
      }
      if (!idx || idx.symbol < 0 || idx.date < 0) return;
      const symbol = normalizeSymbol(cells[idx.symbol]);
      if (!eligibleSymbols.has(symbol)) return;
      const date = normalizeDate(cells[idx.date]);
      if (!date) return;
      const point: SupplyPoint = {
        date,
        shortVolumeRate: idx.shortVolumeRate >= 0 ? parseNumber(cells[idx.shortVolumeRate]) : null,
        lendingBalanceQuantity: idx.lendingBalanceQuantity >= 0 ? parseNumber(cells[idx.lendingBalanceQuantity]) : null,
      };
      const list = bySymbol.get(symbol) ?? [];
      list.push(point);
      bySymbol.set(symbol, list);
    });
  }
  for (const [symbol, rows] of bySymbol) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const merged: SupplyPoint[] = [];
    for (const row of rows) {
      const last = merged.at(-1);
      if (!last || last.date !== row.date) {
        merged.push(row);
      } else {
        if (!finite(last.shortVolumeRate) && finite(row.shortVolumeRate)) last.shortVolumeRate = row.shortVolumeRate;
        if (!finite(last.lendingBalanceQuantity) && finite(row.lendingBalanceQuantity)) last.lendingBalanceQuantity = row.lendingBalanceQuantity;
      }
    }
    bySymbol.set(symbol, merged);
  }
  return bySymbol;
}

function nanArray(length: number) {
  const values = new Float64Array(length);
  values.fill(Number.NaN);
  return values;
}

function prepareSeries(source: PortfolioSeries, supply: SupplyPoint[] | undefined): PreparedSeries {
  const shortRaw = nanArray(source.bars.length);
  const lendingRaw = nanArray(source.bars.length);
  const short20 = nanArray(source.bars.length);
  const lending20 = nanArray(source.bars.length);
  const volumeState = new Int8Array(source.bars.length);
  volumeState.fill(-1);
  const byDate = new Map((supply ?? []).map((row) => [row.date, row]));
  for (let i = 0; i < source.bars.length; i++) {
    const row = byDate.get(source.bars[i]!.tradeDate);
    if (row) {
      if (finite(row.shortVolumeRate)) shortRaw[i] = row.shortVolumeRate;
      if (finite(row.lendingBalanceQuantity)) lendingRaw[i] = row.lendingBalanceQuantity;
    }
    if (i >= SUPPLY_LOOKBACK) {
      if (Number.isFinite(shortRaw[i]) && Number.isFinite(shortRaw[i - SUPPLY_LOOKBACK])) {
        short20[i] = shortRaw[i] - shortRaw[i - SUPPLY_LOOKBACK];
      }
      if (Number.isFinite(lendingRaw[i]) && Number.isFinite(lendingRaw[i - SUPPLY_LOOKBACK]) && lendingRaw[i - SUPPLY_LOOKBACK] > 0) {
        lending20[i] = (lendingRaw[i] / lendingRaw[i - SUPPLY_LOOKBACK] - 1) * 100;
      }
    }
    if (i >= 120) {
      const flag = technicalFlagsV3(computeIndicators(source.bars, i), DEFAULT_SCORING_CONFIG).highCloseVolume;
      volumeState[i] = flag === null ? -1 : flag ? 1 : 0;
    }
  }
  return { source, short20, lending20, volumeState };
}

function buildThresholds(series: PreparedSeries[]) {
  const shortValues = new Map<string, number[]>();
  const lendingValues = new Map<string, number[]>();
  for (const item of series) {
    const market = item.source.market as Market;
    for (let i = SUPPLY_LOOKBACK; i < item.source.bars.length; i++) {
      const key = `${market}|${item.source.bars[i]!.tradeDate}`;
      if (Number.isFinite(item.short20[i])) {
        const list = shortValues.get(key) ?? [];
        list.push(item.short20[i]!);
        shortValues.set(key, list);
      }
      if (Number.isFinite(item.lending20[i])) {
        const list = lendingValues.get(key) ?? [];
        list.push(item.lending20[i]!);
        lendingValues.set(key, list);
      }
    }
  }
  const out = new Map<string, { shortQ70: number | null; shortQ80: number | null; lendingQ70: number | null; lendingQ80: number | null }>();
  const keys = new Set([...shortValues.keys(), ...lendingValues.keys()]);
  for (const key of keys) {
    const s = shortValues.get(key) ?? [];
    const l = lendingValues.get(key) ?? [];
    out.set(key, {
      shortQ70: s.length >= 30 ? quantile(s, 0.7) : null,
      shortQ80: s.length >= 30 ? quantile(s, 0.8) : null,
      lendingQ70: l.length >= 30 ? quantile(l, 0.7) : null,
      lendingQ80: l.length >= 30 ? quantile(l, 0.8) : null,
    });
  }
  return out;
}

function trigger(value: number, kind: Trigger, q70: number | null, q80: number | null) {
  if (kind === "NONE") return false;
  if (kind === "POSITIVE") return value > 0;
  if (kind === "Q70") return finite(q70) ? value >= q70 : null;
  return finite(q80) ? value >= q80 : null;
}

function penaltyAt(model: PenaltyModel, item: PreparedSeries, i: number, thresholds: ReturnType<typeof buildThresholds>) {
  const market = item.source.market as Market;
  const date = item.source.bars[i]?.tradeDate;
  if (!date) return null;
  const q = thresholds.get(`${market}|${date}`);
  let penalty = 0;
  if (model.shortTrigger !== "NONE") {
    const value = item.short20[i];
    if (!Number.isFinite(value)) return null;
    const hit = trigger(value, model.shortTrigger, q?.shortQ70 ?? null, q?.shortQ80 ?? null);
    if (hit === null) return null;
    if (hit) penalty += model.shortPenalty;
  }
  if (model.lendingTrigger !== "NONE") {
    const value = item.lending20[i];
    if (!Number.isFinite(value)) return null;
    const hit = trigger(value, model.lendingTrigger, q?.lendingQ70 ?? null, q?.lendingQ80 ?? null);
    if (hit === null) return null;
    if (hit) penalty += model.lendingPenalty;
  }
  if (model.volumePenalty > 0) {
    const value = item.volumeState[i];
    if (value < 0) return null;
    if (value === 1) penalty += model.volumePenalty;
  }
  return penalty;
}

function baselineScore(source: PortfolioSeries, i: number) {
  const base = source.baseScores[i];
  if (!finite(base)) return null;
  return adjustSectorPenaltyScore(base, source.sectorPriceLeadership[i] ?? null, PL_OVERHEAT_THRESHOLD).score;
}
function crossedUp(prev: number | null, current: number | null, threshold: number) {
  return finite(prev) && finite(current) && prev * 10 < threshold && current * 10 >= threshold;
}

function benchmarkMaps(dataset: ReturnType<typeof parseManualMarketData>["dataset"]) {
  return {
    KOSPI: new Map((dataset.indexSeries.find((s) => s.indexCode.toUpperCase() === "KOSPI")?.bars ?? []).map((b) => [b.tradeDate, b])),
    KOSDAQ: new Map((dataset.indexSeries.find((s) => s.indexCode.toUpperCase() === "KOSDAQ")?.bars ?? []).map((b) => [b.tradeDate, b])),
  } as const;
}

function outcome(item: PreparedSeries, i: number, horizon: number, benchmark: Map<string, DailyPrice>): Outcome | null {
  if (i + horizon >= item.source.bars.length) return null;
  const entry = item.source.bars[i + 1];
  const exit = item.source.bars[i + horizon];
  if (!entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exit.close) || exit.close <= 0) return null;
  const bEntry = benchmark.get(entry.tradeDate);
  const bExit = benchmark.get(exit.tradeDate);
  if (!bEntry || !bExit || !finite(bEntry.open) || bEntry.open <= 0 || !finite(bExit.close) || bExit.close <= 0) return null;
  const ret = (exit.close / entry.open - 1) * 100;
  const bRet = (bExit.close / bEntry.open - 1) * 100;
  let lo = entry.open;
  let hi = entry.open;
  for (let j = i + 1; j <= i + horizon; j++) {
    const bar = item.source.bars[j]!;
    if (finite(bar.low) && bar.low > 0) lo = Math.min(lo, bar.low);
    if (finite(bar.high) && bar.high > 0) hi = Math.max(hi, bar.high);
  }
  return { ret, excess: ret - bRet, mae: (lo / entry.open - 1) * 100, mfe: (hi / entry.open - 1) * 100 };
}

function metric(outcomes: Outcome[]): Metric {
  const returns = outcomes.map((x) => x.ret);
  const excess = outcomes.map((x) => x.excess);
  const positive = returns.filter((x) => x > 0).length;
  const excessPositive = excess.filter((x) => x > 0).length;
  const gains = returns.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(returns.filter((x) => x < 0).reduce((a, b) => a + b, 0));
  return {
    count: outcomes.length,
    avgReturn: round(mean(returns)),
    medianReturn: round(median(returns)),
    winRate: outcomes.length ? round(positive / outcomes.length * 100) : null,
    profitFactor: losses > 0 ? round(gains / losses) : null,
    avgExcess: round(mean(excess)),
    medianExcess: round(median(excess)),
    excessWinRate: outcomes.length ? round(excessPositive / outcomes.length * 100) : null,
    avgMae: round(mean(outcomes.map((x) => x.mae))),
    avgMfe: round(mean(outcomes.map((x) => x.mfe))),
  };
}

function delta(a: number | null, b: number | null) {
  return finite(a) && finite(b) ? round(a - b) : null;
}

async function main() {
  const userIdIndex = process.argv.indexOf("--supabase-user-id");
  const userId = userIdIndex >= 0 ? process.argv[userIdIndex + 1] : null;
  const upload = process.argv.includes("--upload");
  if (!userId) throw new Error("--supabase-user-id is required");

  const client = trustedSupabaseClient();
  const inputs = await loadAnalysisSourceInputs(client, userId, "backtest", { lightweight: true });
  const parsed = parseManualMarketData(inputs.map((input) => input.text));
  const quality = buildV8InputQualityReport(inputs);
  if (!quality.validForV8) throw new Error("V8 input quality contract failed");

  const context = buildPortfolioSignalContext(parsed.dataset, 613);
  const eligibleSymbols = new Set(context.series.map((s) => s.symbol));
  const supply = parseSupplyRows(inputs.map((input) => input.text), eligibleSymbols);
  const prepared = context.series.map((source) => prepareSeries(source, supply.get(source.symbol)));
  const thresholds = buildThresholds(prepared);
  const benchmarks = benchmarkMaps(parsed.dataset);

  const rows: any[] = [];
  for (const model of MODELS) {
    for (const market of ["KOSPI", "KOSDAQ"] as const) {
      const entryThreshold = ENTRY_THRESHOLDS[market];
      for (const horizon of HORIZONS) {
        const foldRows: any[] = [];
        for (const year of FOLD_YEARS) {
          const baselineOutcomes: Outcome[] = [];
          const adjustedOutcomes: Outcome[] = [];
          const filteredOutcomes: Outcome[] = [];
          let baselineOnsets = 0;
          let adjustedOnsets = 0;
          let penaltyReleaseOnsets = 0;
          let eligibleStockDays = 0;
          let penalizedStockDays = 0;

          for (const item of prepared) {
            if (item.source.market !== market) continue;
            const benchmark = benchmarks[market];
            for (let i = 121; i + horizon < item.source.bars.length; i++) {
              const date = item.source.bars[i]!.tradeDate;
              if (Number(date.slice(0, 4)) !== year) continue;
              const pPrev = penaltyAt(model, item, i - 1, thresholds);
              const pCur = penaltyAt(model, item, i, thresholds);
              if (!finite(pPrev) || !finite(pCur)) continue;
              const basePrev = baselineScore(item.source, i - 1);
              const baseCur = baselineScore(item.source, i);
              if (!finite(basePrev) || !finite(baseCur)) continue;
              eligibleStockDays++;
              if (pCur > 0) penalizedStockDays++;
              const adjustedPrev = Math.max(0, basePrev - pPrev);
              const adjustedCur = Math.max(0, baseCur - pCur);
              const baselineOnset = crossedUp(basePrev, baseCur, entryThreshold);
              const adjustedOnset = crossedUp(adjustedPrev, adjustedCur, entryThreshold);
              if (baselineOnset) {
                baselineOnsets++;
                const result = outcome(item, i, horizon, benchmark);
                if (result) {
                  baselineOutcomes.push(result);
                  if (pCur === 0) filteredOutcomes.push(result);
                }
              }
              if (adjustedOnset) {
                adjustedOnsets++;
                if (!baselineOnset) penaltyReleaseOnsets++;
                const result = outcome(item, i, horizon, benchmark);
                if (result) adjustedOutcomes.push(result);
              }
            }
          }

          const baseline = metric(baselineOutcomes);
          const adjusted = metric(adjustedOutcomes);
          const filtered = metric(filteredOutcomes);
          foldRows.push({
            year,
            eligibleStockDays,
            penalizedStockDays,
            penaltyRate: eligibleStockDays ? round(penalizedStockDays / eligibleStockDays * 100) : null,
            baselineOnsets,
            adjustedOnsets,
            penaltyReleaseOnsets,
            baseline,
            adjusted,
            filtered,
            deltaAdjustedVsBaseline: {
              avgExcess: delta(adjusted.avgExcess, baseline.avgExcess),
              medianExcess: delta(adjusted.medianExcess, baseline.medianExcess),
              profitFactor: delta(adjusted.profitFactor, baseline.profitFactor),
              avgMae: delta(adjusted.avgMae, baseline.avgMae),
            },
            deltaFilterVsBaseline: {
              avgExcess: delta(filtered.avgExcess, baseline.avgExcess),
              medianExcess: delta(filtered.medianExcess, baseline.medianExcess),
              profitFactor: delta(filtered.profitFactor, baseline.profitFactor),
              avgMae: delta(filtered.avgMae, baseline.avgMae),
            },
          });
        }

        const usable = foldRows.filter((row) => row.baseline.count >= 10 && row.adjusted.count >= 10 && finite(row.deltaAdjustedVsBaseline.avgExcess));
        const filterUsable = foldRows.filter((row) => row.baseline.count >= 10 && row.filtered.count >= 10 && finite(row.deltaFilterVsBaseline.avgExcess));
        rows.push({
          modelId: model.id,
          label: model.label,
          market,
          horizon,
          entryThreshold,
          folds: foldRows,
          threeFos: {
            usableYears: usable.map((row) => row.year),
            usableFoldCount: usable.length,
            positiveAvgExcessDeltaFolds: usable.filter((row) => row.deltaAdjustedVsBaseline.avgExcess > 0).length,
            meanAvgExcessDelta: round(mean(usable.map((row) => row.deltaAdjustedVsBaseline.avgExcess))),
            meanMedianExcessDelta: round(mean(usable.map((row) => row.deltaAdjustedVsBaseline.medianExcess).filter(finite))),
            meanProfitFactorDelta: round(mean(usable.map((row) => row.deltaAdjustedVsBaseline.profitFactor).filter(finite))),
            meanMaeDelta: round(mean(usable.map((row) => row.deltaAdjustedVsBaseline.avgMae).filter(finite))),
            worstAvgExcessDelta: usable.length ? round(Math.min(...usable.map((row) => row.deltaAdjustedVsBaseline.avgExcess))) : null,
            totalBaselineTrades: usable.reduce((sum, row) => sum + row.baseline.count, 0),
            totalAdjustedTrades: usable.reduce((sum, row) => sum + row.adjusted.count, 0),
            totalPenaltyReleaseOnsets: usable.reduce((sum, row) => sum + row.penaltyReleaseOnsets, 0),
          },
          entryFilter: {
            usableYears: filterUsable.map((row) => row.year),
            usableFoldCount: filterUsable.length,
            positiveAvgExcessDeltaFolds: filterUsable.filter((row) => row.deltaFilterVsBaseline.avgExcess > 0).length,
            meanAvgExcessDelta: round(mean(filterUsable.map((row) => row.deltaFilterVsBaseline.avgExcess))),
            meanMedianExcessDelta: round(mean(filterUsable.map((row) => row.deltaFilterVsBaseline.medianExcess).filter(finite))),
            meanProfitFactorDelta: round(mean(filterUsable.map((row) => row.deltaFilterVsBaseline.profitFactor).filter(finite))),
            meanMaeDelta: round(mean(filterUsable.map((row) => row.deltaFilterVsBaseline.avgMae).filter(finite))),
            worstAvgExcessDelta: filterUsable.length ? round(Math.min(...filterUsable.map((row) => row.deltaFilterVsBaseline.avgExcess))) : null,
          },
        });
      }
    }
  }

  const ranking = rows
    .filter((row) => row.market === "KOSDAQ" && row.horizon === 20 && row.threeFos.usableFoldCount >= 2)
    .sort((a, b) =>
      b.threeFos.positiveAvgExcessDeltaFolds - a.threeFos.positiveAvgExcessDeltaFolds ||
      (b.threeFos.worstAvgExcessDelta ?? -Infinity) - (a.threeFos.worstAvgExcessDelta ?? -Infinity) ||
      (b.threeFos.meanAvgExcessDelta ?? -Infinity) - (a.threeFos.meanAvgExcessDelta ?? -Infinity),
    )
    .slice(0, 12)
    .map((row) => ({
      modelId: row.modelId,
      label: row.label,
      usableYears: row.threeFos.usableYears,
      positiveFolds: row.threeFos.positiveAvgExcessDeltaFolds,
      meanAvgExcessDelta: row.threeFos.meanAvgExcessDelta,
      meanMedianExcessDelta: row.threeFos.meanMedianExcessDelta,
      meanProfitFactorDelta: row.threeFos.meanProfitFactorDelta,
      meanMaeDelta: row.threeFos.meanMaeDelta,
      worstAvgExcessDelta: row.threeFos.worstAvgExcessDelta,
      baselineTrades: row.threeFos.totalBaselineTrades,
      adjustedTrades: row.threeFos.totalAdjustedTrades,
      penaltyReleaseOnsets: row.threeFos.totalPenaltyReleaseOnsets,
      filterMeanAvgExcessDelta: row.entryFilter.meanAvgExcessDelta,
    }));

  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
    study: "V8-9b",
    title: "Penalty Structure Validation",
    run: {
      id: runId,
      createdAt,
      codeVersion: codeVersion(),
      datasetVersion: parsed.dataset.version,
      asOfDate: parsed.dataset.asOfDate,
      symbolCount: context.symbolCount,
    },
    policy: {
      primaryOos: "3-FOS",
      foldYears: [...FOLD_YEARS],
      supplyLookback: SUPPLY_LOOKBACK,
      horizons: [...HORIZONS],
      marketEntryThresholds: ENTRY_THRESHOLDS,
      baselineScore: "existing V8 10-point score; sector PL +0.5 unless PL>=80; missing PL gets no slot",
      shortFeature: "20D change in short-selling volume rate only; short-selling amount rate excluded",
      lendingFeature: "20D percent change in lending balance quantity",
      volumeFeature: "existing high-close-volume flag",
      quantiles: "same-date same-market cross-sectional Q70/Q80; minimum 30 observations",
      missingPolicy: "missing is ineligible for that model, never zero",
      comparison: "each model compared with baseline on the same model-eligible stock-days",
      adjustedOnset: "penalties are subtracted before onset detection",
      filterDiagnostic: "baseline onset retained only when current penalty is zero",
      scoringChange: "research only; production 10-point score unchanged",
    },
    models: MODELS,
    dataQuality: quality,
    rows,
    ranking,
    notes: [
      "Supply-data models have no 2018 coverage and therefore normally use 2022/2025 only; volume-only models can use all three folds.",
      "Penalty-release onset count is reported because a disappearing penalty can itself cause an adjusted-score onset; large counts are a warning against embedding the penalty directly into onset score.",
      "Entry-filter diagnostic tests the same adverse trigger as a veto on baseline onset, which avoids penalty-release-created entries.",
    ],
  };

  const outputDir = path.resolve("v8-penalty-structure-3fos-runs", runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "penalty-structure-validation-3fos.json"), JSON.stringify(payload, null, 2));
  let remotePath: string | null = null;
  if (upload) {
    remotePath = `${userId}/results/v8-penalty-structure-validation-3fos/latest.json`;
    await uploadJson(client, remotePath, payload);
  }
  process.stdout.write(`${JSON.stringify({ outputDir, remotePath, study: payload.study, run: payload.run, policy: payload.policy, ranking }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
