import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildV8ScoreAvailabilityReport } from "../src/lib/engine/v8ScoreAvailability";
import {
  analyzeV8SupplyFeatures,
  V8_SUPPLY_FOS_YEARS,
  type SupplyEffectSummary,
} from "../src/lib/engine/v8SupplyFeatureValidation";
import type { MarketDataset } from "../src/lib/engine/dataset";
import { codeVersion, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

const PURGE_TRADING_DAYS = 60;

interface Options {
  supabaseUserId: string | null;
  outputRoot: string;
  upload: boolean;
  limit: number;
  roundTripCostBps: number;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npx vite-node scripts/run-v8-supply-feature-validation-3fos.ts --supabase-user-id <uuid> [--upload]",
    "Options:",
    "  --output <dir>  default: v8-supply-feature-3fos-runs",
    "  --limit <count>  default: 613",
    "  --round-trip-cost-bps <bps>  default: 0",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v8-supply-feature-3fos-runs",
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

function sharedTradingDates(dataset: MarketDataset) {
  const kospi = new Set(
    dataset.indexSeries.find((series) => series.indexCode.toUpperCase() === "KOSPI")?.bars.map((bar) => bar.tradeDate) ?? [],
  );
  const kosdaq = new Set(
    dataset.indexSeries.find((series) => series.indexCode.toUpperCase() === "KOSDAQ")?.bars.map((bar) => bar.tradeDate) ?? [],
  );
  return [...kospi].filter((date) => kosdaq.has(date)).sort();
}

function buildFoldPolicies(dataset: MarketDataset) {
  const dates = sharedTradingDates(dataset);
  if (!dates.length) throw new Error("KOSPI/KOSDAQ 공통 거래일을 찾지 못했습니다.");
  return V8_SUPPLY_FOS_YEARS.map((year) => {
    const oosDates = dates.filter((date) => Number(date.slice(0, 4)) === year);
    if (!oosDates.length) throw new Error(`${year}년 OOS 거래일이 없습니다.`);
    const oosFrom = oosDates[0]!;
    const oosTo = oosDates.at(-1)!;
    const oosStartIndex = dates.indexOf(oosFrom);
    const trainEndIndex = oosStartIndex - PURGE_TRADING_DAYS - 1;
    if (trainEndIndex < 0) throw new Error(`${year}년 Fold 이전 학습·purge 구간이 부족합니다.`);
    const purgeFromIndex = trainEndIndex + 1;
    const purgeToIndex = oosStartIndex - 1;
    return {
      fold: `FOS-${year}`,
      year,
      trainFrom: dates[0]!,
      trainEnd: dates[trainEndIndex]!,
      purgeFrom: dates[purgeFromIndex]!,
      purgeTo: dates[purgeToIndex]!,
      purgeTradingDays: purgeToIndex - purgeFromIndex + 1,
      oosFrom,
      oosTo,
      oosTradingDays: oosDates.length,
    };
  });
}

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function candidatePriority(row: SupplyEffectSummary) {
  const folds = row.threeFos.usableFoldCount;
  const consistency = row.threeFos.foldSignConsistency ?? -1;
  const magnitude = Math.abs(row.threeFos.equalWeightMeanExcessBeta ?? 0);
  const worst = row.threeFos.worstOrientedFoldExcessBeta ?? -Infinity;
  return [folds, consistency, worst, magnitude] as const;
}

function comparePriority(a: SupplyEffectSummary, b: SupplyEffectSummary) {
  const aa = candidatePriority(a);
  const bb = candidatePriority(b);
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return (bb[i] as number) - (aa[i] as number);
  }
  return 0;
}

function classify(row: SupplyEffectSummary) {
  const fos = row.threeFos;
  const magnitude = Math.abs(fos.equalWeightMeanExcessBeta ?? 0);
  if (!fos.usableFoldCount || !finite(fos.equalWeightMeanExcessBeta)) return "NO_3FOS_COVERAGE";
  if (fos.usableFoldCount >= 2 && fos.foldSignConsistency === 1 && (fos.worstOrientedFoldExcessBeta ?? -Infinity) > 0) {
    return magnitude >= 0.15 ? "STRONG_CANDIDATE" : "CONSISTENT_SMALL_EDGE";
  }
  if (fos.usableFoldCount === 1) return "LIMITED_COVERAGE";
  if ((fos.foldSignConsistency ?? 0) >= 2 / 3) return "PROMISING_BUT_UNSTABLE";
  return "REJECT_OR_WATCH";
}

function summarizeForConsole(rows: SupplyEffectSummary[]) {
  return rows
    .filter((row) => row.market !== "ALL" || row.horizon === 20)
    .sort(comparePriority)
    .slice(0, 30)
    .map((row) => ({
      target: row.target,
      lookback: row.lookback,
      horizon: row.horizon,
      market: row.market,
      usableFolds: row.threeFos.usableFoldYears,
      orientation: row.threeFos.preferredOrientation,
      meanExcessBeta: row.threeFos.equalWeightMeanExcessBeta,
      signConsistency: row.threeFos.foldSignConsistency,
      worstOrientedFold: row.threeFos.worstOrientedFoldExcessBeta,
      classification: classify(row),
      sameSampleComparators: row.threeFos.comparatorEqualWeightMeanExcessBeta,
    }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = trustedSupabaseClient();
  const inputs = await loadAnalysisSourceInputs(client, options.supabaseUserId!, "backtest", { lightweight: true });
  const parsed = parseManualMarketData(inputs.map((input) => input.text));
  const inputQuality = buildV8InputQualityReport(inputs);
  if (!inputQuality.validForV8) {
    throw new Error(`V8 필수 입력열이 없거나 전부 비어 있는 파일이 있습니다: ${JSON.stringify(inputQuality.filesInvalidRequiredColumns)}`);
  }

  const foldPolicies = buildFoldPolicies(parsed.dataset);
  if (foldPolicies.some((fold) => fold.purgeTradingDays !== PURGE_TRADING_DAYS)) {
    throw new Error(`3-FOS purge가 ${PURGE_TRADING_DAYS}D와 일치하지 않습니다.`);
  }

  const scoreAvailability = buildV8ScoreAvailabilityReport(parsed.dataset, options.limit);
  const result = analyzeV8SupplyFeatures(parsed.dataset, inputs.map((input) => input.text), {
    limit: options.limit,
    warmupDays: 120,
    minCrossSection: 30,
    minFoldDays: 20,
    roundTripCostBps: options.roundTripCostBps,
  });

  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const classifications = result.supplyEffects.map((row) => ({
    target: row.target,
    lookback: row.lookback,
    horizon: row.horizon,
    market: row.market,
    classification: classify(row),
    preferredOrientation: row.threeFos.preferredOrientation,
    usableFoldYears: row.threeFos.usableFoldYears,
    equalWeightMeanExcessBeta: row.threeFos.equalWeightMeanExcessBeta,
    foldSignConsistency: row.threeFos.foldSignConsistency,
    worstOrientedFoldExcessBeta: row.threeFos.worstOrientedFoldExcessBeta,
  }));

  const payload = {
    schemaVersion: 1,
    study: "V8-9",
    primaryOos: {
      name: "3-FOS",
      method: "three-fold-calendar-year-walk-forward-oos-with-60-trading-day-purge",
      foldYears: [...V8_SUPPLY_FOS_YEARS],
      aggregation: "equal-weight-across-usable-folds",
      folds: foldPolicies,
      availabilityRule: "each feature uses only dates/stocks where its own required inputs and lookback are observed; missing is never zero",
      comparisonRule: "BB breakout, Ichimoku-above-cloud and high-close-volume are estimated on the exact same candidate sample",
      incrementalAlphaRule: "daily cross-sectional standardized regression controls all existing Vf states; HAC aggregates daily candidate betas",
      interactionRule: "short-down × lending-down × foreign-buy includes short, lending and foreign-buy main effects plus existing Vf controls",
      scoringRule: "research only; no 10-point score weights changed",
    },
    run: {
      id: runId,
      createdAt,
      engineVersion: result.version,
      codeVersion: codeVersion(),
      datasetVersion: parsed.dataset.version,
      asOfDate: parsed.dataset.asOfDate,
      limit: options.limit,
      roundTripCostBps: options.roundTripCostBps,
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
    dataQuality: {
      inputContract: inputQuality,
      scoreAvailability,
      rawFieldAvailability: result.rawFieldAvailability,
      transformedAvailability: result.availability,
    },
    result,
    decisionSupport: {
      classifications,
      ranking: summarizeForConsole(result.supplyEffects),
      interactions: summarizeForConsole(result.interactions),
      technicalBaselines: summarizeForConsole(result.technicalBaselines),
    },
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "supply-feature-validation-3fos.json"), JSON.stringify(payload, null, 2));

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/v8-supply-feature-validation-3fos/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  process.stdout.write(`${JSON.stringify({
    outputDir,
    remotePath,
    study: payload.study,
    primaryOos: payload.primaryOos,
    run: payload.run,
    rawFieldAvailability: result.rawFieldAvailability,
    transformedAvailability: result.availability,
    ranking: payload.decisionSupport.ranking,
    interactions: payload.decisionSupport.interactions,
    technicalBaselines: payload.decisionSupport.technicalBaselines,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
