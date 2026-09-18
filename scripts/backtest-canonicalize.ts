import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";

import { ANALYSIS_BUCKET, trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { listSourceRecords, type SourceRecord } from "./source-registry-store";

const execFileAsync = promisify(execFile);
const MIGRATION_VERSION = "backtest-canonical-parquet-v1" as const;

interface Options {
  userId: string | null;
}

interface MigrationMeta {
  version: typeof MIGRATION_VERSION;
  migratedAt: string;
  logicalFileHash: string;
  logicalSizeBytes: number;
  gzip: {
    path: string;
    fileHash: string;
    sizeBytes: number;
  };
  parquet: {
    path: string;
    fileHash: string;
    sizeBytes: number;
    rowCount: number;
    columnCount: number;
    compression: "zstd";
  };
  replacedStoragePath: string;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node scripts/backtest-canonicalize.ts --supabase-user-id <uuid>",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = { userId: process.env["SUPABASE_USER_ID"] ?? null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--supabase-user-id")
      options.userId = argv[++i] ?? usage("--supabase-user-id 값이 없습니다.");
    else usage(`지원하지 않는 인자입니다: ${arg}`);
  }
  if (!/^[0-9a-f-]{36}$/i.test(options.userId ?? ""))
    usage("유효한 Supabase user id가 필요합니다.");
  return options;
}

function hashBytes(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function safeStem(filename: string) {
  return (
    path
      .basename(filename)
      .normalize("NFKC")
      .replace(/[^0-9A-Za-z가-힣._-]/g, "-")
      .replace(/\.(csv|txt|json|xlsx)$/i, "")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 100) || "source"
  );
}

