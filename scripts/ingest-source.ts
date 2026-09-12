import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  SOURCE_MAX_FILE_BYTES,
  type SourceType,
  type SourceUploadOrigin,
  validateSourceBytes,
} from "../src/lib/sourceData";
import { trustedSupabaseClient } from "./analysis-run-store";
import {
  listSourceRecords,
  registerSourceBytes,
  removeSourceRecord,
  type SourceRegistrationMode,
} from "./source-registry-store";

type Action = "register" | "validate_only" | "list" | "remove";
type RunMode = "none" | "screening" | "backtest" | "all";

interface Options {
  action: Action;
  inputPath: string | null;
  sourceType: SourceType | null;
  registrationMode: SourceRegistrationMode | null;
  userId: string;
  origin: SourceUploadOrigin;
  removeSourceId: string | null;
  syncLegacy: boolean;
  run: RunMode;
  force: boolean;
  limit: number;
  roundTripCostBps: number;
  includeEtf: boolean;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npm run data:ingest -- --input <file.csv> --source-type screening --mode replace --supabase-user-id <uuid>",
      "  npm run data:ingest -- --input <file.csv> --source-type backtest --mode add --supabase-user-id <uuid>",
      "  npm run data:ingest -- --input <file.csv> --source-type backtest --mode replace_all --run backtest",
      "  npm run data:ingest -- --input <file.csv> --source-type screening --mode validate_only",
      "  npm run data:ingest -- --list --source-type backtest --supabase-user-id <uuid>",
      "  npm run data:ingest -- --remove-source-id <uuid> --supabase-user-id <uuid>",
      "",
      "screening modes: replace | append | merge | validate_only",
      "backtest modes: add | replace_all | validate_only",
      "Options: --upload-source gpt|web|github_action|migration, --no-sync-legacy, --run screening|backtest|all, --force",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    action: "register",
    inputPath: null,
    sourceType: null,
    registrationMode: null,
    userId: process.env["SUPABASE_USER_ID"] ?? "",
    origin: "gpt",
    removeSourceId: null,
    syncLegacy: true,
    run: "none",
    force: false,
    limit: 613,
    roundTripCostBps: 0,
    includeEtf: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "--input") options.inputPath = argv[++i] ?? usage("--input 값이 없습니다.");
    else if (argument === "--source-type") {
      const value = argv[++i];
      if (value !== "screening" && value !== "backtest")
        usage("--source-type은 screening 또는 backtest여야 합니다.");
      options.sourceType = value;
    } else if (argument === "--mode") {
      const value = argv[++i];
      if (value === "validate_only") options.action = "validate_only";
      else if (["replace", "append", "merge", "add", "replace_all"].includes(value ?? ""))
        options.registrationMode = value as SourceRegistrationMode;
      else usage("지원하지 않는 --mode입니다.");
    } else if (argument === "--supabase-user-id")
      options.userId = argv[++i] ?? usage("--supabase-user-id 값이 없습니다.");
    else if (argument === "--upload-source") {
      const value = argv[++i];
      if (!["gpt", "web", "github_action", "migration"].includes(value ?? ""))
        usage("지원하지 않는 --upload-source입니다.");
      options.origin = value as SourceUploadOrigin;
    } else if (argument === "--list") options.action = "list";
    else if (argument === "--remove-source-id") {
      options.action = "remove";
      options.removeSourceId = argv[++i] ?? usage("--remove-source-id 값이 없습니다.");
    } else if (argument === "--no-sync-legacy") options.syncLegacy = false;
    else if (argument === "--run") {
      const value = argv[++i];
      if (!["screening", "backtest", "all"].includes(value ?? ""))
        usage("지원하지 않는 --run입니다.");
      options.run = value as RunMode;
    } else if (argument === "--force") options.force = true;
    else if (argument === "--limit")
      options.limit = Number(argv[++i] ?? usage("--limit 값이 없습니다."));
    else if (argument === "--round-trip-cost-bps")
      options.roundTripCostBps = Number(argv[++i] ?? usage("--round-trip-cost-bps 값이 없습니다."));
    else if (argument === "--include-etf") options.includeEtf = true;
    else if (argument === "--exclude-etf") options.includeEtf = false;
    else usage(`지원하지 않는 인자입니다: ${argument}`);
  }

  if (options.action === "register" || options.action === "validate_only") {
    if (!options.inputPath) usage("입력 파일이 필요합니다.");
    if (!options.sourceType) usage("--source-type이 필요합니다.");
  }
  if (options.action === "register") {
    options.registrationMode ??= options.sourceType === "screening" ? "replace" : "add";
  }
  if (options.action === "list" && !options.sourceType)
    usage("--list에는 --source-type이 필요합니다.");
  if (options.action !== "validate_only" && !/^[0-9a-f-]{36}$/i.test(options.userId))
    usage("유효한 --supabase-user-id가 필요합니다.");
  if (options.run !== "none" && options.action !== "register")
    usage("--run은 등록 작업과 함께 사용해야 합니다.");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 2000)
    usage("--limit은 1~2000 정수여야 합니다.");
  if (
    !Number.isFinite(options.roundTripCostBps) ||
    options.roundTripCostBps < 0 ||
    options.roundTripCostBps > 1000
  )
    usage("--round-trip-cost-bps는 0~1000이어야 합니다.");
  return options;
}

