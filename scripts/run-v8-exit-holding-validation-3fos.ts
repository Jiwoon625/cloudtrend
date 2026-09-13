import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { MarketDataset } from "../src/lib/engine/dataset";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  buildV8ExitHoldingValidation,
  V8_EXIT_DOWNSIDE_THRESHOLDS,
  V8_EXIT_MAX_HOLDING_DAYS,
  V8_EXIT_UPSIDE_THRESHOLDS,
  type V8ExitHoldingMetricRow,
} from "../src/lib/engine/v8ExitHoldingValidation";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildV8ScoreAvailabilityReport } from "../src/lib/engine/v8ScoreAvailability";
import { codeVersion, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

const THREE_FOS_YEARS = [2018, 2022, 2025] as const;
const THREE_FOS_NAME = "3-FOS" as const;
const MAX_FORWARD_HORIZON = Math.max(...V8_EXIT_MAX_HOLDING_DAYS);
const MARKET_ENTRY_THRESHOLDS = { KOSPI: [65, 75], KOSDAQ: [75, 80] } as const;
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
    "  npx vite-node scripts/run-v8-exit-holding-validation-3fos.ts --supabase-user-id <uuid> [--upload]",
    "Options:",
    "  --output <dir>  default: v8-exit-holding-validation-3fos-runs",
    "  --limit <count>  default: 613",
    "  --round-trip-cost-bps <bps>  default: 0",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v8-exit-holding-validation-3fos-runs",
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

function worst(values: Array<number | null | undefined>) {
  const xs = values.filter(finite);
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

function aggregateRows(rows: V8ExitHoldingMetricRow[]) {
  const foldRows = rows.filter(
    (row) => row.scope === "YEAR" && row.year !== null && THREE_FOS_YEARS.includes(row.year as ThreeFosYear),
  );
  const scenarioIds = [...new Set(foldRows.map((row) => row.scenarioId))].sort();
  const aggregate: Array<Record<string, unknown>> = [];

  for (const scenarioId of scenarioIds) {
    const xs = foldRows.filter((row) => row.scenarioId === scenarioId);
    if (!xs.length) continue;
    const template = xs[0]!;
    aggregate.push({
      market: template.market,
      scenarioId,
      entryThreshold: template.entryThreshold,
      exitMode: template.exitMode,
      upsideExitThreshold: template.upsideExitThreshold,
      downsideExitThreshold: template.downsideExitThreshold,
      maxHoldingDays: template.maxHoldingDays,
      foldCount: xs.length,
      foldYears: [...THREE_FOS_YEARS],
      totalRawOnsets: xs.reduce((sum, row) => sum + row.rawOnsets, 0),
      totalAcceptedTrades: xs.reduce((sum, row) => sum + row.acceptedTrades, 0),
      equalWeightIndependentSignalRate: avg(xs.map((row) => row.independentSignalRate)),
      equalWeightAvgReturn: avg(xs.map((row) => row.avgReturn)),
      equalWeightMedianReturn: avg(xs.map((row) => row.medianReturn)),
      equalWeightWinRate: avg(xs.map((row) => row.winRate)),
      equalWeightPayoffRatio: avg(xs.map((row) => row.payoffRatio)),
      equalWeightProfitFactor: avg(xs.map((row) => row.profitFactor)),
      equalWeightAvgExcessReturn: avg(xs.map((row) => row.avgExcessReturn)),
      equalWeightMedianExcessReturn: avg(xs.map((row) => row.medianExcessReturn)),
      equalWeightExcessWinRate: avg(xs.map((row) => row.excessWinRate)),
      equalWeightAvgMae: avg(xs.map((row) => row.avgMae)),
      equalWeightAvgMfe: avg(xs.map((row) => row.avgMfe)),
      equalWeightAvgHoldingDays: avg(xs.map((row) => row.avgHoldingDays)),
      equalWeightTimeExitRate: avg(xs.map((row) => row.timeExitRate)),
      equalWeightUpsideExitRate: avg(xs.map((row) => row.upsideExitRate)),
      equalWeightDownsideExitRate: avg(xs.map((row) => row.downsideExitRate)),
      equalWeightDailyAvgExcessHacMean: avg(xs.map((row) => row.dailyAvgExcessHacMean)),
      positiveAvgExcessFolds: xs.filter((row) => (row.avgExcessReturn ?? Number.NEGATIVE_INFINITY) > 0).length,
      positiveMedianExcessFolds: xs.filter((row) => (row.medianExcessReturn ?? Number.NEGATIVE_INFINITY) > 0).length,
      all3PositiveAvgExcess: xs.length === 3 && xs.every((row) => (row.avgExcessReturn ?? Number.NEGATIVE_INFINITY) > 0),
      all3PositiveMedianExcess: xs.length === 3 && xs.every((row) => (row.medianExcessReturn ?? Number.NEGATIVE_INFINITY) > 0),
      worstFoldAvgExcess: worst(xs.map((row) => row.avgExcessReturn)),
      worstFoldMedianExcess: worst(xs.map((row) => row.medianExcessReturn)),
      foldRows: Object.fromEntries(
        THREE_FOS_YEARS.map((year) => [year, xs.find((row) => row.year === year) ?? null]),
      ),
    });
  }
  return { foldRows, aggregate };
}

function robustReferenceRows(aggregate: Array<Record<string, unknown>>) {
  const rows = aggregate.filter((row) => Number(row.totalAcceptedTrades) >= 100);
  const byMarket: Record<string, Array<Record<string, unknown>>> = {};
  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    byMarket[market] = rows
      .filter((row) => row.market === market)
      .sort((a, b) => {
        const aAll3 = a.all3PositiveAvgExcess === true ? 1 : 0;
        const bAll3 = b.all3PositiveAvgExcess === true ? 1 : 0;
        if (aAll3 !== bAll3) return bAll3 - aAll3;
        const aPos = Number(a.positiveAvgExcessFolds ?? 0);
        const bPos = Number(b.positiveAvgExcessFolds ?? 0);
        if (aPos !== bPos) return bPos - aPos;
        const aWorst = Number(a.worstFoldAvgExcess ?? Number.NEGATIVE_INFINITY);
        const bWorst = Number(b.worstFoldAvgExcess ?? Number.NEGATIVE_INFINITY);
        if (aWorst !== bWorst) return bWorst - aWorst;
        const aExcess = Number(a.equalWeightAvgExcessReturn ?? Number.NEGATIVE_INFINITY);
        const bExcess = Number(b.equalWeightAvgExcessReturn ?? Number.NEGATIVE_INFINITY);
        if (aExcess !== bExcess) return bExcess - aExcess;
        return Number(b.equalWeightProfitFactor ?? 0) - Number(a.equalWeightProfitFactor ?? 0);
      })
      .slice(0, 12);
  }
  return byMarket;
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
    throw new Error(`3-FOS purge가 최대 보유기간 ${MAX_FORWARD_HORIZON}D와 일치하지 않습니다.`);
  }

  const scoreAvailability = buildV8ScoreAvailabilityReport(parsed.dataset, options.limit);
  const result = buildV8ExitHoldingValidation(parsed.dataset, {
    limit: options.limit,
    warmupDays: 120,
    roundTripCostBps: options.roundTripCostBps,
    priceLeadershipOverheatThreshold: 80,
    marketEntryThresholds: { KOSPI: [...MARKET_ENTRY_THRESHOLDS.KOSPI], KOSDAQ: [...MARKET_ENTRY_THRESHOLDS.KOSDAQ] },
    upsideExitThresholds: [...V8_EXIT_UPSIDE_THRESHOLDS],
    downsideExitThresholds: [...V8_EXIT_DOWNSIDE_THRESHOLDS],
    maxHoldingDays: [...V8_EXIT_MAX_HOLDING_DAYS],
  });
  if (!result) throw new Error("V8-4 청산 임계값·보유기간 3-FOS 결과를 계산하지 못했습니다.");

  const rows3Fos = aggregateRows(result.rows);
  const references = robustReferenceRows(rows3Fos.aggregate);
  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
    study: "V8-4",
    primaryOos: {
      name: THREE_FOS_NAME,
      method: "three-fold-calendar-year-walk-forward-oos-with-purge",
      foldYears: [...THREE_FOS_YEARS],
      aggregation: "equal-weight-across-folds",
      constraints: {
        trainingRule: "for each fold, only dates strictly before the purge window are eligible for tuning/selection",
        purgeTradingDays: MAX_FORWARD_HORIZON,
        purgeReason: "prevent max 60D holding outcome from crossing into OOS",
        oosRule: "primary performance uses only trades whose onset signal date belongs to the fold calendar year",
        futureDataForTuning: "forbidden",
        candidateGridPolicy: "use the original pre-specified V8-4 candidate grid unchanged",
        v83ThreeFosUsedToChangeGrid: false,
        finalOperatingCombinationSelection: "deferred; robustReferenceRows are diagnostics, not a final OOS-fitted strategy",
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
      marketEntryThresholds: result.marketEntryThresholds,
      upsideExitThresholds: result.upsideExitThresholds,
      downsideExitThresholds: result.downsideExitThresholds,
      maxHoldingDays: result.maxHoldingDays,
      roundTripCostBps: options.roundTripCostBps,
    },
    sourceFiles: inputs.map((input) => ({ id: input.id, fileName: input.fileName, bytes: input.bytes, savedAt: input.savedAt })),
    dataQuality: { inputContract: inputQuality, scoreAvailability },
    result,
    threeFos: {
      rows: rows3Fos,
      robustReferenceRows: references,
    },
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "exit-holding-validation-3fos.json"), JSON.stringify(payload, null, 2));

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/v8-exit-holding-validation-3fos/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  process.stdout.write(`${JSON.stringify({
    outputDir,
    remotePath,
    study: payload.study,
    primaryOos: payload.primaryOos,
    run: payload.run,
    executionPolicy: result.executionPolicy,
    scenarioCount: result.scenarios.length,
    robustReferenceRows: references,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
