import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildPortfolioSignalContext, type PortfolioSeries } from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import { adjustSectorPenaltyScore } from "../src/lib/engine/sectorScoreAdjustment";
import type { DailyPrice } from "../src/lib/engine/types";
import { codeVersion, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

const STUDY = "V8-9c" as const;
const ENGINE_VERSION = "CloudTrend V8-9c Volume Surge Refinement 3-FOS" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const HORIZONS = [5, 20] as const;
const PL_OVERHEAT_THRESHOLD = 80;
const ENTRY_THRESHOLDS = { KOSPI: 7.5, KOSDAQ: 8.0 } as const;
const PURGE_TRADING_DAYS = 60;

type Market = keyof typeof ENTRY_THRESHOLDS;
type FoldYear = (typeof FOLD_YEARS)[number];
type ModelKind =
  | "CURRENT"
  | "NEGATIVE_CURRENT"
  | "NO_VOLUME"
  | "CURRENT_RET_POS"
  | "CURRENT_RET_2"
  | "CURRENT_RET_0_TO_5"
  | "VOL200_CLV70"
  | "VOL150_CLV80"
  | "VOL200_CLV80"
  | "VOL200_CLV80_RET_POS"
  | "VOL200_CLV80_RET_2";

interface ModelSpec {
  id: string;
  label: string;
  kind: ModelKind;
}

const MODELS: ModelSpec[] = [
  { id: "BASELINE_CURRENT", label: "현재: 거래량 150% + CLV 0.70 -> +0.5", kind: "CURRENT" },
  { id: "NEGATIVE_CURRENT", label: "현재 Volume Surge 발생 -> -0.5", kind: "NEGATIVE_CURRENT" },
  { id: "NO_VOLUME", label: "Volume Surge 배점 제거 -> 0점", kind: "NO_VOLUME" },
  { id: "RET_POS", label: "거래량 150% + CLV 0.70 + 당일수익률 > 0 -> +0.5", kind: "CURRENT_RET_POS" },
  { id: "RET_2", label: "거래량 150% + CLV 0.70 + 당일수익률 >= 2% -> +0.5", kind: "CURRENT_RET_2" },
  { id: "RET_0_TO_5", label: "거래량 150% + CLV 0.70 + 0% < 당일수익률 <= 5% -> +0.5", kind: "CURRENT_RET_0_TO_5" },
  { id: "VOL200", label: "거래량 200% + CLV 0.70 -> +0.5", kind: "VOL200_CLV70" },
  { id: "CLV80", label: "거래량 150% + CLV 0.80 -> +0.5", kind: "VOL150_CLV80" },
  { id: "VOL200_CLV80", label: "거래량 200% + CLV 0.80 -> +0.5", kind: "VOL200_CLV80" },
  { id: "VOL200_CLV80_RET_POS", label: "거래량 200% + CLV 0.80 + 당일수익률 > 0 -> +0.5", kind: "VOL200_CLV80_RET_POS" },
  { id: "VOL200_CLV80_RET_2", label: "거래량 200% + CLV 0.80 + 당일수익률 >= 2% -> +0.5", kind: "VOL200_CLV80_RET_2" },
];

interface PreparedSeries {
  source: PortfolioSeries;
  volumeRatio20: Float64Array;
  clv: Float64Array;
  dayReturn: Float64Array;
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

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)]! + s[Math.ceil(m)]!) / 2;
}
function round(v: number | null, digits = 6) {
  if (!finite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
function crossedUp(prev: number | null, cur: number | null, threshold: number) {
  return finite(prev) && finite(cur) && prev < threshold && cur >= threshold;
}
function nanArray(length: number) {
  const out = new Float64Array(length);
  out.fill(Number.NaN);
  return out;
}

function prepareSeries(source: PortfolioSeries): PreparedSeries {
  const n = source.bars.length;
  const volumeRatio20 = nanArray(n);
  const clv = nanArray(n);
  const dayReturn = nanArray(n);
  const prefixVolume = new Float64Array(n + 1);
  const prefixPositive = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const bar = source.bars[i]!;
    const vol = finite(bar.volume) ? bar.volume : 0;
    prefixVolume[i + 1] = prefixVolume[i]! + vol;
    prefixPositive[i + 1] = prefixPositive[i]! + (vol > 0 ? 1 : 0);
    const range = bar.high - bar.low;
    if (finite(range) && range > 0) clv[i] = (bar.close - bar.low) / range;
    const prev = source.bars[i - 1]?.close;
    if (finite(prev) && prev !== 0) dayReturn[i] = bar.close / prev - 1;
    if (i >= 20) {
      const start = i - 20;
      const sum = prefixVolume[i]! - prefixVolume[start]!;
      const positives = prefixPositive[i]! - prefixPositive[start]!;
      if (positives >= 10) {
        const avg = sum / 20;
        if (avg > 0) volumeRatio20[i] = Math.min((bar.volume / avg) * 100, 9999);
      }
    }
  }
  return { source, volumeRatio20, clv, dayReturn };
}

function currentSurge(item: PreparedSeries, i: number) {
  const v = item.volumeRatio20[i];
  const c = item.clv[i];
  return Number.isFinite(v) && Number.isFinite(c) ? v >= 150 && c >= 0.7 : null;
}

function modelVolumePoints(model: ModelSpec, item: PreparedSeries, i: number): number | null {
  const v = item.volumeRatio20[i];
  const c = item.clv[i];
  const r = item.dayReturn[i];
  if (!Number.isFinite(v) || !Number.isFinite(c) || !Number.isFinite(r)) return null;
  const cur = v >= 150 && c >= 0.7;
  switch (model.kind) {
    case "CURRENT": return cur ? 0.5 : 0;
    case "NEGATIVE_CURRENT": return cur ? -0.5 : 0;
    case "NO_VOLUME": return 0;
    case "CURRENT_RET_POS": return cur && r > 0 ? 0.5 : 0;
    case "CURRENT_RET_2": return cur && r >= 0.02 ? 0.5 : 0;
    case "CURRENT_RET_0_TO_5": return cur && r > 0 && r <= 0.05 ? 0.5 : 0;
    case "VOL200_CLV70": return v >= 200 && c >= 0.7 ? 0.5 : 0;
    case "VOL150_CLV80": return v >= 150 && c >= 0.8 ? 0.5 : 0;
    case "VOL200_CLV80": return v >= 200 && c >= 0.8 ? 0.5 : 0;
    case "VOL200_CLV80_RET_POS": return v >= 200 && c >= 0.8 && r > 0 ? 0.5 : 0;
    case "VOL200_CLV80_RET_2": return v >= 200 && c >= 0.8 && r >= 0.02 ? 0.5 : 0;
  }
}

function scoreAt(model: ModelSpec, item: PreparedSeries, i: number) {
  const base = item.source.baseScores[i];
  if (!finite(base)) return null;
  const surge = currentSurge(item, i);
  const variant = modelVolumePoints(model, item, i);
  if (surge === null || variant === null) return null;
  const originalVolumePoints = surge ? 0.5 : 0;
  const raw9p5 = base - originalVolumePoints + variant;
  return adjustSectorPenaltyScore(raw9p5, item.source.sectorPriceLeadership[i] ?? null, PL_OVERHEAT_THRESHOLD).score;
}

function baselineNativeScore(item: PreparedSeries, i: number) {
  const base = item.source.baseScores[i];
  if (!finite(base)) return null;
  return adjustSectorPenaltyScore(base, item.source.sectorPriceLeadership[i] ?? null, PL_OVERHEAT_THRESHOLD).score;
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

function metric(xs: Outcome[]): Metric {
  const returns = xs.map((x) => x.ret);
  const excess = xs.map((x) => x.excess);
  const gains = returns.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(returns.filter((x) => x < 0).reduce((a, b) => a + b, 0));
  return {
    count: xs.length,
    avgReturn: round(mean(returns)),
    medianReturn: round(median(returns)),
    winRate: xs.length ? round(returns.filter((x) => x > 0).length / xs.length * 100) : null,
    profitFactor: losses > 0 ? round(gains / losses) : null,
    avgExcess: round(mean(excess)),
    medianExcess: round(median(excess)),
    excessWinRate: xs.length ? round(excess.filter((x) => x > 0).length / xs.length * 100) : null,
    avgMae: round(mean(xs.map((x) => x.mae))),
    avgMfe: round(mean(xs.map((x) => x.mfe))),
  };
}

function delta(a: number | null, b: number | null) {
  return finite(a) && finite(b) ? round(a - b) : null;
}

function sharedTradingDates(dataset: ReturnType<typeof parseManualMarketData>["dataset"]) {
  const kospi = new Set(dataset.indexSeries.find((s) => s.indexCode.toUpperCase() === "KOSPI")?.bars.map((b) => b.tradeDate) ?? []);
  const kosdaq = new Set(dataset.indexSeries.find((s) => s.indexCode.toUpperCase() === "KOSDAQ")?.bars.map((b) => b.tradeDate) ?? []);
  return [...kospi].filter((d) => kosdaq.has(d)).sort();
}

function foldPolicies(dataset: ReturnType<typeof parseManualMarketData>["dataset"]) {
  const dates = sharedTradingDates(dataset);
  return FOLD_YEARS.map((year) => {
    const oosDates = dates.filter((d) => Number(d.slice(0, 4)) === year);
    if (!oosDates.length) throw new Error(`${year} OOS dates missing`);
    const oosFrom = oosDates[0]!;
    const oosStart = dates.indexOf(oosFrom);
    const trainEnd = oosStart - PURGE_TRADING_DAYS - 1;
    if (trainEnd < 0) throw new Error(`${year} purge window unavailable`);
    return {
      fold: `FOS-${year}`,
      year,
      trainFrom: dates[0]!,
      trainEnd: dates[trainEnd]!,
      purgeFrom: dates[trainEnd + 1]!,
      purgeTo: dates[oosStart - 1]!,
      purgeTradingDays: PURGE_TRADING_DAYS,
      oosFrom,
      oosTo: oosDates.at(-1)!,
      oosTradingDays: oosDates.length,
    };
  });
}

function summarizeThreeFos(folds: any[]) {
  const usable = folds.filter((f) => f.baseline.count >= 10 && f.model.count >= 10 && finite(f.delta.avgExcess));
  return {
    usableYears: usable.map((f) => f.year),
    usableFoldCount: usable.length,
    positiveAvgExcessDeltaFolds: usable.filter((f) => f.delta.avgExcess > 0).length,
    positiveMedianExcessDeltaFolds: usable.filter((f) => finite(f.delta.medianExcess) && f.delta.medianExcess > 0).length,
    meanAvgExcessDelta: round(mean(usable.map((f) => f.delta.avgExcess).filter(finite))),
    meanMedianExcessDelta: round(mean(usable.map((f) => f.delta.medianExcess).filter(finite))),
    meanProfitFactorDelta: round(mean(usable.map((f) => f.delta.profitFactor).filter(finite))),
    meanMaeDelta: round(mean(usable.map((f) => f.delta.avgMae).filter(finite))),
    worstAvgExcessDelta: usable.length ? round(Math.min(...usable.map((f) => f.delta.avgExcess))) : null,
    totalBaselineTrades: usable.reduce((s, f) => s + f.baseline.count, 0),
    totalModelTrades: usable.reduce((s, f) => s + f.model.count, 0),
    totalRetainedBaselineOnsets: usable.reduce((s, f) => s + f.retainedBaselineOnsets, 0),
    totalNewOnsets: usable.reduce((s, f) => s + f.newOnsets, 0),
    totalLostOnsets: usable.reduce((s, f) => s + f.lostOnsets, 0),
  };
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
  const prepared = context.series.map(prepareSeries);
  const benchmarks = benchmarkMaps(parsed.dataset);
  const foldPolicy = foldPolicies(parsed.dataset);

  // Reconstructed CURRENT score must match the native baseline exactly.
  let checked = 0;
  let mismatches = 0;
  const baselineModel = MODELS[0]!;
  for (const item of prepared) {
    for (let i = 252; i < item.source.bars.length; i += 37) {
      const a = baselineNativeScore(item, i);
      const b = scoreAt(baselineModel, item, i);
      if (finite(a) && finite(b)) {
        checked++;
        if (Math.abs(a - b) > 1e-9) mismatches++;
      }
    }
  }
  if (!checked || mismatches) throw new Error(`baseline reconstruction mismatch: ${mismatches}/${checked}`);

  const rows: any[] = [];
  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    const entryThreshold = ENTRY_THRESHOLDS[market];
    const benchmark = benchmarks[market];
    for (const horizon of HORIZONS) {
      for (const model of MODELS) {
        const folds: any[] = [];
        for (const year of FOLD_YEARS) {
          const baselineOutcomes: Outcome[] = [];
          const modelOutcomes: Outcome[] = [];
          let baselineOnsets = 0;
          let modelOnsets = 0;
          let retainedBaselineOnsets = 0;
          let newOnsets = 0;
          let lostOnsets = 0;
          let featureFireDays = 0;
          let evaluatedDays = 0;

          for (const item of prepared) {
            if (item.source.market !== market) continue;
            for (let i = 253; i + horizon < item.source.bars.length; i++) {
              const date = item.source.bars[i]!.tradeDate;
              if (Number(date.slice(0, 4)) !== year) continue;
              const bPrev = scoreAt(baselineModel, item, i - 1);
              const bCur = scoreAt(baselineModel, item, i);
              const mPrev = scoreAt(model, item, i - 1);
              const mCur = scoreAt(model, item, i);
              if (![bPrev, bCur, mPrev, mCur].every(finite)) continue;
              evaluatedDays++;
              if ((modelVolumePoints(model, item, i) ?? 0) !== 0) featureFireDays++;
              const baselineOnset = crossedUp(bPrev, bCur, entryThreshold);
              const modelOnset = crossedUp(mPrev, mCur, entryThreshold);
              if (!baselineOnset && !modelOnset) continue;
              const result = outcome(item, i, horizon, benchmark);
              if (!result) continue;
              if (baselineOnset) {
                baselineOnsets++;
                baselineOutcomes.push(result);
              }
              if (modelOnset) {
                modelOnsets++;
                modelOutcomes.push(result);
              }
              if (baselineOnset && modelOnset) retainedBaselineOnsets++;
              else if (!baselineOnset && modelOnset) newOnsets++;
              else if (baselineOnset && !modelOnset) lostOnsets++;
            }
          }

          const baseline = metric(baselineOutcomes);
          const modelMetric = metric(modelOutcomes);
          folds.push({
            year,
            evaluatedDays,
            featureFireDays,
            featureFireRate: evaluatedDays ? round(featureFireDays / evaluatedDays * 100) : null,
            baselineOnsets,
            modelOnsets,
            retainedBaselineOnsets,
            newOnsets,
            lostOnsets,
            baseline,
            model: modelMetric,
            delta: {
              avgExcess: delta(modelMetric.avgExcess, baseline.avgExcess),
              medianExcess: delta(modelMetric.medianExcess, baseline.medianExcess),
              profitFactor: delta(modelMetric.profitFactor, baseline.profitFactor),
              avgMae: delta(modelMetric.avgMae, baseline.avgMae),
              avgMfe: delta(modelMetric.avgMfe, baseline.avgMfe),
              count: modelMetric.count - baseline.count,
            },
          });
        }
        rows.push({ modelId: model.id, label: model.label, market, horizon, entryThreshold, folds, threeFos: summarizeThreeFos(folds) });
      }
    }
  }

  // Entry-veto diagnostics keep the current 10-point onset intact and only block selected surge types.
  const vetoSpecs = [
    { id: "VETO_CURRENT", label: "현재 Volume Surge 발생 시 진입 보류", hit: (x: PreparedSeries, i: number) => currentSurge(x, i) === true },
    { id: "VETO_RET2", label: "현재 Volume Surge + 당일 +2% 이상일 때만 진입 보류", hit: (x: PreparedSeries, i: number) => currentSurge(x, i) === true && x.dayReturn[i] >= 0.02 },
    { id: "VETO_VOL200_CLV80", label: "거래량 200% + CLV0.80일 때만 진입 보류", hit: (x: PreparedSeries, i: number) => x.volumeRatio20[i] >= 200 && x.clv[i] >= 0.8 },
  ];
  const vetoRows: any[] = [];
  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    const entryThreshold = ENTRY_THRESHOLDS[market];
    const benchmark = benchmarks[market];
    for (const horizon of HORIZONS) {
      for (const veto of vetoSpecs) {
        const folds: any[] = [];
        for (const year of FOLD_YEARS) {
          const base: Outcome[] = [];
          const kept: Outcome[] = [];
          let blocked = 0;
          for (const item of prepared) {
            if (item.source.market !== market) continue;
            for (let i = 253; i + horizon < item.source.bars.length; i++) {
              if (Number(item.source.bars[i]!.tradeDate.slice(0, 4)) !== year) continue;
              const prev = scoreAt(baselineModel, item, i - 1);
              const cur = scoreAt(baselineModel, item, i);
              if (!crossedUp(prev, cur, entryThreshold)) continue;
              const result = outcome(item, i, horizon, benchmark);
              if (!result) continue;
              base.push(result);
              if (veto.hit(item, i)) blocked++;
              else kept.push(result);
            }
          }
          const baseline = metric(base);
          const modelMetric = metric(kept);
          folds.push({
            year,
            blocked,
            retentionRate: baseline.count ? round(modelMetric.count / baseline.count * 100) : null,
            baseline,
            model: modelMetric,
            retainedBaselineOnsets: modelMetric.count,
            newOnsets: 0,
            lostOnsets: blocked,
            delta: {
              avgExcess: delta(modelMetric.avgExcess, baseline.avgExcess),
              medianExcess: delta(modelMetric.medianExcess, baseline.medianExcess),
              profitFactor: delta(modelMetric.profitFactor, baseline.profitFactor),
              avgMae: delta(modelMetric.avgMae, baseline.avgMae),
              avgMfe: delta(modelMetric.avgMfe, baseline.avgMfe),
              count: modelMetric.count - baseline.count,
            },
          });
        }
        vetoRows.push({ modelId: veto.id, label: veto.label, market, horizon, entryThreshold, folds, threeFos: summarizeThreeFos(folds) });
      }
    }
  }

  const primaryRanking = rows
    .filter((r) => r.market === "KOSDAQ" && r.horizon === 20 && r.modelId !== "BASELINE_CURRENT")
    .sort((a, b) =>
      b.threeFos.positiveAvgExcessDeltaFolds - a.threeFos.positiveAvgExcessDeltaFolds ||
      (b.threeFos.worstAvgExcessDelta ?? -Infinity) - (a.threeFos.worstAvgExcessDelta ?? -Infinity) ||
      (b.threeFos.meanAvgExcessDelta ?? -Infinity) - (a.threeFos.meanAvgExcessDelta ?? -Infinity),
    )
    .map((r) => ({ modelId: r.modelId, label: r.label, ...r.threeFos }));

  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
    study: STUDY,
    engineVersion: ENGINE_VERSION,
    run: { id: runId, createdAt, codeVersion: codeVersion(), datasetVersion: parsed.dataset.version, asOfDate: parsed.dataset.asOfDate, symbolCount: context.symbolCount },
    policy: {
      primaryOos: "3-FOS",
      foldYears: [...FOLD_YEARS],
      foldPolicies: foldPolicy,
      horizons: [...HORIZONS],
      entryThresholds: ENTRY_THRESHOLDS,
      baseline: "current 10-point model: Volume Surge = prior-20D average volume >=150% AND CLV>=0.70, +0.5; sector PL slot unchanged",
      volumeRatio: "today volume / prior 20 trading-day average volume; today excluded from average",
      dayReturn: "close / prior close - 1",
      scoringChange: "research only; production score unchanged",
      comparison: "all score variants use the same 613-stock dataset and full 2018/2022/2025 OOS folds; baseline reconstructed and verified against native score",
    },
    models: MODELS,
    inputQuality: quality,
    baselineReconstruction: { checked, mismatches },
    rows,
    vetoRows,
    primaryRanking,
  };

  const outputDir = path.resolve("v8-volume-surge-refinement-3fos-runs", runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "volume-surge-refinement-3fos.json"), JSON.stringify(payload, null, 2));
  let remotePath: string | null = null;
  if (upload) {
    remotePath = `${userId}/results/v8-volume-surge-refinement-3fos/latest.json`;
    await uploadJson(client, remotePath, payload);
  }
  process.stdout.write(`${JSON.stringify({ outputDir, remotePath, study: STUDY, run: payload.run, baselineReconstruction: payload.baselineReconstruction, primaryRanking, vetoPrimary: vetoRows.filter((r) => r.market === "KOSDAQ" && r.horizon === 20).map((r) => ({ modelId: r.modelId, label: r.label, ...r.threeFos })) }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
