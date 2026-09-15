import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { trustedSupabaseClient } from "./analysis-run-store";
import { listSourceRecords } from "./source-registry-store";

type Mode = "manifest" | "materialize";

interface Options {
  mode: Mode;
  userId: string | null;
  manifestPath: string;
  cacheDir: string;
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
  cacheFile: string;
}

export interface BacktestSourceCacheManifest {
  schemaVersion: 1;
  sourceType: "backtest";
  createdAt: string;
  cacheKey: string;
  fileCount: number;
  totalBytes: number;
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
  if (mode !== "manifest" && mode !== "materialize") usage("첫 인자는 manifest 또는 materialize여야 합니다.");
  const options: Options = {
    mode,
    userId: process.env["SUPABASE_USER_ID"] ?? null,
    manifestPath: ".cache/cloudtrend-backtest-manifest.json",
    cacheDir: ".cache/cloudtrend-backtest",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--supabase-user-id") options.userId = argv[++i] ?? usage("--supabase-user-id 값이 없습니다.");
    else if (arg === "--manifest") options.manifestPath = argv[++i] ?? usage("--manifest 값이 없습니다.");
    else if (arg === "--cache-dir") options.cacheDir = argv[++i] ?? usage("--cache-dir 값이 없습니다.");
    else usage(`지원하지 않는 인자입니다: ${arg}`);
  }
  if (mode === "manifest" && !/^[0-9a-f-]{36}$/i.test(options.userId ?? ""))
    usage("manifest 생성에는 유효한 Supabase user id가 필요합니다.");
  return options;
}

function hashBytes(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestFromHash(fileHash: string) {
  const digest = fileHash.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/i.test(digest)) throw new Error(`잘못된 file hash: ${fileHash}`);
  return digest.toLowerCase();
}

function cacheKeyFor(files: BacktestSourceCacheManifestFile[]) {
  const canonical = [...files]
    .map((file) => ({ fileHash: file.fileHash, bytes: file.bytes }))
    .sort((a, b) => a.fileHash.localeCompare(b.fileHash));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function createManifest(options: Options) {
  const client = trustedSupabaseClient();
  const records = await listSourceRecords(client, options.userId!, "backtest", ["active"]);
  if (records.length === 0) throw new Error("활성 백테스트 원천데이터가 없습니다.");
  const files: BacktestSourceCacheManifestFile[] = records.map((record) => ({
    id: record.id,
    fileName: record.original_filename,
    bytes: record.file_size_bytes,
    savedAt: record.activated_at ?? record.created_at,
    fileHash: record.file_hash,
    dataHash: record.data_hash,
    schemaHash: record.schema_hash,
    storageBucket: record.storage_bucket,
    storagePath: record.storage_path,
    cacheFile: `${digestFromHash(record.file_hash)}.source`,
  }));
  const manifest: BacktestSourceCacheManifest = {
    schemaVersion: 1,
    sourceType: "backtest",
    createdAt: new Date().toISOString(),
    cacheKey: cacheKeyFor(files),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
  await mkdir(path.dirname(path.resolve(options.manifestPath)), { recursive: true });
  await writeFile(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const githubOutput = process.env["GITHUB_OUTPUT"];
  if (githubOutput) {
    await appendFile(
      githubOutput,
      [`cache_key=${manifest.cacheKey}`, `file_count=${manifest.fileCount}`, `source_bytes=${manifest.totalBytes}`].join("\n") + "\n",
    );
  }
  process.stdout.write(
    `${JSON.stringify({ mode: "manifest", cacheKey: manifest.cacheKey, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes }, null, 2)}\n`,
  );
}

async function readManifest(manifestPath: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BacktestSourceCacheManifest;
  if (manifest.schemaVersion !== 1 || manifest.sourceType !== "backtest" || !Array.isArray(manifest.files))
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

async function materialize(options: Options) {
  const manifest = await readManifest(options.manifestPath);
  const client = trustedSupabaseClient();
  await mkdir(options.cacheDir, { recursive: true });
  let cacheHits = 0;
  let downloadedFiles = 0;
  let downloadedBytes = 0;
  for (const file of manifest.files) {
    const target = path.join(options.cacheDir, file.cacheFile);
    if (await usableCachedFile(target, file)) {
      cacheHits += 1;
      continue;
    }
    const { data, error } = await client.storage.from(file.storageBucket).download(file.storagePath);
    if (error || !data)
      throw new Error(`Supabase 백테스트 원천 다운로드 실패 (${file.fileName}): ${error?.message ?? "unknown"}`);
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.byteLength !== file.bytes || hashBytes(bytes) !== file.fileHash)
      throw new Error(`백테스트 원천 무결성 검증 실패: ${file.fileName}`);
    await writeFile(target, bytes);
    downloadedFiles += 1;
    downloadedBytes += bytes.byteLength;
  }
  process.stdout.write(
    `${JSON.stringify({ mode: "materialize", cacheKey: manifest.cacheKey, fileCount: manifest.fileCount, cacheHits, downloadedFiles, downloadedBytes }, null, 2)}\n`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "manifest") await createManifest(options);
  else await materialize(options);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
