import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";

import { ANALYSIS_BUCKET, downloadJson, trustedSupabaseClient } from "./analysis-run-store";

const VERSION = "etf-backtest-canonical-v1" as const;

interface CanonicalObject {
  path: string;
  fileHash: string;
  sizeBytes: number;
}

interface EtfBacktestCanonicalIndex {
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

interface CacheManifest {
  version: "etf-backtest-cache-v1";
  createdAt: string;
  cacheKey: string;
  sourceFilename: string;
  logicalFileHash: string;
  logicalSizeBytes: number;
  cacheFile: string;
  gzip: CanonicalObject;
  parquet: CanonicalObject & { compression: "zstd" };
}

function sha256(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function userId() {
  const value = process.env["SUPABASE_USER_ID"] ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("SUPABASE_USER_ID is required");
  return value;
}

function indexPath(uid: string) {
  return `${uid}/source/etf-backtest-canonical/v1/latest.json`;
}

function argValue(args: string[], name: string, fallback: string) {
  const idx = args.indexOf(name);
  return idx >= 0 ? (args[idx + 1] ?? fallback) : fallback;
}

async function writeGithubOutput(name: string, value: string) {
  const output = process.env["GITHUB_OUTPUT"];
  if (!output) return;
  const prior = await readFile(output, "utf8").catch(() => "");
  await writeFile(output, `${prior}${name}=${value}\n`, "utf8");
}

async function buildManifest(manifestPath: string) {
  const uid = userId();
  const client = trustedSupabaseClient();
  const index = await downloadJson<EtfBacktestCanonicalIndex>(client, indexPath(uid));
  if (index.version !== VERSION)
    throw new Error(`Unsupported ETF canonical version: ${index.version}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(index.logicalFileHash))
    throw new Error("Invalid ETF logical file hash");
  const key = index.logicalFileHash.replace(/^sha256:/, "");
  const manifest: CacheManifest = {
    version: "etf-backtest-cache-v1",
    createdAt: new Date().toISOString(),
    cacheKey: key,
    sourceFilename: index.sourceFilename,
    logicalFileHash: index.logicalFileHash,
    logicalSizeBytes: index.logicalSizeBytes,
    cacheFile: `${key}.source`,
    gzip: index.gzip,
    parquet: index.parquet,
  };
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  await writeGithubOutput("cache_key", key);
  process.stdout.write(JSON.stringify({ command: "manifest", ...manifest }, null, 2) + "\n");
}

async function readManifest(manifestPath: string) {
  const value = JSON.parse(await readFile(manifestPath, "utf8")) as CacheManifest;
  if (value.version !== "etf-backtest-cache-v1") throw new Error("Invalid ETF cache manifest");
  if (!/^[0-9a-f]{64}$/.test(value.cacheKey)) throw new Error("Invalid ETF cache key");
  if (value.cacheFile !== `${value.cacheKey}.source`) throw new Error("Invalid ETF cache file");
  return value;
}

async function validLocal(filePath: string, manifest: CacheManifest) {
  try {
    const bytes = new Uint8Array(await readFile(filePath));
    return (
      bytes.byteLength === manifest.logicalSizeBytes && sha256(bytes) === manifest.logicalFileHash
    );
  } catch {
    return false;
  }
}

async function materialize(manifestPath: string, cacheDir: string) {
  const manifest = await readManifest(manifestPath);
  await mkdir(cacheDir, { recursive: true });
  const filePath = path.join(cacheDir, manifest.cacheFile);
  if (await validLocal(filePath, manifest)) {
    process.stdout.write(
      JSON.stringify(
        {
          command: "materialize",
          cacheHit: true,
          downloadedStorageBytes: 0,
          cacheFile: manifest.cacheFile,
          logicalFileHash: manifest.logicalFileHash,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  await rm(filePath, { force: true });
  const client = trustedSupabaseClient();
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(manifest.gzip.path);
  if (error || !data)
    throw new Error(`ETF canonical gzip download failed: ${error?.message ?? "unknown"}`);
  const stored = new Uint8Array(await data.arrayBuffer());
  if (stored.byteLength !== manifest.gzip.sizeBytes || sha256(stored) !== manifest.gzip.fileHash)
    throw new Error("ETF canonical gzip storage integrity failure");

  const logical = new Uint8Array(gunzipSync(stored));
  if (
    logical.byteLength !== manifest.logicalSizeBytes ||
    sha256(logical) !== manifest.logicalFileHash
  )
    throw new Error("ETF canonical logical CSV integrity failure");

  const temp = `${filePath}.tmp-${process.pid}`;
  await writeFile(temp, logical);
  await rename(temp, filePath);

  process.stdout.write(
    JSON.stringify(
      {
        command: "materialize",
        cacheHit: false,
        downloadedStorageBytes: stored.byteLength,
        cacheFile: manifest.cacheFile,
        logicalFileHash: manifest.logicalFileHash,
      },
      null,
      2,
    ) + "\n",
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const manifestPath = argValue(
    args,
    "--manifest",
    process.env["ETF_BACKTEST_SOURCE_MANIFEST"] ?? ".cache/cloudtrend-etf-backtest-manifest.json",
  );
  const cacheDir = argValue(
    args,
    "--cache-dir",
    process.env["ETF_BACKTEST_CACHE_DIR"] ?? ".cache/cloudtrend-etf-backtest",
  );

  if (command === "manifest") await buildManifest(manifestPath);
  else if (command === "materialize") await materialize(manifestPath, cacheDir);
  else
    throw new Error(
      "Usage: etf-backtest-cache.ts <manifest|materialize> [--manifest path] [--cache-dir dir]",
    );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
