import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";

interface CacheManifestFile {
  fileName: string;
  bytes: number;
  fileHash: string;
  cacheFile: string;
}
interface CacheManifest {
  schemaVersion: 1;
  sourceType: "backtest";
  files: CacheManifestFile[];
}
interface EtfCacheManifest {
  version: "etf-backtest-cache-v1";
  cacheKey: string;
  logicalFileHash: string;
  logicalSizeBytes: number;
  cacheFile: string;
  sourceFilename: string;
}

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

async function main() {
  const sourceManifestPath = arg("--source-manifest");
  const sourceCacheDir = arg("--source-cache-dir");
  const etfManifestPath = arg("--etf-source-manifest");
  const etfCacheDir = arg("--etf-source-cache-dir");
  const output = arg("--output");

  const stockManifest = JSON.parse(await readFile(sourceManifestPath, "utf8")) as CacheManifest;
  if (stockManifest.schemaVersion !== 1 || stockManifest.sourceType !== "backtest")
    throw new Error("Unsupported stock manifest");
  const stockTexts: string[] = [];
  for (const file of stockManifest.files) {
    const bytes = new Uint8Array(await readFile(path.join(sourceCacheDir, file.cacheFile)));
    const hash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== file.bytes || hash !== file.fileHash)
      throw new Error("Stock cache integrity failure: " + file.fileName);
    stockTexts.push(decode(bytes));
  }

  const etfManifest = JSON.parse(await readFile(etfManifestPath, "utf8")) as EtfCacheManifest;
  const etfBytes = new Uint8Array(await readFile(path.join(etfCacheDir, etfManifest.cacheFile)));
  const etfHash = "sha256:" + createHash("sha256").update(etfBytes).digest("hex");
  if (
    etfManifest.version !== "etf-backtest-cache-v1" ||
    etfBytes.byteLength !== etfManifest.logicalSizeBytes ||
    etfHash !== etfManifest.logicalFileHash
  )
    throw new Error("ETF cache integrity failure");

  // Canonical ETF text comes first so overlapping ETF rows use the verified canonical copy.
  const parsed = parseManualMarketData([decode(etfBytes), ...stockTexts]);
  const mapping = parsed.dataset.instruments.map((x) => ({
    symbol: x.symbol,
    name: x.name,
    instrumentType: x.instrumentType,
    market: x.market,
    sectorCode: x.sectorCode,
    sectorName: x.sectorName,
    isLeveraged: x.isLeveraged,
    isInverse: x.isInverse,
    isActive: x.isActive,
  }));

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        asOfDate: parsed.dataset.asOfDate,
        stats: parsed.stats,
        warnings: parsed.warnings,
        sectors: parsed.dataset.sectors,
        instruments: mapping,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      output,
      instruments: mapping.length,
      etfs: mapping.filter((x) => x.instrumentType === "ETF").length,
      stocks: mapping.filter((x) => x.instrumentType === "STOCK").length,
      asOfDate: parsed.dataset.asOfDate,
    }) + "\n",
  );
}

main().catch((e) => {
  process.stderr.write((e instanceof Error ? e.stack ?? e.message : String(e)) + "\n");
  process.exitCode = 1;
});
