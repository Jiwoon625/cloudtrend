import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { MarketDataset } from "../src/lib/engine/dataset";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildV8ScoreAvailabilityReport } from "../src/lib/engine/v8ScoreAvailability";
import {
  buildV8MarketSplitValidation,
  type V8MarketCode,
  type V8MarketSplitMetricRow,
  type V8RelativeStrengthOverlay,
} from "../src/lib/engine/v8MarketSplitValidation";
import { codeVersion, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

const THREE_FOS_YEARS = [2018, 2022, 2025] as const;
const THREE_FOS_NAME = "3-FOS" as const;
const PURGE_TRADING_DAYS = 60;
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
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npx vite-node scripts/run-v8-market-split-validation-3fos.ts --supabase-user-id <uuid> [--upload]",
    "Options:",
    "  --output <dir>  default: v8-market-split-3fos-runs",
    "  --limit <count>  default: 613",
    "  --round-trip-cost-bps <bps>  default: 0",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v8-market-split-3fos-runs",
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

function minFinite(values: Array<number | null | undefined>) {
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
    const trainEndIndex = oosStartIndex - PURGE_TRADING_DAYS - 1;
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
    };
  });
}

function aggregateRows(rows: V8MarketSplitMetricRow[]) {
  const foldRows = rows.filter(
    (row) => row.scope === "YEAR" && row.year !== null && THREE_FOS_YEARS.includes(row.year as ThreeFosYear),
  );
  const groups = new Map<string, V8MarketSplitMetricRow[]>();
  for (const row of foldRows) {
    const key = [row.market, row.entryThreshold, row.overlay].join("|");
    const xs = groups.get(key) ?? [];
    xs.push(row);
    groups.set(key, xs);
  }

  const aggregate = [...groups.values()].map((xs) => {
    const first = xs[0]!;
    return {
      market: first.market,
      entryThreshold: first.entryThreshold,
      overlay: first.overlay,
      foldCount: xs.length,
      foldYears: [...THREE_FOS_YEARS],
      totalRawOnsets: xs.reduce((sum, row) => sum + row.rawOnsets, 0),
      totalAcceptedTrades: xs.reduce((sum, row) => sum + row.acceptedTrades, 0),
      equalWeightOverlayPassRate: avg(xs.map((row) => row.overlayPassRate)),
      equalWeightAvgRs20: avg(xs.map((row) => row.avgRs20)),
      equalWeightAvgRs60: avg(xs.map((row) => row.avgRs60)),
      equalWeightAvgReturn: avg(xs.map((row) => row.avgReturn)),
      equalWeightMedianReturn: avg(xs.map((row) => row.medianReturn)),
      equalWeightWinRate: avg(xs.map((row) => row.winRate)),
      equalWeightProfitFactor: avg(xs.map((row) => row.profitFactor)),
      equalWeightAvgExcessReturn: avg(xs.map((row) => row.avgExcessReturn)),
      equalWeightMedianExcessReturn: avg(xs.map((row) => row.medianExcessReturn)),
      equalWeightExcessWinRate: avg(xs.map((row) => row.excessWinRate)),
      equalWeightAvgMae: avg(xs.map((row) => row.avgMae)),
      equalWeightAvgMfe: avg(xs.map((row) => row.avgMfe)),
      equalWeightAvgHoldingDays: avg(xs.map((row) => row.avgHoldingDays)),
      equalWeightUpsideExitRate: avg(xs.map((row) => row.upsideExitRate)),
      equalWeightDownsideExitRate: avg(xs.map((row) => row.downsideExitRate)),
      equalWeightTimeExitRate: avg(xs.map((row) => row.timeExitRate)),
      equalWeightDailyAvgExcessHacMean: avg(xs.map((row) => row.dailyAvgExcessHacMean)),
      positiveAvgExcessFolds: xs.filter((row) => (row.avgExcessReturn ?? Number.NEGATIVE_INFINITY) > 0).length,
      positiveMedianExcessFolds: xs.filter((row) => (row.medianExcessReturn ?? Number.NEGATIVE_INFINITY) > 0).length,
      all3PositiveAvgExcess: xs.length === 3 && xs.every((row) => (row.avgExcessReturn ?? Number.NEGATIVE_INFINITY) > 0),
      all3PositiveMedianExcess: xs.length === 3 && xs.every((row) => (row.medianExcessReturn ?? Number.NEGATIVE_INFINITY) > 0),
      worstFoldAvgExcess: minFinite(xs.map((row) => row.avgExcessReturn)),
      foldRows: Object.fromEntries(THREE_FOS_YEARS.map((year) => [year, xs.find((row) => row.year === year) ?? null])),
    };
  });

  return { foldRows, aggregate };
}

