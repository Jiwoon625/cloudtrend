import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildV8InputQualityReport } from "../src/lib/engine/v8InputQuality";
import { buildV8ScoreAvailabilityReport } from "../src/lib/engine/v8ScoreAvailability";
import {
  buildV8MarketSplitValidation,
  type V8MarketCode,
  type V8RelativeStrengthOverlay,
} from "../src/lib/engine/v8MarketSplitValidation";
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
    "  npx vite-node scripts/run-v8-market-split-validation.ts --supabase-user-id <uuid> [--upload]",
    "Options:",
    "  --output <dir>  default: v8-market-split-runs",
    "  --limit <count>  default: 613",
    "  --round-trip-cost-bps <bps>  default: 0",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v8-market-split-runs",
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
  const result = buildV8MarketSplitValidation(parsed.dataset, {
    limit: options.limit,
    warmupDays: 120,
    roundTripCostBps: options.roundTripCostBps,
    priceLeadershipOverheatThreshold: 80,
    marketEntryThresholds: { KOSPI: [65, 70, 75, 80], KOSDAQ: [75, 80] },
  });
  if (!result) throw new Error("V8 시장 분리 검증 결과를 계산하지 못했습니다.");

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
      overlays: result.overlays,
      roundTripCostBps: options.roundTripCostBps,
    },
    sourceFiles: inputs.map((input) => ({ id: input.id, fileName: input.fileName, bytes: input.bytes, savedAt: input.savedAt })),
    dataQuality: { inputContract: inputQuality, scoreAvailability },
    result,
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "market-split-validation.json"), JSON.stringify(payload, null, 2));

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/v8-market-split-validation/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  const oos = result.rows.filter((row) => row.scope === "SPLIT" && row.split === "OOS");
  const yearly = result.rows.filter((row) => row.scope === "YEAR");
  const markets: V8MarketCode[] = ["KOSPI", "KOSDAQ"];
  const best = markets.flatMap((market) => {
    const thresholds = result.marketEntryThresholds[market];
    return thresholds.map((entryThreshold) => {
      const rows = oos.filter((row) => row.market === market && row.entryThreshold === entryThreshold && row.acceptedTrades >= 100);
      const by = (pick: (row: typeof rows[number]) => number | null) => [...rows].sort((a, b) => (pick(b) ?? -Infinity) - (pick(a) ?? -Infinity))[0] ?? null;
      return {
        market,
        entryThreshold,
        bestAvgExcess: by((row) => row.avgExcessReturn),
        bestMedianExcess: by((row) => row.medianExcessReturn),
        bestExcessWinRate: by((row) => row.excessWinRate),
      };
    });
  });

  const robustness = markets.flatMap((market) => result.marketEntryThresholds[market].flatMap((entryThreshold) =>
    result.overlays.map((overlay: V8RelativeStrengthOverlay) => {
      const rows = yearly.filter((row) => row.market === market && row.entryThreshold === entryThreshold && row.overlay === overlay && row.acceptedTrades > 0);
      return {
        market,
        entryThreshold,
        overlay,
        years: rows.length,
        positiveAvgExcessYears: rows.filter((row) => (row.avgExcessReturn ?? 0) > 0).length,
        positiveMedianExcessYears: rows.filter((row) => (row.medianExcessReturn ?? 0) > 0).length,
      };
    }),
  ));

  process.stdout.write(`${JSON.stringify({
    outputDir,
    remotePath,
    run: payload.run,
    splitPolicy: result.splitPolicy,
    scorePolicy: result.scorePolicy,
    strategyPolicy: result.strategyPolicy,
    oos,
    best,
    robustness,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

// Workflow trigger marker for V8-6 market split validation.
