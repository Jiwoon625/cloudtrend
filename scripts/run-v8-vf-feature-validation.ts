import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildV8ScoreAvailabilityReport } from "../src/lib/engine/v8ScoreAvailability";
import { buildV8VfConditionalValidation } from "../src/lib/engine/v8VfFeatureConditional";
import {
  V8_VF_FEATURE_HORIZONS,
  buildV8VfFeatureValidationFromSeries,
  prepareV8VfFeatureSeries,
  type V8VfFeatureValidationResult,
} from "../src/lib/engine/v8VfFeatureValidation";
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
      "  npx vite-node scripts/run-v8-vf-feature-validation.ts --supabase-user-id <uuid> [--upload]",
      "Options:",
      "  --output <dir>  default: v8-vf-feature-validation-runs",
      "  --limit <count>  default: 613",
      "  --round-trip-cost-bps <bps>  default: 0",
      "Supabase mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v8-vf-feature-validation-runs",
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

function compactRows(result: V8VfFeatureValidationResult) {
  return result.rows.filter(
    (row) =>
      row.scope === "SPLIT" &&
      (row.split === "ALL" || row.split === "OOS") &&
      row.market === "ALL",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = trustedSupabaseClient();
  const inputs = await loadAnalysisSourceInputs(client, options.supabaseUserId!, "backtest", {
    lightweight: true,
  });
  const parsed = parseManualMarketData(inputs.map((input) => input.text));
  const inputQuality = buildV8InputQualityReport(inputs);
  if (!inputQuality.validForV8) {
    throw new Error(
      `V8 필수 입력열이 없거나 전부 비어 있는 파일이 있습니다: ${JSON.stringify(inputQuality.filesInvalidRequiredColumns)}`,
    );
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

  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 2,
    run: {
      id: runId,
      createdAt,
      engineVersion: result.version,
      conditionalEngineVersion: conditional.version,
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
    result,
    conditional,
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "vf-feature-validation.json"),
    JSON.stringify(payload, null, 2),
  );

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/v8-vf-feature-validation/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  const conditionalKeyRows = conditional.rows.filter(
    (row) =>
      row.scope === "SPLIT" &&
      (row.split === "ALL" || row.split === "OOS") &&
      row.market === "ALL",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        outputDir,
        remotePath,
        run: payload.run,
        splitPolicy: result.splitPolicy,
        availability: result.availability,
        robustness: result.robustness,
        conditionalRobustness: conditional.robustness,
        keyRows: compactRows(result),
        conditionalKeyRows,
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