function decodeSourceBytes(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

function existingMigration(record: SourceRecord) {
  const value = (record.validation_result as Record<string, unknown> | null)?.[
    "backtestCanonicalMigration"
  ];
  return value && typeof value === "object" ? (value as Partial<MigrationMeta>) : null;
}

function sourceFingerprint(records: SourceRecord[]) {
  const canonical = records
    .map((record) => ({ dataHash: record.data_hash, schemaHash: record.schema_hash }))
    .sort((a, b) => `${a.dataHash}:${a.schemaHash}`.localeCompare(`${b.dataHash}:${b.schemaHash}`));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function downloadObject(record: SourceRecord) {
  const client = trustedSupabaseClient();
  const cacheDir = process.env["BACKTEST_SOURCE_CACHE_DIR"];
  if (cacheDir && record.canonical_format === "csv") {
    try {
      const cached = new Uint8Array(
        await readFile(path.join(cacheDir, `${record.file_hash.replace(/^sha256:/, "")}.source`)),
      );
      if (cached.byteLength === record.file_size_bytes && hashBytes(cached) === record.file_hash)
        return { stored: cached, logical: cached };
    } catch {
      /* Missing local copy: download and verify below. */
    }
  }
  const { data, error } = await client.storage
    .from(record.storage_bucket)
    .download(record.storage_path);
  if (error || !data)
    throw new Error(
      `원천 다운로드 실패 (${record.original_filename}): ${error?.message ?? "unknown"}`,
    );
  const stored = new Uint8Array(await data.arrayBuffer());
  if (stored.byteLength !== record.file_size_bytes || hashBytes(stored) !== record.file_hash)
    throw new Error(`원천 저장객체 무결성 검증 실패: ${record.original_filename}`);
  if (record.canonical_format === "csv.gz" || record.storage_path.toLowerCase().endsWith(".gz")) {
    return {
      stored,
      logical: new Uint8Array(gunzipSync(stored)),
    };
  }
  return { stored, logical: stored };
}

async function buildParquet(csvBytes: Uint8Array, expectedRows: number) {
  const temp = await mkdtemp(path.join(tmpdir(), "cloudtrend-parquet-"));
  try {
    const csvPath = path.join(temp, "source.csv");
    const parquetPath = path.join(temp, "source.parquet");
    await writeFile(csvPath, decodeSourceBytes(csvBytes), "utf8");
    const helperPath = path.resolve("scripts/csv-to-parquet.py");
    const { stdout } = await execFileAsync("python3", [helperPath, csvPath, parquetPath], {
      maxBuffer: 1024 * 1024,
    });
    const info = JSON.parse(stdout.trim()) as {
      rowCount: number;
      columnCount: number;
      compression: "zstd";
      roundtripVerified: boolean;
    };
    if (!info.roundtripVerified) throw new Error("Parquet roundtrip was not verified");
    if (info.rowCount !== expectedRows)
      throw new Error(
        `Parquet row count 불일치: expected=${expectedRows}, actual=${info.rowCount}`,
      );
    const bytes = new Uint8Array(await readFile(parquetPath));
    return { bytes, info };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function uploadObject(objectPath: string, bytes: Uint8Array, contentType: string) {
  const client = trustedSupabaseClient();
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(objectPath, bytes, {
    upsert: true,
    contentType,
    cacheControl: "31536000",
  });
  if (error) throw new Error(`canonical object 업로드 실패 (${objectPath}): ${error.message}`);
  // Read back the small compressed object before moving the registry/deleting CSV.
  const { data, error: readError } = await client.storage
    .from(ANALYSIS_BUCKET)
    .download(objectPath);
  if (
    readError ||
    !data ||
    hashBytes(new Uint8Array(await data.arrayBuffer())) !== hashBytes(bytes)
  )
    throw new Error(`Uploaded object verification failed: ${objectPath}`);
}

async function migrateRecord(record: SourceRecord, userId: string) {
  const prior = existingMigration(record);
  if (
    record.canonical_format === "csv.gz" &&
    prior?.version === MIGRATION_VERSION &&
    prior.parquet?.path
  ) {
    // A prior run may have committed the registry and then failed deleting the CSV.
    // Recheck both replacements before completing that cleanup on retry.
    if (prior.replacedStoragePath && prior.replacedStoragePath !== record.storage_path) {
      const { logical } = await downloadObject(record);
      if (hashBytes(logical) !== prior.logicalFileHash)
        throw new Error("Migrated gzip integrity failure");
      const client = trustedSupabaseClient();
      const { data, error } = await client.storage
        .from(record.storage_bucket)
        .download(prior.parquet.path);
      if (
        error ||
        !data ||
        hashBytes(new Uint8Array(await data.arrayBuffer())) !== prior.parquet.fileHash
      )
        throw new Error("Migrated Parquet integrity failure");
      if (!prior.replacedStoragePath.startsWith(`${userId}/source/backtest/`))
        throw new Error("Unexpected original source path");
      const { error: removeError } = await client.storage
        .from(record.storage_bucket)
        .remove([prior.replacedStoragePath]);
      if (removeError) throw removeError;
    }
    return { record, migration: prior as MigrationMeta, changed: false };
  }
  if (record.source_type !== "backtest")
    throw new Error(`백테스트 이외 원천은 변환할 수 없습니다: ${record.original_filename}`);
  if (!/\.csv$/i.test(record.original_filename))
    throw new Error(`현재 canonical migration은 CSV만 지원합니다: ${record.original_filename}`);

  const client = trustedSupabaseClient();
  const oldPath = record.storage_path;
  const { logical } = await downloadObject(record);
  const logicalFileHash = hashBytes(logical);
  const logicalSizeBytes = logical.byteLength;
  const gzipBytes = new Uint8Array(gzipSync(logical, { level: 9 }));
  const gzipHash = hashBytes(gzipBytes);
  const parquet = await buildParquet(logical, record.row_count);
  const parquetHash = hashBytes(parquet.bytes);
  const stem = safeStem(record.original_filename);
  const root = `${userId}/source/backtest-canonical/v1/${record.id}`;
  const gzipPath = `${root}/${stem}.csv.gz`;
  const parquetPath = `${root}/${stem}.parquet`;

  await uploadObject(gzipPath, gzipBytes, "application/octet-stream");
  await uploadObject(parquetPath, parquet.bytes, "application/octet-stream");

  const migration: MigrationMeta = {
    version: MIGRATION_VERSION,
    migratedAt: new Date().toISOString(),
    logicalFileHash,
    logicalSizeBytes,
    gzip: {
      path: gzipPath,
      fileHash: gzipHash,
      sizeBytes: gzipBytes.byteLength,
    },
    parquet: {
      path: parquetPath,
      fileHash: parquetHash,
      sizeBytes: parquet.bytes.byteLength,
      rowCount: parquet.info.rowCount,
      columnCount: parquet.info.columnCount,
      compression: "zstd",
    },
    replacedStoragePath: oldPath,
  };

  const validationResult = {
    ...(record.validation_result ?? {}),
    backtestCanonicalMigration: migration,
  };
  const { data: updated, error: updateError } = await client
    .from("analysis_source_files")
    .update({
      storage_bucket: ANALYSIS_BUCKET,
      storage_path: gzipPath,
      content_type: "application/octet-stream",
      canonical_format: "csv.gz",
      file_size_bytes: gzipBytes.byteLength,
      file_hash: gzipHash,
      validation_result: validationResult,
      updated_at: new Date().toISOString(),
    })
    .eq("id", record.id)
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("storage_path", oldPath)
    .eq("file_hash", record.file_hash)
    .select("id")
    .single();
  if (updateError || !updated)
    throw new Error(
      `원천 registry canonical 전환 실패 (${record.original_filename}): ${updateError?.message ?? "concurrent registry change"}`,
    );

  if (oldPath !== gzipPath) {
    const { error: removeError } = await client.storage
      .from(record.storage_bucket)
      .remove([oldPath]);
    if (removeError)
      throw new Error(`기존 CSV 삭제 실패 (${record.original_filename}): ${removeError.message}`);
  }

  return { record, migration, changed: true };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = trustedSupabaseClient();
  const records = await listSourceRecords(client, options.userId!, "backtest", ["active"]);
  if (records.length === 0) throw new Error("활성 백테스트 원천데이터가 없습니다.");

  const beforeBytes = records.reduce((sum, record) => sum + record.file_size_bytes, 0);
  const results = [];
  for (const record of records) {
    const result = await migrateRecord(record, options.userId!);
    results.push(result);
    process.stdout.write(
      `${result.changed ? "MIGRATED" : "SKIPPED"} ${record.original_filename} -> ${result.migration.gzip.path}\n`,
    );
  }

  const refreshed = await listSourceRecords(client, options.userId!, "backtest", ["active"]);
  if (sourceFingerprint(records) !== sourceFingerprint(refreshed))
    throw new Error("Active source set changed during migration; rerun before publishing manifest");
  const fingerprint = sourceFingerprint(refreshed);
  const gzipBytes = refreshed.reduce((sum, record) => sum + record.file_size_bytes, 0);
  const parquetBytes = results.reduce(
    (sum, result) => sum + (result.migration.parquet?.sizeBytes ?? 0),
    0,
  );
  const indexPath = `${options.userId}/source/backtest-canonical/v1/latest.json`;
  await uploadJson(client, indexPath, {
    version: MIGRATION_VERSION,
    createdAt: new Date().toISOString(),
    sourceFingerprint: fingerprint,
    fileCount: refreshed.length,
    logicalSourceBytes: results.reduce(
      (sum, result) => sum + (result.migration.logicalSizeBytes ?? 0),
      0,
    ),
    gzipStorageBytes: gzipBytes,
    parquetStorageBytes: parquetBytes,
    files: results.map(({ record, migration }) => ({
      id: record.id,
      originalFilename: record.original_filename,
      dataHash: record.data_hash,
      schemaHash: record.schema_hash,
      logicalFileHash: migration.logicalFileHash,
      logicalSizeBytes: migration.logicalSizeBytes,
      gzip: migration.gzip,
      parquet: migration.parquet,
    })),
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        version: MIGRATION_VERSION,
        activeFiles: refreshed.length,
        sourceFingerprint: fingerprint,
        beforeStorageBytes: beforeBytes,
        gzipStorageBytes: gzipBytes,
        parquetStorageBytes: parquetBytes,
        combinedCanonicalBytes: gzipBytes + parquetBytes,
        indexPath,
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
