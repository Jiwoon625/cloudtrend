import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { runSectorPenaltyBacktest } from "../src/lib/engine/sectorPenaltyBacktest";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildV8ScoreAvailabilityReport } from "../src/lib/engine/v8ScoreAvailability";
import { buildBacktestDataQuality } from "../src/lib/engine/backtestDataQuality";
import { codeVersion, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

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
      "  npx vite-node scripts/run-sector-penalty-backtest.ts --supabase-user-id <uuid> [--upload]",
      "Options:",
      "  --output <dir>  default: v8-sector-penalty-runs",
      "  --limit <count>  default: 613",
      "  --round-trip-cost-bps <bps>  default: 0",
      "Supabase mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v8-sector-penalty-runs",
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
    else if (arg === "--round-trip-cost-bps")
      options.roundTripCostBps = Number(argv[++i] ?? usage());
    else usage();
  }
  if (!options.supabaseUserId) usage();
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 2000)
    throw new Error("limit은 1~2000 정수여야 합니다.");
  if (
    !Number.isFinite(options.roundTripCostBps) ||
    options.roundTripCostBps < 0 ||
    options.roundTripCostBps > 1000
  )
    throw new Error("round-trip-cost-bps는 0~1000이어야 합니다.");
  return options;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = trustedSupabaseClient();
  const inputs = await loadAnalysisSourceInputs(client, options.supabaseUserId!, "backtest", {
    lightweight: true,
  });
  const parsed = parseManualMarketData(inputs.map((input) => input.text));
  const dataQuality = buildV8InputQualityReport(inputs);
  if (!dataQuality.validForV8) {
    throw new Error(
      `V8 필수 입력열이 없는 파일이 있습니다: ${JSON.stringify(dataQuality.filesMissingRequiredColumns)}`,
    );
  }
  const fullDataQuality = buildBacktestDataQuality(inputs, parsed.dataset, options.limit);
  const scoreAvailability = buildV8ScoreAvailabilityReport(parsed.dataset, options.limit);

  for (const input of inputs) {
    if (!input.sourceRecord) continue;
    const own = fullDataQuality.fileQuality.find((file) => file.sourceId === input.id) ?? null;
    const { symbols, ...universeSummary } = fullDataQuality.universeCoverage;
    const previousValidation = asRecord(input.sourceRecord.validation_result);
    const previousDataQuality = asRecord(previousValidation.dataQuality);
    const previousDataset = asRecord(previousDataQuality.dataset);
    const previousFeatureAudit = asRecord(previousDataset.featureAvailabilityAudit);
    const previousFeaturePolicy = asRecord(previousFeatureAudit.policy);
    const validationResult = {
      ...previousValidation,
      dataQuality: {
        ...previousDataQuality,
        version: fullDataQuality.version,
        generatedAt: fullDataQuality.generatedAt,
        file: own,
        dataset: {
          ...previousDataset,
          sourceFileCount: fullDataQuality.sourceFileCount,
          totalRows: fullDataQuality.totalRows,
          from: fullDataQuality.from,
          to: fullDataQuality.to,
          fieldCompleteness: fullDataQuality.fieldCompleteness,
          sourceDistribution: fullDataQuality.sourceDistribution,
          indexContinuity: fullDataQuality.indexContinuity,
          universeCoverage: universeSummary,
          symbolCoverage: symbols,
          featureAvailabilityAudit: {
            ...previousFeatureAudit,
            version: scoreAvailability.version,
            generatedAt: fullDataQuality.generatedAt,
            currentRun: scoreAvailability,
            policy: {
              ...previousFeaturePolicy,
              foreignNetBuyValueMissing:
                "외국인 20거래일 창에 null이 하나라도 있으면 Vf 전체 점수를 null로 유지한다.",
              sectorPriceLeadershipMissing:
                "PL이 없으면 섹터 슬롯 +0.5를 부여하지 않고 Vf 9.5점 base를 그대로 사용한다.",
            },
          },
        },
      },
    };
    const { error } = await client
      .from("analysis_source_files")
      .update({ validation_result: validationResult, updated_at: new Date().toISOString() })
      .eq("id", input.id)
      .eq("user_id", options.supabaseUserId!);
    if (error)
      throw new Error(`validation_result QA 저장 실패 (${input.fileName}): ${error.message}`);
  }

  const result = runSectorPenaltyBacktest(parsed.dataset, {
    limit: options.limit,
    roundTripCostBps: options.roundTripCostBps,
    entryThresholds: [65, 75],
    upsideExitThresholds: [95, 90, 85],
    downsideExitThresholds: [35, 30, 25],
    maxHoldingDays: [20, 30, 40],
    priceLeadershipOverheatThresholds: [70, 75, 80, 85],
    includeNoPenaltyBaseline: true,
  });
  if (!result) throw new Error("V8 섹터 과열 페널티 백테스트 결과를 계산하지 못했습니다.");

  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
    run: {
      id: runId,
      createdAt,
      engineVersion: "CloudTrend V8 Sector Penalty Backtest",
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
    })),
    dataQuality: {
      inputContract: dataQuality,
      full: fullDataQuality,
      scoreAvailability,
    },
    result,
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "sector-penalty-backtest.json"),
    JSON.stringify(payload, null, 2),
  );

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/sector-v8-penalty/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        outputDir,
        remotePath,
        run: payload.run,
        summary: {
          from: result.from,
          to: result.to,
          symbolCount: result.symbolCount,
          sectorCount: result.sectorCount,
          scoreAvailability,
          defaultRows: result.defaultRows,
          bestRows: result.bestRows,
          scoreModels: result.scoreModels,
        },
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
