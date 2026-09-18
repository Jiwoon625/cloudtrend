import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";

import { trustedSupabaseClient } from "./analysis-run-store";
import { listSourceRecords, type SourceRecord } from "./source-registry-store";

type Mode = "manifest" | "materialize";

interface Options {
  mode: Mode;
  userId: string | null;
  manifestPath: string;
  cacheDir: string;
}

interface CanonicalMigrationMeta {
  version?: string;
  logicalFileHash?: string;
  logicalSizeBytes?: number;
}

export interface BacktestSourceCacheManifestFile {
  id: string;
  fileName: string;
  bytes: number;
  savedAt: string;
  fileHash: string;
  dataHash: string;
  schemaHash: string;
  storageBucket: string;
  storagePath: string;
  storageBytes?: number;
  storageFileHash?: string;
  canonicalFormat?: string;
  cacheFile: string;
}

export interface BacktestSourceCacheManifest {
  schemaVersion: 1;
  sourceType: "backtest";
  createdAt: string;
  cacheKey: string;
  fileCount: number;
  totalBytes: number;
  totalStorageBytes?: number;
  files: BacktestSourceCacheManifestFile[];
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npm run backtest:cache -- manifest --supabase-user-id <uuid> --manifest <path>",
      "  npm run backtest:cache -- materialize --manifest <path> --cache-dir <dir>",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const mode = argv.shift();
  if (mode !== "manifest" && mode !== "materialize")
    usage("첫 인자는 manifest 또는 materialize여야 합니다.");
  const options: Options = {
    mode,
    userId: process.env["SUPABASE_USER_ID"] ?? null,
    manifestPath: ".cache/cloudtrend-backtest-manifest.json",
    cacheDir: ".cache/cloudtrend-backtest",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--supabase-user-id")
      options.userId = argv[++i] ?? usage("--supabase-user-id 값이 없습니다.");
    else if (arg === "--manifest")
      options.manifestPath = argv[++i] ?? usage("--manifest 값이 없습니다.");
    else if (arg === "--cache-dir")
      options.cacheDir = argv[++i] ?? usage("--cache-dir 값이 없습니다.");
    else usage(`지원하지 않는 인자입니다: ${arg}`);
  }
  if (mode === "manifest" && !/^[0-9a-f-]{36}$/i.test(options.userId ?? ""))
    usage("manifest 생성에는 유효한 Supabase user id가 필요합니다.");
  return options;
}

function hashBytes(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestFromHash(hash: string) {
  const digest = hash.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/i.test(digest)) throw new Error(`잘못된 hash: ${hash}`);
  return digest.toLowerCase();
}

