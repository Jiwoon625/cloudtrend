import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildV8ScoreAvailabilityReport } from "../src/lib/engine/v8ScoreAvailability";
import {
  V8_SCORE_MONOTONICITY_HORIZONS,
  buildV8ScoreMonotonicity,
  type V8ScoreBucketMetricRow,
  type V8ScoreMonotonicitySummaryRow,
} from "../src/lib/engine/v8ScoreMonotonicity";
import type { MarketDataset } from "../src/lib/engine/dataset";
import { codeVersion, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

const THREE_FOS_YEARS = [2018, 2022, 2025] as const;
const THREE_FOS_NAME = "3-FOS" as const;
const MAX_FORWARD_HORIZON = Math.max(...V8_SCORE_MONOTONICITY_HORIZONS);

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
  throw new Error(
    [
      "Usage:",
      "  npx vite-node scripts/run-v8-score-monotonicity-3fos.ts --supabase-user-id <uuid> [--upload]",
      "Options:",
      "  --output <dir>  default: v8-score-monotonicity-3fos-runs",
      "  --limit <count>  default: 613",
      "  --round-trip-cost-bps <bps>  default: 0",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v8-score-monotonicity-3fos-runs",
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

function finiteValues(values: Array<number | null | undefined>) {
  return values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
}

function avg(values: Array<number | null | undefined>) {
  const xs = finiteValues(values);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function median(values: Array<number | null | undefined>) {
  const xs = finiteValues(values).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = (xs.length - 1) / 2;
  return (xs[Math.floor(mid)]! + xs[Math.ceil(mid)]!) / 2;
}

function worst(values: Array<number | null | undefined>) {
  const xs = finiteValues(values);
  return xs.length ? Math.min(...xs) : null;
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

function aggregateMonotonicity(rows: V8ScoreMonotonicitySummaryRow[]) {
  const foldRows = rows.filter(
    (row) => row.scope === "YEAR" && row.year !== null && THREE_FOS_YEARS.includes(row.year as ThreeFosYear),
  );
  const aggregate: Array<Record<string, unknown>> = [];
  for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
    for (const horizon of V8_SCORE_MONOTONICITY_HORIZONS) {
      const xs = foldRows.filter((row) => row.market === market && row.horizon === horizon);
      aggregate.push({
        market,
        horizon,
        foldCount: xs.length,
        foldYears: [...THREE_FOS_YEARS],
        equalWeightSpearmanAvgReturn: avg(xs.map((row) => row.spearmanAvgReturn)),
        equalWeightSpearmanMedianReturn: avg(xs.map((row) => row.spearmanMedianReturn)),
        equalWeightSpearmanAvgExcess: avg(xs.map((row) => row.spearmanAvgExcess)),
        equalWeightSpearmanMedianExcess: avg(xs.map((row) => row.spearmanMedianExcess)),
        medianSpearmanAvgExcess: median(xs.map((row) => row.spearmanAvgExcess)),
        worstSpearmanAvgExcess: worst(xs.map((row) => row.spearmanAvgExcess)),
        positiveSpearmanAvgExcessFolds: xs.filter((row) => (row.spearmanAvgExcess ?? -Infinity) > 0).length,
        positiveSpearmanMedianExcessFolds: xs.filter((row) => (row.spearmanMedianExcess ?? -Infinity) > 0).length,
        all3PositiveAvgExcess: xs.length === 3 && xs.every((row) => (row.spearmanAvgExcess ?? -Infinity) > 0),
        all3PositiveMedianExcess: xs.length === 3 && xs.every((row) => (row.spearmanMedianExcess ?? -Infinity) > 0),
        equalWeightAdjacentAvgExcessUpRate: avg(xs.map((row) => row.adjacentAvgExcessUpRate)),
        equalWeightAdjacentMedianExcessUpRate: avg(xs.map((row) => row.adjacentMedianExcessUpRate)),
        equalWeightEndpointAvgExcessSpread: avg(xs.map((row) => row.endpointAvgExcessSpread)),
        equalWeightEndpointMedianExcessSpread: avg(xs.map((row) => row.endpointMedianExcessSpread)),
        equalWeightDailyExcessSlopeMean: avg(xs.map((row) => row.dailyExcessSlopeMean)),
        positiveDailyExcessSlopeFolds: xs.filter((row) => (row.dailyExcessSlopeMean ?? -Infinity) > 0).length,
        all3PositiveDailyExcessSlope: xs.length === 3 && xs.every((row) => (row.dailyExcessSlopeMean ?? -Infinity) > 0),
        foldRows: Object.fromEntries(THREE_FOS_YEARS.map((year) => [year, xs.find((row) => row.year === year) ?? null])),
      });
    }
  }
  return { foldRows, aggregate };
}

function aggregateBuckets(rows: V8ScoreBucketMetricRow[]) {
  const foldRows = rows.filter(
    (row) => row.scope === "YEAR" && row.year !== null && THREE_FOS_YEARS.includes(row.year as ThreeFosYear),
  );
  const scoreValues = [...new Set(foldRows.map((row) => row.score10))].sort((a, b) => a - b);
  const aggregate: Array<Record<string, unknown>> = [];
  for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
    for (const horizon of V8_SCORE_MONOTONICITY_HORIZONS) {
      for (const score10 of scoreValues) {
        const xs = foldRows.filter(
          (row) => row.market === market && row.horizon === horizon && row.score10 === score10,
        );
        if (!xs.length) continue;
        aggregate.push({
          market,
          horizon,
          score10,
          foldCount: xs.length,
          totalSignals: xs.reduce((sum, row) => sum + row.count, 0),
          equalWeightAvgReturn: avg(xs.map((row) => row.avgReturn)),
          equalWeightMedianReturn: avg(xs.map((row) => row.medianReturn)),
          equalWeightAvgExcessReturn: avg(xs.map((row) => row.avgExcessReturn)),
          equalWeightMedianExcessReturn: avg(xs.map((row) => row.medianExcessReturn)),
          equalWeightWinRate: avg(xs.map((row) => row.winRate)),
          equalWeightExcessWinRate: avg(xs.map((row) => row.excessWinRate)),
          positiveAvgExcessFolds: xs.filter((row) => (row.avgExcessReturn ?? -Infinity) > 0).length,
          positiveMedianExcessFolds: xs.filter((row) => (row.medianExcessReturn ?? -Infinity) > 0).length,
          foldRows: Object.fromEntries(THREE_FOS_YEARS.map((year) => [year, xs.find((row) => row.year === year) ?? null])),
        });
      }
    }
  }
  return { foldRows, aggregate };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = trustedSupabaseClient();
  const inputs = await loadAnalysisSourceInputs(client, options.supabaseUserId!, "backtest", { lightweight: true });
  const parsed = parseManualMarketData(inputs.map((input) => input.text));
  const inputQuality = buildV8InputQualityReport(inputs);
  if (!inputQuality.validForV8) {
    throw new Error(
      `V8 필수 입력열이 없거나 전부 비어 있는 파일이 있습니다: ${JSON.stringify(inputQuality.filesInvalidRequiredColumns)}`,
    );
  }

  const foldPolicies = buildFoldPolicies(parsed.dataset);
  if (foldPolicies.some((fold) => fold.purgeTradingDays !== MAX_FORWARD_HORIZON)) {
    throw new Error(`3-FOS purge가 최대 horizon ${MAX_FORWARD_HORIZON}D와 일치하지 않습니다.`);
  }

  const scoreAvailability = buildV8ScoreAvailabilityReport(parsed.dataset, options.limit);
  const result = buildV8ScoreMonotonicity(parsed.dataset, {
    limit: options.limit,
    horizons: [...V8_SCORE_MONOTONICITY_HORIZONS],
    warmupDays: 120,
    roundTripCostBps: options.roundTripCostBps,
    priceLeadershipOverheatThreshold: 80,
    minBucketN: 100,
    minBucketDates: 20,
    minDailyCrossSectionN: 30,
  });
  if (!result) throw new Error("V8-2 10점 총점 단조성 결과를 계산하지 못했습니다.");

  const monotonicity3Fos = aggregateMonotonicity(result.monotonicity);
  const buckets3Fos = aggregateBuckets(result.rows);
  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
    study: "V8-2",
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
        scoreDefinition: "fixed pre-existing V8 10-point score; no OOS refit in V8-2",
        warmupHistory: "preserved before each OOS so rolling indicators such as 52-week high remain continuous",
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
      horizons: result.horizons,
      roundTripCostBps: options.roundTripCostBps,
    },
    sourceFiles: inputs.map((input) => ({
      id: input.id,
      fileName: input.fileName,
      bytes: input.bytes,
      savedAt: input.savedAt,
    })),
    dataQuality: {
      inputContract: inputQuality,
      scoreAvailability,
    },
    threeFos: {
      monotonicity: monotonicity3Fos,
      buckets: buckets3Fos,
    },
    scorePolicy: result.scorePolicy,
    eligibility: result.eligibility,
    nonPrimaryDiagnostics: {
      note: "Full-sample/legacy chronological splits are retained only as diagnostics and are not used as the primary OOS decision basis.",
      legacySplitPolicy: result.splitPolicy,
    },
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "v8-2-3fos-score-monotonicity.json"), JSON.stringify(payload, null, 2));

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/v8-score-monotonicity-3fos/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  const keyMonotonicity = monotonicity3Fos.aggregate.filter(
    (row) => [20, 40, 60].includes(Number(row.horizon)),
  );
  const keyBuckets = buckets3Fos.aggregate.filter(
    (row) => row.market === "ALL" && [20, 40].includes(Number(row.horizon)) && Number(row.score10) >= 6,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        outputDir,
        remotePath,
        study: payload.study,
        primaryOos: payload.primaryOos,
        run: payload.run,
        keyMonotonicity,
        keyBuckets,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
