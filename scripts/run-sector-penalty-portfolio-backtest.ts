import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  runSectorPenaltyPortfolioBacktest,
  SECTOR_PENALTY_PORTFOLIO_VERSION,
} from "../src/lib/engine/sectorPenaltyPortfolioBacktest";
import { codeVersion, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

interface Options {
  supabaseUserId: string | null;
  outputRoot: string;
  upload: boolean;
  limit: number;
  initialCapital: number;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  npx vite-node scripts/run-sector-penalty-portfolio-backtest.ts --supabase-user-id <uuid> [--upload]",
    "Options:",
    "  --output <dir>             default: v8-sector-penalty-portfolio-runs",
    "  --limit <count>            default: 613",
    "  --initial-capital <won>    default: 100000000",
    "Supabase mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
  ].join("\n"));
}

function parseArgs(argv: string[]): Options {
  const options: Options = { supabaseUserId: null, outputRoot: "v8-sector-penalty-portfolio-runs", upload: false, limit: 613, initialCapital: 100_000_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--supabase-user-id") options.supabaseUserId = argv[++i] ?? usage();
    else if (arg === "--output") options.outputRoot = argv[++i] ?? usage();
    else if (arg === "--upload") options.upload = true;
    else if (arg === "--limit") options.limit = Number(argv[++i] ?? usage());
    else if (arg === "--initial-capital") options.initialCapital = Number(argv[++i] ?? usage());
    else usage();
  }
  if (!options.supabaseUserId) usage();
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 2000) throw new Error("limit은 1~2000 정수여야 합니다.");
  if (!Number.isFinite(options.initialCapital) || options.initialCapital <= 0) throw new Error("initial-capital은 양수여야 합니다.");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = trustedSupabaseClient();
  const inputs = await loadAnalysisSourceInputs(client, options.supabaseUserId!, "backtest");
  const parsed = parseManualMarketData(inputs.map((input) => input.text));
  const result = runSectorPenaltyPortfolioBacktest(parsed.dataset, {
    limit: options.limit,
    initialCapital: options.initialCapital,
    roundTripCostBps: [0, 15, 30],
    maxPositions: [5, 10, 20],
    weightModes: ["EQUAL_WEIGHT", "MAX_20", "MAX_10"],
  });
  if (!result) throw new Error("V8 섹터 과열 포트폴리오 백테스트 결과를 계산하지 못했습니다.");

  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
    run: {
      id: runId,
      createdAt,
      engineVersion: SECTOR_PENALTY_PORTFOLIO_VERSION,
      codeVersion: codeVersion(),
      datasetVersion: parsed.dataset.version,
      asOfDate: parsed.dataset.asOfDate,
      limit: options.limit,
      initialCapital: options.initialCapital,
      roundTripCostBps: [0, 15, 30],
      maxPositions: [5, 10, 20],
      weightModes: ["EQUAL_WEIGHT", "MAX_20", "MAX_10"],
    },
    sourceFiles: inputs.map((input) => ({ id: input.id, fileName: input.fileName, bytes: input.bytes, savedAt: input.savedAt })),
    result,
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "sector-penalty-portfolio-backtest.json"), JSON.stringify(payload, null, 2));

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/sector-v8-penalty-portfolio/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  process.stdout.write(`${JSON.stringify({
    outputDir,
    remotePath,
    run: payload.run,
    summary: {
      metadata: result.metadata,
      scenarioDefinitions: result.scenarioDefinitions,
      portfolioAssumptions: result.portfolioAssumptions,
      bestRows: result.bestRows,
      rowCount: result.rows.length,
    },
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