export function cacheKeyFor(files: BacktestSourceCacheManifestFile[]) {
  // Preserve source precedence and distinguish different CSV encodings of the same data.
  // Physical gzip/parquet paths do not invalidate this logical identity.
  const canonical = files.map((file) => ({
    id: file.id,
    dataHash: file.dataHash,
    schemaHash: file.schemaHash,
    fileHash: file.fileHash,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function migrationMeta(record: SourceRecord): CanonicalMigrationMeta {
  const validation = record.validation_result as Record<string, unknown> | null;
  const migration = validation?.["backtestCanonicalMigration"];
  if (!migration || typeof migration !== "object") return {};
  return migration as CanonicalMigrationMeta;
}

function logicalFileIdentity(record: SourceRecord) {
  const migration = migrationMeta(record);
  const logicalFileHash =
    typeof migration.logicalFileHash === "string" ? migration.logicalFileHash : record.file_hash;
  const logicalSizeBytes =
    typeof migration.logicalSizeBytes === "number" && Number.isFinite(migration.logicalSizeBytes)
      ? migration.logicalSizeBytes
      : record.file_size_bytes;
  return { logicalFileHash, logicalSizeBytes };
}

async function createManifest(options: Options) {
  const client = trustedSupabaseClient();
  const records = await listSourceRecords(client, options.userId!, "backtest", ["active"]);
  if (records.length === 0) throw new Error("활성 백테스트 원천데이터가 없습니다.");

  const files: BacktestSourceCacheManifestFile[] = records.map((record) => {
    const logical = logicalFileIdentity(record);
    return {
      id: record.id,
      fileName: record.original_filename,
      bytes: logical.logicalSizeBytes,
      savedAt: record.activated_at ?? record.created_at,
      fileHash: logical.logicalFileHash,
      dataHash: record.data_hash,
      schemaHash: record.schema_hash,
      storageBucket: record.storage_bucket,
      storagePath: record.storage_path,
      storageBytes: record.file_size_bytes,
      storageFileHash: record.file_hash,
      canonicalFormat: record.canonical_format,
      cacheFile: `${digestFromHash(logical.logicalFileHash)}.source`,
    };
  });

  const manifest: BacktestSourceCacheManifest = {
    schemaVersion: 1,
    sourceType: "backtest",
    createdAt: new Date().toISOString(),
    cacheKey: cacheKeyFor(files),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    totalStorageBytes: files.reduce((sum, file) => sum + (file.storageBytes ?? file.bytes), 0),
    files,
  };

  await mkdir(path.dirname(path.resolve(options.manifestPath)), { recursive: true });
  await writeFile(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const githubOutput = process.env["GITHUB_OUTPUT"];
  if (githubOutput) {
    await appendFile(
      githubOutput,
      [
        `cache_key=${manifest.cacheKey}`,
        `file_count=${manifest.fileCount}`,
        `source_bytes=${manifest.totalBytes}`,
        `storage_bytes=${manifest.totalStorageBytes ?? manifest.totalBytes}`,
      ].join("\n") + "\n",
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "manifest",
        cacheKey: manifest.cacheKey,
        fileCount: manifest.fileCount,
        logicalBytes: manifest.totalBytes,
        storageBytes: manifest.totalStorageBytes,
      },
      null,
      2,
    )}\n`,
  );
}

export async function readManifest(manifestPath: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BacktestSourceCacheManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.sourceType !== "backtest" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== manifest.fileCount
  )
    throw new Error("지원하지 않는 백테스트 cache manifest입니다.");
  if (cacheKeyFor(manifest.files) !== manifest.cacheKey)
    throw new Error("백테스트 cache manifest hash가 일치하지 않습니다.");
  return manifest;
}

async function usableCachedFile(filePath: string, file: BacktestSourceCacheManifestFile) {
  try {
    const info = await stat(filePath);
    if (info.size !== file.bytes) return false;
    const bytes = new Uint8Array(await readFile(filePath));
    return hashBytes(bytes) === file.fileHash;
  } catch {
    return false;
  }
}

function unpackStoredBytes(file: BacktestSourceCacheManifestFile, stored: Uint8Array) {
  const format = (file.canonicalFormat ?? "csv").toLowerCase();
  if (format === "csv.gz" || format === "gzip" || file.storagePath.toLowerCase().endsWith(".gz")) {
    return new Uint8Array(gunzipSync(stored));
  }
  return stored;
}

export async function materialize(options: Options) {
  const manifest = await readManifest(options.manifestPath);
  let client: ReturnType<typeof trustedSupabaseClient> | undefined;
  await mkdir(options.cacheDir, { recursive: true });

  let cacheHits = 0;
  let downloadedFiles = 0;
  let downloadedBytes = 0;
  let materializedBytes = 0;

  for (const file of manifest.files) {
    if (!/^[0-9a-f]{64}\.source$/.test(file.cacheFile)) throw new Error("Invalid cache path");
    const target = path.join(options.cacheDir, file.cacheFile);
    if (await usableCachedFile(target, file)) {
      cacheHits += 1;
      continue;
    }

    client ??= trustedSupabaseClient();
    const { data, error } = await client.storage
      .from(file.storageBucket)
      .download(file.storagePath);
    if (error || !data)
      throw new Error(
        `Supabase 백테스트 원천 다운로드 실패 (${file.fileName}): ${error?.message ?? "unknown"}`,
      );

    const stored = new Uint8Array(await data.arrayBuffer());
    const expectedStorageBytes = file.storageBytes ?? file.bytes;
    const expectedStorageHash = file.storageFileHash ?? file.fileHash;
    if (stored.byteLength !== expectedStorageBytes || hashBytes(stored) !== expectedStorageHash)
      throw new Error(`백테스트 저장객체 무결성 검증 실패: ${file.fileName}`);

    const logical = unpackStoredBytes(file, stored);
    if (logical.byteLength !== file.bytes || hashBytes(logical) !== file.fileHash)
      throw new Error(`백테스트 논리 원천 무결성 검증 실패: ${file.fileName}`);

    await writeFile(target, logical);
    downloadedFiles += 1;
    downloadedBytes += stored.byteLength;
    materializedBytes += logical.byteLength;
  }

  const report = { cacheHits, downloadedFiles, downloadedStorageBytes: downloadedBytes };
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "materialize",
        cacheKey: manifest.cacheKey,
        fileCount: manifest.fileCount,
        cacheHits,
        downloadedFiles,
        downloadedStorageBytes: downloadedBytes,
        materializedLogicalBytes: materializedBytes,
      },
      null,
      2,
    )}\n`,
  );
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "manifest") await createManifest(options);
  else await materialize(options);
}

if (process.argv[1]?.endsWith("backtest-source-cache.ts"))
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
