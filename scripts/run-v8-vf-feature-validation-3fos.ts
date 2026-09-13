import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildV8ScoreAvailabilityReport } from "../src/lib/engine/v8ScoreAvailability";
import { buildV8VfConditionalValidation } from "../src/lib/engine/v8VfFeatureConditional";
import {
  V8_VF_FEATURE_HORIZONS,
  V8_VF_FEATURE_IDS,
  buildV8VfFeatureValidationFromSeries,
  prepareV8VfFeatureSeries,
  type V8VfFeatureMetricRow,
} from "../src/lib/engine/v8VfFeatureValidation";
import { codeVersion, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

const THREE_FOS_YEARS = [2018, 2022, 2025] as const;
const THREE_FOS_NAME = "3-FOS" as const;

interface Options {
  supabaseUserId: string | null;
  outputRoot: string;
  upload: boolean;
  limit: number;
  roundTripCostBps: number;
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npx vite-node scripts/run-v8-vf-feature-validation-3fos.ts --supabase-user-id <uuid> [--upload]",
      "Options:",
      "  --output <dir>  default: v8-vf-feature-validation-3fos-runs",
      "  --limit <count>  default: 613",
      "  --round-trip-cost-bps <bps>  default: 0",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v8-vf-feature-validation-3fos-runs",
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
  return options;
}

function avg(values: Array<number | null | undefined>) {
  const valid = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function median(values: Array<number | null | undefined>) {
  const valid = values
    .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = (valid.length - 1) / 2;
  return (valid[Math.floor(mid)]! + valid[Math.ceil(mid)]!) / 2;
}

function threeFosUnivariate(result: ReturnType<typeof buildV8VfFeatureValidationFromSeries>) {
  if (!result) return null;
  const foldRows = result.rows.filter(
    (row) => row.scope === "YEAR" && row.year !== null && THREE_FOS_YEARS.includes(row.year as (typeof THREE_FOS_YEARS)[number]),
  );

  const consensus = [] as Array<Record<string, unknown>>;
  for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
    for (const feature of V8_VF_FEATURE_IDS) {
      for (const signalKind of ["STATE", "ONSET"] as const) {
        for (const horizon of V8_VF_FEATURE_HORIZONS) {
          const rows = foldRows.filter(
            (row) =>
              row.market === market &&
              row.feature === feature &&
              row.signalKind === signalKind &&
              row.horizon === horizon,
          );
          const byYear = Object.fromEntries(THREE_FOS_YEARS.map((year) => [year, rows.find((row) => row.year === year) ?? null]));
          const available = rows.filter((row) => row.dailyExcessEdgeMean !== null);
          consensus.push({
            market,
            feature,
            signalKind,
            horizon,
            foldCount: available.length,
            foldYears: [...THREE_FOS_YEARS],
            signalCount: rows.reduce((sum, row) => sum + row.signalCount, 0),
            equalWeightAvgReturn: avg(rows.map((row) => row.avgReturn)),
            equalWeightMedianReturn: median(rows.map((row) => row.medianReturn)),
            equalWeightAvgExcessReturn: avg(rows.map((row) => row.avgExcessReturn)),
            equalWeightMedianExcessReturn: median(rows.map((row) => row.medianExcessReturn)),
            equalWeightDailyReturnEdge: avg(rows.map((row) => row.dailyReturnEdgeMean)),
            equalWeightDailyExcessEdge: avg(rows.map((row) => row.dailyExcessEdgeMean)),
            positiveExcessEdgeFolds: rows.filter((row) => (row.dailyExcessEdgeMean ?? -Infinity) > 0).length,
            significantPositiveExcessEdgeFolds: rows.filter(
              (row) => (row.dailyExcessEdgeCiLow ?? -Infinity) > 0,
            ).length,
            foldRows: byYear,
          });
        }
      }
    }
  }
  return { foldRows, consensus };
}

function threeFosConditional(conditional: ReturnType<typeof buildV8VfConditionalValidation>) {
  const foldRows = conditional.rows.filter(
    (row) => row.scope === "YEAR" && row.year !== null && THREE_FOS_YEARS.includes(row.year as (typeof THREE_FOS_YEARS)[number]),
  );
  const consensus = [] as Array<Record<string, unknown>>;
  for (const market of ["ALL", "KOSPI", "KOSDAQ"] as const) {
    for (const feature of V8_VF_FEATURE_IDS) {
      for (const horizon of V8_VF_FEATURE_HORIZONS) {
        const rows = foldRows.filter(
          (row) => row.market === market && row.feature === feature && row.horizon === horizon,
        );
        consensus.push({
          market,
          feature,
          horizon,
          foldCount: rows.length,
          foldYears: [...THREE_FOS_YEARS],
          equalWeightRawBeta: avg(rows.map((row) => row.rawBetaMean)),
          equalWeightExcessBeta: avg(rows.map((row) => row.excessBetaMean)),
          medianExcessBeta: median(rows.map((row) => row.excessBetaMean)),
          positiveExcessBetaFolds: rows.filter((row) => (row.excessBetaMean ?? -Infinity) > 0).length,
          significantPositiveExcessBetaFolds: rows.filter((row) => (row.excessBetaCiLow ?? -Infinity) > 0).length,
          foldRows: Object.fromEntries(THREE_FOS_YEARS.map((year) => [year, rows.find((row) => row.year === year) ?? null])),
        });
      }
    }
  }
  return { foldRows, consensus };
}

function summarizeFeatures(
  univariateConsensus: Array<Record<string, unknown>>,
  conditionalConsensus: Array<Record<string, unknown>>,
) {
  return V8_VF_FEATURE_IDS.map((feature) => {
    const uni = univariateConsensus.filter(
      (row) => row.market === "ALL" && row.feature === feature && row.signalKind === "STATE",
    );
    const onset = univariateConsensus.filter(
      (row) => row.market === "ALL" && row.feature === feature && row.signalKind === "ONSET",
    );
    const cond = conditionalConsensus.filter((row) => row.market === "ALL" && row.feature === feature);
    return {
      feature,
      statePositiveHorizons: uni.filter((row) => Number(row.equalWeightDailyExcessEdge) > 0).length,
      stateAll3PositiveHorizons: uni.filter((row) => Number(row.positiveExcessEdgeFolds) === 3).length,
      onsetPositiveHorizons: onset.filter((row) => Number(row.equalWeightDailyExcessEdge) > 0).length,
      onsetAll3PositiveHorizons: onset.filter((row) => Number(row.positiveExcessEdgeFolds) === 3).length,
      conditionalPositiveHorizons: cond.filter((row) => Number(row.equalWeightExcessBeta) > 0).length,
      conditionalAll3PositiveHorizons: cond.filter((row) => Number(row.positiveExcessBetaFolds) === 3).length,
      conditionalMedianExcessBeta: median(cond.map((row) => row.equalWeightExcessBeta as number | null)),
    };
  });
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

  const scoreAvailability = buildV8ScoreAvailabilityReport(parsed.dataset, options.limit);
  const series = prepareV8VfFeatureSeries(parsed.dataset, options.limit, 120);
  const result = buildV8VfFeatureValidationFromSeries(series, parsed.dataset.indexSeries, {
    limit: options.limit,
    horizons: [...V8_VF_FEATURE_HORIZONS],
    warmupDays: 120,
    roundTripCostBps: options.roundTripCostBps,
  });
  if (!result) throw new Error("V8 Vf 피처 재검증 결과를 계산하지 못했습니다.");

  const conditional = buildV8VfConditionalValidation(series, parsed.dataset.indexSeries, {
    horizons: [...V8_VF_FEATURE_HORIZONS],
    warmupDays: 120,
    roundTripCostBps: options.roundTripCostBps,
    minCrossSectionN: 30,
  });

  const univariate3Fos = threeFosUnivariate(result)!;
  const conditional3Fos = threeFosConditional(conditional);
  const featureSummary = summarizeFeatures(univariate3Fos.consensus, conditional3Fos.consensus);
  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
    study: "V8-1",
    primaryOos: {
      name: THREE_FOS_NAME,
      method: "three-fold-calendar-year-walk-forward-oos",
      foldYears: [...THREE_FOS_YEARS],
      aggregation: "equal-weight-across-folds",
      note: "V8-1은 파라미터 학습 단계가 아니므로 과거 데이터는 지표 warm-up에만 사용하고, OOS 평가는 2018/2022/2025 신호일에 한정한다. 후속 파라미터 선택 단계에서는 각 Fold 이전 데이터만 사용한다.",
    },
    run: {
      id: runId,
      createdAt,
      codeVersion: codeVersion(),
      datasetVersion: parsed.dataset.version,
      asOfDate: parsed.dataset.asOfDate,
      limit: options.limit,
      horizons: [...V8_VF_FEATURE_HORIZONS],
      roundTripCostBps: options.roundTripCostBps,
    },
    sourceFiles: inputs.map((input) => ({ id: input.id, fileName: input.fileName, bytes: input.bytes, savedAt: input.savedAt })),
    dataQuality: { inputContract: inputQuality, scoreAvailability },
    threeFos: {
      featureSummary,
      univariate: univariate3Fos,
      conditional: conditional3Fos,
    },
    fullSampleReference: {
      result,
      conditional,
    },
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "v8-1-3fos-feature-validation.json"), JSON.stringify(payload, null, 2));

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/v8-vf-feature-validation-3fos/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  process.stdout.write(`${JSON.stringify({
    outputDir,
    remotePath,
    study: payload.study,
    primaryOos: payload.primaryOos,
    run: payload.run,
    featureSummary,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