function validationJson(validation: Awaited<ReturnType<typeof validateSourceBytes>>) {
  return {
    valid: validation.valid,
    format: validation.format,
    filename: validation.originalFilename,
    contentType: validation.contentType,
    originalSizeBytes: validation.originalSizeBytes,
    normalizedSizeBytes: validation.normalizedSizeBytes,
    columns: validation.columns,
    stats: validation.stats,
    hashes: {
      file: validation.fileHash,
      data: validation.dataHash,
      schema: validation.schemaHash,
    },
    errorCount: validation.errors.length,
    warningCount: validation.warnings.length,
    errors: validation.errors.slice(0, 100),
    warnings: validation.warnings.slice(0, 100),
  };
}

function runAnalysis(options: Options) {
  const common = ["--supabase-user-id", options.userId, "--upload"];
  if (options.force) common.push("--force");
  const results: Record<string, unknown> = {};
  if (options.run === "screening" || options.run === "all") {
    const output = execFileSync("npm", ["run", "screening:run", "--", ...common], {
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
    });
    results["screening"] = JSON.parse(output.slice(output.indexOf("{")));
  }
  if (options.run === "backtest" || options.run === "all") {
    const backtest = [
      ...common,
      "--limit",
      String(options.limit),
      "--round-trip-cost-bps",
      String(options.roundTripCostBps),
      options.includeEtf ? "--include-etf" : "--exclude-etf",
    ];
    const output = execFileSync("npm", ["run", "backtest:run", "--", ...backtest], {
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
    });
    results["backtest"] = JSON.parse(output.slice(output.indexOf("{")));
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === "list") {
    const client = trustedSupabaseClient();
    const sources = await listSourceRecords(client, options.userId, options.sourceType!, [
      "active",
      "superseded",
      "archived",
      "invalid",
    ]);
    process.stdout.write(`${JSON.stringify({ ok: true, action: "list", sources }, null, 2)}\n`);
    return;
  }
  if (options.action === "remove") {
    const client = trustedSupabaseClient();
    const removed = await removeSourceRecord(client, options.userId, options.removeSourceId!);
    process.stdout.write(
      `${JSON.stringify({ ok: true, action: "remove", removed: removed ? { id: removed.id, filename: removed.original_filename } : null }, null, 2)}\n`,
    );
    return;
  }

  const absolutePath = path.resolve(options.inputPath!);
  const bytes = new Uint8Array(await readFile(absolutePath));
  if (bytes.byteLength > SOURCE_MAX_FILE_BYTES)
    throw new Error("파일 1개 크기는 45MB 이하여야 합니다. CSV를 기간별로 나눠 주세요.");
  const validation = await validateSourceBytes({ bytes, filename: path.basename(absolutePath) });
  if (options.action === "validate_only") {
    let engineCompatibility: Record<string, unknown>;
    try {
      const parsed = validation.valid ? parseManualMarketData(validation.canonicalCsv) : null;
      engineCompatibility = parsed
        ? { valid: true, stats: parsed.stats, warnings: parsed.warnings }
        : { valid: false, error: "파일 형식 검증을 먼저 통과해야 합니다." };
    } catch (error) {
      engineCompatibility = {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const ok = validation.valid && engineCompatibility["valid"] === true;
    process.stdout.write(
      `${JSON.stringify({ ok, action: "validate_only", validation: validationJson(validation), engineCompatibility }, null, 2)}\n`,
    );
    if (!ok) process.exitCode = 2;
    return;
  }

  const client = trustedSupabaseClient();
  const registered = await registerSourceBytes({
    client,
    userId: options.userId,
    sourceType: options.sourceType!,
    mode: options.registrationMode!,
    origin: options.origin,
    bytes,
    filename: path.basename(absolutePath),
    syncLegacy: options.syncLegacy,
  });
  const analysis = options.run === "none" ? null : runAnalysis(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        action: "register",
        sourceType: options.sourceType,
        mode: options.registrationMode,
        reused: registered.reused,
        source: {
          id: registered.source.id,
          filename: registered.source.original_filename,
          status: registered.source.status,
          storagePath: registered.source.storage_path,
          createdAt: registered.source.created_at,
        },
        validation: validationJson(registered.validation),
        overlap: registered.overlap,
        analysis,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
