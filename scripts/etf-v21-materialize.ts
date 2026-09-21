import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ANALYSIS_BUCKET, downloadJson, trustedSupabaseClient } from "./analysis-run-store";

interface EtfV21Manifest {
  version: string;
  runId: string;
  rowCount: number;
  symbolCount: number;
  etfSymbolCount: number;
  missingSymbolCount: number;
  missingSymbols: string[];
  etfParquet: {
    file: string;
    bytes: number;
    sha256: string;
    rows: number;
  };
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function argValue(args: string[], name: string, fallback: string) {
  const idx = args.indexOf(name);
  return idx >= 0 ? (args[idx + 1] ?? fallback) : fallback;
}

function userId() {
  const value = process.env["SUPABASE_USER_ID"] ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("SUPABASE_USER_ID is required");
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const output = argValue(args, "--output", ".cache/etf-v21/source.parquet");
  const manifestOutput = argValue(args, "--manifest-output", ".cache/etf-v21/manifest.json");
  const uid = userId();
  const root = `${uid}/source/etf-backtest-canonical/v2.1`;
  const client = trustedSupabaseClient();

  const { data: manifestFiles, error: listError } = await client.storage
    .from(ANALYSIS_BUCKET)
    .list(root, { limit: 100, sortBy: { column: "name", order: "asc" } });
  if (listError) throw new Error(`ETF v2.1 manifest listing failed: ${listError.message}`);

  const manifestName = manifestFiles
    .map((item) => item.name)
    .filter((name) => /^collection_manifest_v2\.1_.*\.json$/i.test(name))
    .sort()
    .at(-1);
  if (!manifestName) throw new Error("ETF v2.1 collection manifest not found");

  const manifestPath = `${root}/${manifestName}`;
  const manifest = await downloadJson<EtfV21Manifest>(client, manifestPath);
  if (manifest.version !== "cloudtrend-collector-v2.1")
    throw new Error(`Unexpected ETF collector version: ${manifest.version}`);
  if (!(manifest.etfSymbolCount > 0) || !(manifest.etfParquet?.rows > 0))
    throw new Error("ETF v2.1 manifest has no usable ETF parquet metadata");

  const parquetPath = `${root}/${manifest.etfParquet.file}`;
  const { data, error } = await client.storage.from(ANALYSIS_BUCKET).download(parquetPath);
  if (error || !data) throw new Error(`ETF v2.1 parquet download failed: ${error?.message ?? "unknown"}`);
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength !== manifest.etfParquet.bytes)
    throw new Error(
      `ETF v2.1 parquet size mismatch: expected ${manifest.etfParquet.bytes}, got ${bytes.byteLength}`,
    );
  const actualHash = sha256(bytes);
  if (actualHash !== manifest.etfParquet.sha256)
    throw new Error(
      `ETF v2.1 parquet hash mismatch: expected ${manifest.etfParquet.sha256}, got ${actualHash}`,
    );

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, bytes);
  await mkdir(path.dirname(manifestOutput), { recursive: true });
  await writeFile(manifestOutput, JSON.stringify(manifest, null, 2), "utf8");

  process.stdout.write(
    JSON.stringify(
      {
        manifestPath: manifestPath.replace(uid, "<user>"),
        parquetPath: parquetPath.replace(uid, "<user>"),
        parquetBytes: bytes.byteLength,
        parquetSha256: actualHash,
        rows: manifest.etfParquet.rows,
        etfSymbolCount: manifest.etfSymbolCount,
        missingSymbolCount: manifest.missingSymbolCount,
        runId: manifest.runId,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
