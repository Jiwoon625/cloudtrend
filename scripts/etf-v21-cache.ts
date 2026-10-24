import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ANALYSIS_BUCKET, downloadJson, trustedSupabaseClient } from "./analysis-run-store";

const V21_DIR = "source/etf-backtest-canonical/v2.1";
const COLLECTION_MANIFEST = "collection_manifest_v2.1_20260921_082942_576565.json";

interface V21Manifest {
  etfParquet: {
    file: string;
    bytes: number;
    sha256: string;
    rows: number;
  };
}

function userId() {
  const value = process.env["SUPABASE_USER_ID"] ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("SUPABASE_USER_ID is required");
  return value;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function argValue(args: string[], name: string, fallback: string) {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
}

async function githubOutput(name: string, value: string) {
  const output = process.env["GITHUB_OUTPUT"];
  if (!output) return;
  const prior = await readFile(output, "utf8").catch(() => "");
  await writeFile(output, prior + name + "=" + value + "\n");
}

async function manifest(manifestPath: string) {
  const uid = userId();
  const client = trustedSupabaseClient();
  const storageManifestPath = `${uid}/${V21_DIR}/${COLLECTION_MANIFEST}`;
  const source = await downloadJson<V21Manifest>(client, storageManifestPath);
  const p = source.etfParquet;
  if (!p?.file || !Number.isFinite(p.bytes) || !/^[0-9a-f]{64}$/i.test(p.sha256))
    throw new Error("Invalid v2.1 ETF parquet manifest");
  const value = {
    version: "etf-v21-cache-v1",
    sourcePath: `${uid}/${V21_DIR}/${p.file}`,
    fileName: p.file,
    bytes: p.bytes,
    sha256: p.sha256.toLowerCase(),
    rows: p.rows,
    cacheKey: p.sha256.toLowerCase(),
    cacheFile: p.sha256.toLowerCase() + ".parquet",
  };
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(value, null, 2));
  await githubOutput("cache_key", value.cacheKey);
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

async function materialize(manifestPath: string, cacheDir: string) {
  const m = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version: string; sourcePath: string; bytes: number; sha256: string; cacheFile: string;
  };
  if (m.version !== "etf-v21-cache-v1") throw new Error("Invalid ETF v2.1 cache manifest");
  await mkdir(cacheDir, { recursive: true });
  const target = path.join(cacheDir, m.cacheFile);
  try {
    const local = new Uint8Array(await readFile(target));
    if (local.byteLength === m.bytes && sha256(local) === m.sha256) {
      process.stdout.write(JSON.stringify({ cacheHit: true, downloadedStorageBytes: 0, target }) + "\n");
      return;
    }
  } catch {}
  await rm(target, { force: true });
  const client = trustedSupabaseClient();
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(m.sourcePath);
  if (error || !data) throw new Error(`ETF v2.1 parquet download failed: ${error?.message ?? "unknown"}`);
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength !== m.bytes || sha256(bytes) !== m.sha256)
    throw new Error("ETF v2.1 parquet integrity failure");
  const tmp = target + ".tmp-" + process.pid;
  await writeFile(tmp, bytes);
  await rename(tmp, target);
  process.stdout.write(JSON.stringify({ cacheHit: false, downloadedStorageBytes: bytes.byteLength, target }) + "\n");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const manifestPath = argValue(args, "--manifest", ".cache/cloudtrend-etf-v21-manifest.json");
  const cacheDir = argValue(args, "--cache-dir", ".cache/cloudtrend-etf-v21");
  if (command === "manifest") await manifest(manifestPath);
  else if (command === "materialize") await materialize(manifestPath, cacheDir);
  else throw new Error("Usage: etf-v21-cache.ts <manifest|materialize>");
}

main().catch((e) => {
  process.stderr.write((e instanceof Error ? e.stack ?? e.message : String(e)) + "\n");
  process.exitCode = 1;
});
