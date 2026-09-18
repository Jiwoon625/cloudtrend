import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  ANALYSIS_BUCKET,
  downloadJson,
  trustedSupabaseClient,
  uploadJson,
} from "./analysis-run-store";

const execFileAsync = promisify(execFile);
const VERSION = "etf-backtest-canonical-v1" as const;
const DEFAULT_FILENAME = "trendscore_input_20260918_061658.csv";

interface CanonicalObject {
  path: string;
  fileHash: string;
  sizeBytes: number;
}

export interface EtfBacktestCanonicalIndex {
  version: typeof VERSION;
  createdAt: string;
  sourceFilename: string;
  logicalFileHash: string;
  logicalSizeBytes: number;
  rowCount: number;
  columnCount: number;
  gzip: CanonicalObject;
  parquet: CanonicalObject & { compression: "zstd" };
  replacedStoragePath: string;
}

function sha256(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decode(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

function safeStem(filename: string) {
  return (
    path
      .basename(filename)
      .normalize("NFKC")
      .replace(/[^0-9A-Za-z가-힣._-]/g, "-")
      .replace(/\.(csv|txt)$/i, "")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 100) || "etf-backtest"
  );
}

function userId() {
  const value = process.env["SUPABASE_USER_ID"] ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("SUPABASE_USER_ID is required");
  return value;
}

function indexPath(uid: string) {
  return `${uid}/source/etf-backtest-canonical/v1/latest.json`;
}

async function buildParquet(csvBytes: Uint8Array) {
  const temp = await mkdtemp(path.join(tmpdir(), "cloudtrend-etf-parquet-"));
  try {
    const csvPath = path.join(temp, "source.csv");
    const parquetPath = path.join(temp, "source.parquet");
    await writeFile(csvPath, decode(csvBytes), "utf8");
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
    if (!info.roundtripVerified) throw new Error("ETF Parquet roundtrip verification failed");
    const bytes = new Uint8Array(await readFile(parquetPath));
    return { bytes, info };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function uploadAndVerify(objectPath: string, bytes: Uint8Array) {
  const client = trustedSupabaseClient();
  const { error } = await client.storage.from(ANALYSIS_BUCKET).upload(objectPath, bytes, {
    upsert: true,
    contentType: "application/octet-stream",
    cacheControl: "31536000",
  });
  if (error) throw new Error(`ETF canonical upload failed (${objectPath}): ${error.message}`);
  const { data, error: readError } = await client.storage.from(ANALYSIS_BUCKET).download(objectPath);
  if (readError || !data) throw new Error(`ETF canonical read-back failed: ${objectPath}`);
  const readBack = new Uint8Array(await data.arrayBuffer());
  if (readBack.byteLength !== bytes.byteLength || sha256(readBack) !== sha256(bytes))
    throw new Error(`ETF canonical hash verification failed: ${objectPath}`);
}

async function verifyIndex(index: EtfBacktestCanonicalIndex) {
  const client = trustedSupabaseClient();
  const { data: gzData, error: gzError } = await client.storage
    .from(ANALYSIS_BUCKET)
    .download(index.gzip.path);
  if (gzError || !gzData) throw new Error("ETF canonical gzip is missing");
  const gz = new Uint8Array(await gzData.arrayBuffer());
  if (gz.byteLength !== index.gzip.sizeBytes || sha256(gz) !== index.gzip.fileHash)
    throw new Error("ETF canonical gzip integrity failure");
  const logical = new Uint8Array(gunzipSync(gz));
  if (logical.byteLength !== index.logicalSizeBytes || sha256(logical) !== index.logicalFileHash)
    throw new Error("ETF canonical logical CSV integrity failure");

  const { data: pqData, error: pqError } = await client.storage
    .from(ANALYSIS_BUCKET)
    .download(index.parquet.path);
  if (pqError || !pqData) throw new Error("ETF canonical parquet is missing");
  const pq = new Uint8Array(await pqData.arrayBuffer());
  if (pq.byteLength !== index.parquet.sizeBytes || sha256(pq) !== index.parquet.fileHash)
    throw new Error("ETF canonical parquet integrity failure");
  return logical;
}

async function persistLocalCache(logical: Uint8Array, index: EtfBacktestCanonicalIndex) {
  const cacheDir = process.env["ETF_BACKTEST_CACHE_DIR"];
  if (!cacheDir) return;
  await mkdir(cacheDir, { recursive: true });
  const key = index.logicalFileHash.replace(/^sha256:/, "");
  await writeFile(path.join(cacheDir, `${key}.source`), logical);
}

async function main() {
  const uid = userId();
  const filename = process.env["ETF_STAGING_FILENAME"] ?? DEFAULT_FILENAME;
  const stagingPath = `${uid}/source/backtest/${filename}`;
  const client = trustedSupabaseClient();

  const { data: sourceBlob, error: sourceError } = await client.storage
    .from(ANALYSIS_BUCKET)
    .download(stagingPath);

  if (sourceError || !sourceBlob) {
    const existing = await downloadJson<EtfBacktestCanonicalIndex>(client, indexPath(uid));
    if (existing.version !== VERSION || existing.sourceFilename !== filename)
      throw new Error("ETF staging source is missing and canonical index does not match");
    const logical = await verifyIndex(existing);
    await persistLocalCache(logical, existing);
    process.stdout.write(
      JSON.stringify({ status: "already-canonical", ...existing }, null, 2) + "\n",
    );
    return;
  }

  const logical = new Uint8Array(await sourceBlob.arrayBuffer());
  const logicalFileHash = sha256(logical);
  const hashKey = logicalFileHash.replace(/^sha256:/, "");
  const root = `${uid}/source/etf-backtest-canonical/v1/${hashKey}`;
  const stem = safeStem(filename);

  const gzip = new Uint8Array(gzipSync(logical, { level: 9 }));
  const parquet = await buildParquet(logical);
  const gzipPath = `${root}/${stem}.csv.gz`;
  const parquetPath = `${root}/${stem}.parquet`;

  await uploadAndVerify(gzipPath, gzip);
  await uploadAndVerify(parquetPath, parquet.bytes);

  const index: EtfBacktestCanonicalIndex = {
    version: VERSION,
    createdAt: new Date().toISOString(),
    sourceFilename: filename,
    logicalFileHash,
    logicalSizeBytes: logical.byteLength,
    rowCount: parquet.info.rowCount,
    columnCount: parquet.info.columnCount,
    gzip: {
      path: gzipPath,
      fileHash: sha256(gzip),
      sizeBytes: gzip.byteLength,
    },
    parquet: {
      path: parquetPath,
      fileHash: sha256(parquet.bytes),
      sizeBytes: parquet.bytes.byteLength,
      compression: "zstd",
    },
    replacedStoragePath: stagingPath,
  };

  await uploadJson(client, indexPath(uid), index);
  const verifiedLogical = await verifyIndex(index);
  await persistLocalCache(verifiedLogical, index);

  const { error: removeError } = await client.storage.from(ANALYSIS_BUCKET).remove([stagingPath]);
  if (removeError) throw new Error(`ETF raw CSV cleanup failed: ${removeError.message}`);

  process.stdout.write(
    JSON.stringify(
      {
        status: "canonicalized",
        version: VERSION,
        logicalFileHash,
        logicalSizeBytes: logical.byteLength,
        gzipStorageBytes: gzip.byteLength,
        parquetStorageBytes: parquet.bytes.byteLength,
        combinedCanonicalBytes: gzip.byteLength + parquet.bytes.byteLength,
        storageReductionVsRawBytes:
          logical.byteLength - (gzip.byteLength + parquet.bytes.byteLength),
        rowCount: parquet.info.rowCount,
        columnCount: parquet.info.columnCount,
        indexPath: indexPath(uid).replace(uid, "<user>"),
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
