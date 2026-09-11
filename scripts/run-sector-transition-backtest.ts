import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { runSectorScoreTransitionBacktest } from "../src/lib/engine/sectorScoreTransitionBacktest";
import {
  codeVersion,
  trustedSupabaseClient,
  uploadJson,
} from "./analysis-run-store";
import { loadAnalysisSourceInputs } from "./source-registry-store";

interface Options {
  supabaseUserId: string | null;
  outputRoot: string;
  upload: boolean;
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npx vite-node scripts/run-sector-transition-backtest.ts --supabase-user-id <uuid> [--upload]",
      "Options:",
      "  --output <dir>  default: v7-sector-transition-runs",
      "Supabase mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    supabaseUserId: null,
    outputRoot: "v7-sector-transition-runs",
    upload: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--supabase-user-id") options.supabaseUserId = argv[++i] ?? usage();
    else if (arg === "--output") options.outputRoot = argv[++i] ?? usage();
    else if (arg === "--upload") options.upload = true;
    else usage();
  }
  if (!options.supabaseUserId) usage();
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = trustedSupabaseClient();
  const inputs = await loadAnalysisSourceInputs(client, options.supabaseUserId!, "backtest");
  const parsed = parseManualMarketData(inputs.map((input) => input.text));
  const result = runSectorScoreTransitionBacktest(parsed.dataset);
  if (!result) throw new Error("V7.3 섹터 점수대 전환 백테스트 결과를 계산하지 못했습니다.");

  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const payload = {
    schemaVersion: 1,
    run: {
      id: runId,
      createdAt,
      engineVersion: "CloudTrend V7.3 Sector Score Band Transition Backtest",
      codeVersion: codeVersion(),
      datasetVersion: parsed.dataset.version,
      asOfDate: parsed.dataset.asOfDate,
    },
    sourceFiles: inputs.map((input) => ({
      id: input.id,
      fileName: input.fileName,
      bytes: input.bytes,
      savedAt: input.savedAt,
    })),
    result,
  };

  const outputDir = path.resolve(options.outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "sector-score-transitions.json"), JSON.stringify(payload, null, 2));

  let remotePath: string | null = null;
  if (options.upload) {
    remotePath = `${options.supabaseUserId}/results/sector-v7-transition/latest.json`;
    await uploadJson(client, remotePath, payload);
  }

  process.stdout.write(`${JSON.stringify({ outputDir, remotePath, run: payload.run, result }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