function buildRobustness(
  aggregate: ReturnType<typeof aggregateRows>["aggregate"],
  marketEntryThresholds: Record<V8MarketCode, number[]>,
  overlays: V8RelativeStrengthOverlay[],
) {
  const markets: V8MarketCode[] = ["KOSPI", "KOSDAQ"];
  return markets.flatMap((market) =>
    marketEntryThresholds[market].map((entryThreshold) => {
      const xs = aggregate.filter((row) => row.market === market && row.entryThreshold === entryThreshold);
      const none = xs.find((row) => row.overlay === "NONE") ?? null;
      const overlayRows = overlays.filter((overlay) => overlay !== "NONE").map((overlay) => xs.find((row) => row.overlay === overlay) ?? null);
      const validOverlayRows = overlayRows.filter((row): row is NonNullable<typeof row> => row !== null);
      return {
        market,
        entryThreshold,
        overlayCount: xs.length,
        positiveAvgExcessOverlays: xs.filter((row) => (row.equalWeightAvgExcessReturn ?? Number.NEGATIVE_INFINITY) > 0).length,
        all3PositiveAvgExcessOverlays: xs.filter((row) => row.all3PositiveAvgExcess).length,
        positiveMedianExcessOverlays: xs.filter((row) => (row.equalWeightMedianExcessReturn ?? Number.NEGATIVE_INFINITY) > 0).length,
        all3PositiveMedianExcessOverlays: xs.filter((row) => row.all3PositiveMedianExcess).length,
        noOverlay: none,
        bestOverlayByAvgExcess: [...validOverlayRows].sort((a, b) => (b.equalWeightAvgExcessReturn ?? -Infinity) - (a.equalWeightAvgExcessReturn ?? -Infinity))[0] ?? null,
        bestOverlayByWorstFold: [...validOverlayRows].sort((a, b) => (b.worstFoldAvgExcess ?? -Infinity) - (a.worstFoldAvgExcess ?? -Infinity))[0] ?? null,
        medianOverlayAvgExcess: median(validOverlayRows.map((row) => row.equalWeightAvgExcessReturn)),
      };
    }),
  );
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
  const result = buildV8MarketSplitValidation(parsed.dataset, {
    limit: options.limit,
    warmupDays: 120,
    roundTripCostBps: options.roundTripCostBps,
    priceLeadershipOverheatThreshold: 80,
    marketEntryThresholds: { KOSPI: [65, 70, 75, 80], KOSDAQ: [75, 80] },
  });
  if (!result) throw new Error("V8-6 시장 분리 검증 결과를 계산하지 못했습니다.");

  if (
    result.scorePolicy.scoreMax !== 10 ||
    result.scorePolicy.baseScoreMax !== 9.5 ||
    result.scorePolicy.sectorSlotPoints !== 0.5 ||
    result.priceLeadershipOverheatThreshold !== 80 ||
    result.scorePolicy.sameScaleForBothMarkets !== true
  ) {
    throw new Error(`V8-6은 고정된 10점 체계여야 합니다: ${JSON.stringify(result.scorePolicy)}`);
  }

  const rows3Fos = aggregateRows(result.rows);
  const robustness3Fos = buildRobustness(rows3Fos.aggregate, result.marketEntryThresholds, result.overlays);
  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
    study: "V8-6",
    primaryOos: {
      name: THREE_FOS_NAME,
      method: "three-fold-calendar-year-walk-forward-oos-with-purge",
      foldYears: [...THREE_FOS_YEARS],
      aggregation: "equal-weight-across-folds",
      constraints: {
        purgeTradingDays: PURGE_TRADING_DAYS,
        purgeReason: "prevent fixed max-60D strategy outcomes before OOS from crossing into OOS",
        oosRule: "primary performance uses only signals whose signal date belongs to the fold calendar year",
        futureDataForTuning: "forbidden",
        marketEntryThresholds: result.marketEntryThresholds,
        overlays: result.overlays,
        candidateSetPolicy: "pre-specified market thresholds and RS overlays; 3-FOS is validation, not an OOS refit",
        scorePolicyFrozenBeforeRun: true,
        scorePolicyNote: "keep existing 10-point score unchanged: base 9.5 + sector PL slot 0.5, PL>=80 receives no sector slot, missing PL receives no sector slot",
        v85ResultUsedToRetuneScore: false,
        finalMarketRuleSelection: "deferred; do not select final market-specific rule from 3-FOS alone",
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
      overlays: result.overlays,
      scorePolicy: result.scorePolicy,
      strategyPolicy: result.strategyPolicy,
      priceLeadershipOverheatThreshold: result.priceLeadershipOverheatThreshold,
      roundTripCostBps: options.roundTripCostBps,
    },
    sourceFiles: inputs.map((input) => ({ id: input.id, fileName: input.fileName, bytes: input.bytes, savedAt: input.savedAt })),
    dataQuality: { inputContract: inputQuality, scoreAvailability },
    result,
    threeFos: {
      rows: rows3Fos,
      robustness: robustness3Fos,
    },
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "market-split-validation-3fos.json"), JSON.stringify(payload, null, 2));

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/v8-market-split-validation-3fos/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  process.stdout.write(`${JSON.stringify({
    outputDir,
    remotePath,
    study: payload.study,
    primaryOos: payload.primaryOos,
    run: payload.run,
    robustness: robustness3Fos,
    keyRows: rows3Fos.aggregate,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
