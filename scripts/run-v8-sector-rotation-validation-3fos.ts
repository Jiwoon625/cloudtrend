import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { MarketDataset } from "../src/lib/engine/dataset";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  buildV8SectorRotationValidation,
  V8_SECTOR_ROTATION_MAX_HOLDING,
  type V8SectorFactor,
  type V8SectorRotationMetricRow,
  type V8SectorRotationMarket,
  type V8SectorSelection,
} from "../src/lib/engine/v8SectorRotationValidation";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildV8ScoreAvailabilityReport } from "../src/lib/engine/v8ScoreAvailability";
import { codeVersion, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

const THREE_FOS_YEARS = [2018, 2022, 2025] as const;
const THREE_FOS_NAME = "3-FOS" as const;
const MAX_FORWARD_HORIZON = V8_SECTOR_ROTATION_MAX_HOLDING;
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
    "  npx vite-node scripts/run-v8-sector-rotation-validation-3fos.ts --supabase-user-id <uuid> [--upload]",
    "Options:",
    "  --output <dir>  default: v8-sector-rotation-3fos-runs",
    "  --limit <count>  default: 613",
    "  --round-trip-cost-bps <bps>  default: 0",
  ].join("\n"));
}
function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v8-sector-rotation-3fos-runs",
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
function average(values: Array<number | null | undefined>) {
  const xs = values.filter(finite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
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

interface AggregateMeta {
  market: V8SectorRotationMarket;
  entryThreshold: number;
  factor: "CONTROL" | V8SectorFactor;
  selection: V8SectorSelection;
}
function aggregateRows(rows: V8SectorRotationMetricRow[]) {
  const keys = new Map<string, AggregateMeta>();
  for (const row of rows) {
    if (!THREE_FOS_YEARS.includes(row.year as ThreeFosYear)) continue;
    const key = `${row.market}|${row.entryThreshold}|${row.factor}|${row.selection}`;
    keys.set(key, {
      market: row.market,
      entryThreshold: row.entryThreshold,
      factor: row.factor,
      selection: row.selection,
    });
  }
  const aggregate = [...keys.values()].map((meta) => {
    const xs = rows.filter((row) =>
      THREE_FOS_YEARS.includes(row.year as ThreeFosYear) &&
      row.market === meta.market &&
      row.entryThreshold === meta.entryThreshold &&
      row.factor === meta.factor &&
      row.selection === meta.selection,
    );
    const excess = xs.map((row) => row.avgExcessReturn).filter(finite);
    return {
      ...meta,
      foldCount: xs.filter((row) => row.acceptedTrades > 0).length,
      foldYears: xs.map((row) => row.year),
      totalBaseTrades: xs.reduce((sum, row) => sum + row.baseTrades, 0),
      totalTrades: xs.reduce((sum, row) => sum + row.acceptedTrades, 0),
      equalWeightRetainedRate: average(xs.map((row) => row.retainedRate)),
      equalWeightAvgReturn: average(xs.map((row) => row.avgReturn)),
      equalWeightMedianReturn: average(xs.map((row) => row.medianReturn)),
      equalWeightWinRate: average(xs.map((row) => row.winRate)),
      equalWeightProfitFactor: average(xs.map((row) => row.profitFactor)),
      equalWeightAvgExcessReturn: average(xs.map((row) => row.avgExcessReturn)),
      equalWeightMedianExcessReturn: average(xs.map((row) => row.medianExcessReturn)),
      equalWeightExcessWinRate: average(xs.map((row) => row.excessWinRate)),
      equalWeightAvgMae: average(xs.map((row) => row.avgMae)),
      equalWeightAvgMfe: average(xs.map((row) => row.avgMfe)),
      equalWeightAvgHoldingDays: average(xs.map((row) => row.avgHoldingDays)),
      positiveAvgExcessFolds: xs.filter((row) => (row.avgExcessReturn ?? Number.NEGATIVE_INFINITY) > 0).length,
      positiveMedianExcessFolds: xs.filter((row) => (row.medianExcessReturn ?? Number.NEGATIVE_INFINITY) > 0).length,
      all3PositiveAvgExcess: xs.length === 3 && xs.every((row) => (row.avgExcessReturn ?? Number.NEGATIVE_INFINITY) > 0),
      all3PositiveMedianExcess: xs.length === 3 && xs.every((row) => (row.medianExcessReturn ?? Number.NEGATIVE_INFINITY) > 0),
      worstFoldAvgExcess: excess.length ? Math.min(...excess) : null,
      foldRows: Object.fromEntries(THREE_FOS_YEARS.map((year) => [year, xs.find((row) => row.year === year) ?? null])),
    };
  });

  const lookup = new Map(aggregate.map((row) => [
    `${row.market}|${row.entryThreshold}|${row.factor}|${row.selection}`,
    row,
  ]));
  const matchedSelections: V8SectorSelection[] = ["TOP50", "TOP25", "RAW_GE60", "RAW_GE70"];
  const matchedComparisons = (["KOSPI", "KOSDAQ"] as const).flatMap((market) =>
    [75, 80].flatMap((entryThreshold) =>
      matchedSelections.map((selection) => {
        const pl = lookup.get(`${market}|${entryThreshold}|PRICE_LEADERSHIP|${selection}`);
        const rotation = lookup.get(`${market}|${entryThreshold}|ROTATION_SCORE|${selection}`);
        if (!pl || !rotation) return null;
        return {
          market,
          entryThreshold,
          selection,
          pl,
          rotation,
          rotationMinusPlAvgExcess:
            finite(rotation.equalWeightAvgExcessReturn) && finite(pl.equalWeightAvgExcessReturn)
              ? rotation.equalWeightAvgExcessReturn - pl.equalWeightAvgExcessReturn
              : null,
          rotationMinusPlMedianExcess:
            finite(rotation.equalWeightMedianExcessReturn) && finite(pl.equalWeightMedianExcessReturn)
              ? rotation.equalWeightMedianExcessReturn - pl.equalWeightMedianExcessReturn
              : null,
          rotationMinusPlWorstFold:
            finite(rotation.worstFoldAvgExcess) && finite(pl.worstFoldAvgExcess)
              ? rotation.worstFoldAvgExcess - pl.worstFoldAvgExcess
              : null,
          rotationMinusPlProfitFactor:
            finite(rotation.equalWeightProfitFactor) && finite(pl.equalWeightProfitFactor)
              ? rotation.equalWeightProfitFactor - pl.equalWeightProfitFactor
              : null,
        };
      }).filter((x): x is NonNullable<typeof x> => x !== null),
    ),
  );

  const quartileSpreads = (["KOSPI", "KOSDAQ"] as const).flatMap((market) =>
    [75, 80].flatMap((entryThreshold) =>
      (["PRICE_LEADERSHIP", "ROTATION_SCORE", "MONEY_FLOW", "ROTATION_MOMENTUM"] as V8SectorFactor[]).map((factor) => {
        const q1 = lookup.get(`${market}|${entryThreshold}|${factor}|Q1`);
        const q4 = lookup.get(`${market}|${entryThreshold}|${factor}|Q4`);
        if (!q1 || !q4) return null;
        return {
          market,
          entryThreshold,
          factor,
          q1,
          q4,
          q4MinusQ1AvgExcess:
            finite(q4.equalWeightAvgExcessReturn) && finite(q1.equalWeightAvgExcessReturn)
              ? q4.equalWeightAvgExcessReturn - q1.equalWeightAvgExcessReturn
              : null,
          q4MinusQ1MedianExcess:
            finite(q4.equalWeightMedianExcessReturn) && finite(q1.equalWeightMedianExcessReturn)
              ? q4.equalWeightMedianExcessReturn - q1.equalWeightMedianExcessReturn
              : null,
        };
      }).filter((x): x is NonNullable<typeof x> => x !== null),
    ),
  );

  return { aggregate, matchedComparisons, quartileSpreads };
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
  const result = buildV8SectorRotationValidation(parsed.dataset, {
    limit: options.limit,
    warmupDays: 120,
    roundTripCostBps: options.roundTripCostBps,
    years: [...THREE_FOS_YEARS],
    marketEntryThresholds: { KOSPI: [75, 80], KOSDAQ: [75, 80] },
  });
  if (!result) throw new Error("V8-8 섹터 로테이션 검증 결과를 계산하지 못했습니다.");
  const threeFos = aggregateRows(result.rows);
  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
    study: "V8-8",
    primaryOos: {
      name: THREE_FOS_NAME,
      method: "three-fold-calendar-year-walk-forward-oos-with-purge",
      foldYears: [...THREE_FOS_YEARS],
      aggregation: "equal-weight-across-folds",
      constraints: {
        trainingRule: "for each fold, only dates strictly before the purge window are eligible for tuning/selection",
        purgeTradingDays: MAX_FORWARD_HORIZON,
        purgeReason: "prevent the fixed maximum 60D holding horizon from crossing into OOS during any tuning/selection step",
        oosRule: "primary performance uses only signals whose signal date belongs to the fold calendar year",
        futureDataForTuning: "forbidden",
        stockScorePolicy: "unchanged V8 10-point score with PL<80 +0.5 slot; sector comparison does not refit the stock score",
        sectorComparisonPolicy: "predeclared PL vs existing full Rotation Score using identical TOP50/TOP25 cross-sectional rank filters plus secondary raw 60/70 cutoffs",
        warmupHistory: "preserved before each OOS so rolling indicators and 5D rotation momentum remain continuous",
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
      roundTripCostBps: options.roundTripCostBps,
      marketEntryThresholds: result.marketEntryThresholds,
      scorePolicy: result.scorePolicy,
      strategyPolicy: result.strategyPolicy,
      sectorPolicy: result.sectorPolicy,
    },
    sourceFiles: inputs.map((input) => ({ id: input.id, fileName: input.fileName, bytes: input.bytes, savedAt: input.savedAt })),
    dataQuality: { inputContract: inputQuality, scoreAvailability, sectorFeatureCoverage: result.featureCoverage },
    result,
    threeFos,
  };
  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "sector-rotation-validation-3fos.json"), JSON.stringify(payload, null, 2));
  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/v8-sector-rotation-validation-3fos/latest.json`;
    await uploadJson(client, remotePath, payload);
  }
  process.stdout.write(`${JSON.stringify({
    outputDir,
    remotePath,
    study: payload.study,
    primaryOos: payload.primaryOos,
    run: payload.run,
    featureCoverage: result.featureCoverage,
    matchedComparisons: threeFos.matchedComparisons,
    quartileSpreads: threeFos.quartileSpreads,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
