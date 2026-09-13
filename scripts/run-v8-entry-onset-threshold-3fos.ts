import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { MarketDataset } from "../src/lib/engine/dataset";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  V8_ENTRY_ONSET_HORIZONS,
  V8_ENTRY_ONSET_THRESHOLDS,
  buildV8EntryOnsetThresholdValidation,
  type V8EntryOnsetMetricRow,
} from "../src/lib/engine/v8EntryOnsetThreshold";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildV8ScoreAvailabilityReport } from "../src/lib/engine/v8ScoreAvailability";
import { codeVersion, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

const THREE_FOS_YEARS = [2018, 2022, 2025] as const;
const THREE_FOS_NAME = "3-FOS" as const;
const MAX_FORWARD_HORIZON = Math.max(...V8_ENTRY_ONSET_HORIZONS);
type ThreeFosYear = (typeof THREE_FOS_YEARS)[number];

interface Options {
  supabaseUserId: string | null;
  outputRoot: string;
  upload: boolean;
  limit: number;
  roundTripCostBps: number;
}

interface FoldPolicy {
  fold: `FOS-${ThreeFosYear}`;
  year: ThreeFosYear;
  trainFrom: string;
  trainEnd: string;
  purgeFrom: string;
  purgeTo: string;
  purgeTradingDays: number;
  oosFrom: string;
  oosTo: string;
  oosTradingDays: number;
  maxForwardHorizon: number;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npx vite-node scripts/run-v8-entry-onset-threshold-3fos.ts --supabase-user-id <uuid> [--upload]",
    "Options:",
    "  --output <dir>  default: v8-entry-onset-threshold-3fos-runs",
    "  --limit <count>  default: 613",
    "  --round-trip-cost-bps <bps>  default: 0",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v8-entry-onset-threshold-3fos-runs",
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
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 2000) {
    throw new Error("limit은 1~2000 정수여야 합니다.");
  }
  if (!Number.isFinite(options.roundTripCostBps) || options.roundTripCostBps < 0 || options.roundTripCostBps > 1000) {
    throw new Error("round-trip-cost-bps는 0~1000이어야 합니다.");
  }
  return options;
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

function avg(values: Array<number | null | undefined>) {
  const xs = values.filter(finite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function median(values: Array<number | null | undefined>) {
  const xs = values.filter(finite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = (xs.length - 1) / 2;
  return (xs[Math.floor(mid)]! + xs[Math.ceil(mid)]!) / 2;
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

function buildFoldPolicies(dataset: MarketDataset): FoldPolicy[] {
  const dates = sharedTradingDates(dataset);
  if (!dates.length) throw new Error("KOSPI/KOSDAQ 공통 거래일을 찾지 못했습니다.");
  return THREE_FOS_YEARS.map((year) => {
    const oosDates = dates.filter((date) => Number(date.slice(0, 4)) === year);
    if (!oosDates.length) throw new Error(`${year}년 OOS 거래일이 없습니다.`);
    const oosFrom = oosDates[0]!;
    const oosTo = oosDates.at(-1)!;
    const oosStartIndex = dates.indexOf(oosFrom);
    const trainEndIndex = oosStartIndex - MAX_FORWARD_HORIZON - 1;
    if (trainEndIndex < 0) throw new Error(`${year}년 Fold 이전 학습·purge 구간이 부족합니다.`);
    const purgeFromIndex = trainEndIndex + 1;
    const purgeToIndex = oosStartIndex - 1;
    return {
      fold: `FOS-${year}` as const,
      year,
      trainFrom: dates[0]!,
      trainEnd: dates[trainEndIndex]!,
      purgeFrom: dates[purgeFromIndex]!,
      purgeTo: dates[purgeToIndex]!,
      purgeTradingDays: purgeToIndex - purgeFromIndex + 1,
      oosFrom,
      oosTo,
      oosTradingDays: oosDates.length,
      maxForwardHorizon: MAX_FORWARD_HORIZON,
    };
  });
}

function aggregateRows(rows: V8EntryOnsetMetricRow[]) {
  const foldRows = rows.filter(
    (row) => row.scope === "YEAR" && row.year !== null && THREE_FOS_YEARS.includes(row.year as ThreeFosYear),
  );
  const aggregate: Array<Record<string, unknown>> = [];
  for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
    for (const threshold of V8_ENTRY_ONSET_THRESHOLDS) {
      for (const horizon of V8_ENTRY_ONSET_HORIZONS) {
        const xs = foldRows.filter(
          (row) => row.market === market && row.threshold === threshold && row.horizon === horizon,
        );
        if (!xs.length) continue;
        aggregate.push({
          market,
          threshold,
          horizon,
          foldCount: xs.length,
          foldYears: [...THREE_FOS_YEARS],
          totalSignals: xs.reduce((sum, row) => sum + row.count, 0),
          equalWeightAvgReturn: avg(xs.map((row) => row.avgReturn)),
          equalWeightMedianReturn: avg(xs.map((row) => row.medianReturn)),
          equalWeightWinRate: avg(xs.map((row) => row.winRate)),
          equalWeightProfitFactor: avg(xs.map((row) => row.profitFactor)),
          equalWeightAvgExcessReturn: avg(xs.map((row) => row.avgExcessReturn)),
          equalWeightMedianExcessReturn: avg(xs.map((row) => row.medianExcessReturn)),
          equalWeightExcessWinRate: avg(xs.map((row) => row.excessWinRate)),
          equalWeightAvgMae: avg(xs.map((row) => row.avgMae)),
          equalWeightAvgMfe: avg(xs.map((row) => row.avgMfe)),
          equalWeightDailyAvgExcessHacMean: avg(xs.map((row) => row.dailyAvgExcessHacMean)),
          positiveAvgExcessFolds: xs.filter((row) => (row.avgExcessReturn ?? Number.NEGATIVE_INFINITY) > 0).length,
          positiveMedianExcessFolds: xs.filter((row) => (row.medianExcessReturn ?? Number.NEGATIVE_INFINITY) > 0).length,
          all3PositiveAvgExcess: xs.length === 3 && xs.every((row) => (row.avgExcessReturn ?? Number.NEGATIVE_INFINITY) > 0),
          all3PositiveMedianExcess: xs.length === 3 && xs.every((row) => (row.medianExcessReturn ?? Number.NEGATIVE_INFINITY) > 0),
          worstFoldAvgExcess: Math.min(...xs.map((row) => row.avgExcessReturn).filter(finite)),
          foldRows: Object.fromEntries(
            THREE_FOS_YEARS.map((year) => [year, xs.find((row) => row.year === year) ?? null]),
          ),
        });
      }
    }
  }
  return { foldRows, aggregate };
}

function buildRobustness(aggregate: Array<Record<string, unknown>>) {
  const out: Array<Record<string, unknown>> = [];
  for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
    for (const threshold of V8_ENTRY_ONSET_THRESHOLDS) {
      const xs = aggregate.filter((row) => row.market === market && row.threshold === threshold);
      out.push({
        market,
        threshold,
        horizonsTested: xs.length,
        positiveAvgExcessHorizons: xs.filter((row) => Number(row.equalWeightAvgExcessReturn) > 0).length,
        positiveMedianExcessHorizons: xs.filter((row) => Number(row.equalWeightMedianExcessReturn) > 0).length,
        all3PositiveAvgExcessHorizons: xs.filter((row) => row.all3PositiveAvgExcess === true).length,
        medianEqualWeightAvgExcess: median(xs.map((row) => row.equalWeightAvgExcessReturn as number | null)),
        medianEqualWeightMedianExcess: median(xs.map((row) => row.equalWeightMedianExcessReturn as number | null)),
        medianProfitFactor: median(xs.map((row) => row.equalWeightProfitFactor as number | null)),
        medianExcessWinRate: median(xs.map((row) => row.equalWeightExcessWinRate as number | null)),
      });
    }
  }
  return out;
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
  if (foldPolicies.some((fold) => fold.purgeTradingDays !== MAX_FORWARD_HORIZON)) {
    throw new Error(`3-FOS purge가 최대 horizon ${MAX_FORWARD_HORIZON}D와 일치하지 않습니다.`);
  }

  const scoreAvailability = buildV8ScoreAvailabilityReport(parsed.dataset, options.limit);
  const result = buildV8EntryOnsetThresholdValidation(parsed.dataset, {
    limit: options.limit,
    thresholds: [...V8_ENTRY_ONSET_THRESHOLDS],
    horizons: [...V8_ENTRY_ONSET_HORIZONS],
    warmupDays: 120,
    roundTripCostBps: options.roundTripCostBps,
    priceLeadershipOverheatThreshold: 80,
  });
  if (!result) throw new Error("V8-3 진입 Onset 임계값 결과를 계산하지 못했습니다.");

  const rows3Fos = aggregateRows(result.rows);
  const robustness3Fos = buildRobustness(rows3Fos.aggregate);
  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
    study: "V8-3",
    primaryOos: {
      name: THREE_FOS_NAME,
      method: "three-fold-calendar-year-walk-forward-oos-with-purge",
      foldYears: [...THREE_FOS_YEARS],
      aggregation: "equal-weight-across-folds",
      constraints: {
        trainingRule: "for each fold, only dates strictly before the purge window are eligible for tuning/selection",
        purgeTradingDays: MAX_FORWARD_HORIZON,
        purgeReason: "prevent max 60D forward-return labels from crossing into OOS",
        oosRule: "primary performance uses only signals whose signal date belongs to the fold calendar year",
        futureDataForTuning: "forbidden",
        candidateThresholds: [...V8_ENTRY_ONSET_THRESHOLDS],
        candidateSetPolicy: "pre-specified candidate set; 3-FOS is validation, not an OOS refit",
        finalThresholdSelection: "deferred; do not choose a final operating threshold from 3-FOS alone",
        warmupHistory: "preserved before each OOS so rolling indicators remain continuous",
      },
      folds: foldPolicies,
    },
    run: {
      id: runId,
      createdAt,
      engineVersion: result.version,
      codeVersion: codeVersion(),
      datasetVersion: parsed.dataset.version,
      asOfDate: parsed.dataset.asOfDate,
      limit: options.limit,
      thresholds: result.thresholds,
      horizons: result.horizons,
      roundTripCostBps: options.roundTripCostBps,
    },
    sourceFiles: inputs.map((input) => ({
      id: input.id,
      fileName: input.fileName,
      bytes: input.bytes,
      savedAt: input.savedAt,
    })),
    dataQuality: { inputContract: inputQuality, scoreAvailability },
    result,
    threeFos: {
      rows: rows3Fos,
      robustness: robustness3Fos,
    },
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "entry-onset-threshold-3fos.json"), JSON.stringify(payload, null, 2));

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/v8-entry-onset-threshold-3fos/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  const keyRows = rows3Fos.aggregate.filter(
    (row) => [20, 30, 40].includes(Number(row.horizon)),
  );
  process.stdout.write(`${JSON.stringify({
    outputDir,
    remotePath,
    study: payload.study,
    primaryOos: payload.primaryOos,
    run: payload.run,
    keyRobustness: robustness3Fos,
    keyRows,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
