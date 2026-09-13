import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildV8ScoreAvailabilityReport } from "../src/lib/engine/v8ScoreAvailability";
import {
  buildV8ExitHoldingValidation,
  V8_EXIT_DOWNSIDE_THRESHOLDS,
  V8_EXIT_MAX_HOLDING_DAYS,
  V8_EXIT_UPSIDE_THRESHOLDS,
} from "../src/lib/engine/v8ExitHoldingValidation";
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
  throw new Error([
    "Usage:",
    "  npx vite-node scripts/run-v8-exit-holding-validation.ts --supabase-user-id <uuid> [--upload]",
    "Options:",
    "  --output <dir>  default: v8-exit-holding-runs",
    "  --limit <count>  default: 613",
    "  --round-trip-cost-bps <bps>  default: 0",
    "Supabase mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v8-exit-holding-runs",
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
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 2000)
    throw new Error("limit은 1~2000 정수여야 합니다.");
  if (!Number.isFinite(options.roundTripCostBps) || options.roundTripCostBps < 0 || options.roundTripCostBps > 1000)
    throw new Error("round-trip-cost-bps는 0~1000이어야 합니다.");
  return options;
}

function topRows<T extends { market: string; entryThreshold: number; avgExcessReturn: number | null; medianExcessReturn: number | null; profitFactor: number | null; acceptedTrades: number }>(rows: T[], pick: (row: T) => number | null) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.market}|${row.entryThreshold}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, list]) => ({
    key,
    row: [...list].filter((row) => row.acceptedTrades >= 100).sort((a, b) => (pick(b) ?? Number.NEGATIVE_INFINITY) - (pick(a) ?? Number.NEGATIVE_INFINITY))[0] ?? null,
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
  const scoreAvailability = buildV8ScoreAvailabilityReport(parsed.dataset, options.limit);
  const result = buildV8ExitHoldingValidation(parsed.dataset, {
    limit: options.limit,
    warmupDays: 120,
    roundTripCostBps: options.roundTripCostBps,
    priceLeadershipOverheatThreshold: 80,
    marketEntryThresholds: { KOSPI: [65, 75], KOSDAQ: [75, 80] },
    upsideExitThresholds: [...V8_EXIT_UPSIDE_THRESHOLDS],
    downsideExitThresholds: [...V8_EXIT_DOWNSIDE_THRESHOLDS],
    maxHoldingDays: [...V8_EXIT_MAX_HOLDING_DAYS],
  });
  if (!result) throw new Error("V8 청산 임계값·보유기간 결과를 계산하지 못했습니다.");

  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
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
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "exit-holding-validation.json"), JSON.stringify(payload, null, 2));

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/v8-exit-holding-validation/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  const oos = result.rows.filter((row) => row.scope === "SPLIT" && row.split === "OOS");
  const timeOnlyOos = oos.filter((row) => row.exitMode === "TIME_ONLY");
  const keyRows = {
    topAvgExcess: topRows(oos, (row) => row.avgExcessReturn),
    topMedianExcess: topRows(oos, (row) => row.medianExcessReturn),
    topProfitFactor: topRows(oos, (row) => row.profitFactor),
    timeOnlyOos,
  };

  process.stdout.write(`${JSON.stringify({
    outputDir,
    remotePath,
    run: payload.run,
    splitPolicy: result.splitPolicy,
    scorePolicy: result.scorePolicy,
    executionPolicy: result.executionPolicy,
    scenarioCount: result.scenarios.length,
    keyRows,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

// Workflow trigger marker for V8-4 long exit and holding validation.
