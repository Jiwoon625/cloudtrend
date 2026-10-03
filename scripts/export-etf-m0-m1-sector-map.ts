import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { resolveSectorCode } from "../src/lib/engine/sectors";

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
interface EtfSymbol { symbol: string; name: string }

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("euc-kr").decode(bytes); }
}

async function main() {
  const sourceManifestPath = arg("--source-manifest");
  const sourceCacheDir = arg("--source-cache-dir");
  const etfSymbolsPath = arg("--etf-symbols");
  const output = arg("--output");

  const stockManifest = JSON.parse(await readFile(sourceManifestPath, "utf8")) as CacheManifest;
  const stockTexts: string[] = [];
  for (const file of stockManifest.files) {
    const bytes = new Uint8Array(await readFile(path.join(sourceCacheDir, file.cacheFile)));
    const hash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== file.bytes || hash !== file.fileHash)
      throw new Error("Stock cache integrity failure: " + file.fileName);
    stockTexts.push(decode(bytes));
  }

  const parsed = parseManualMarketData(stockTexts);
  const stockMapping = parsed.dataset.instruments
    .filter((x) => x.instrumentType === "STOCK")
    .map((x) => ({
      symbol: x.symbol, name: x.name, instrumentType: x.instrumentType, market: x.market,
      sectorCode: x.sectorCode, sectorName: x.sectorName,
      isLeveraged: x.isLeveraged, isInverse: x.isInverse, isActive: x.isActive,
    }));

  const etfSymbols = JSON.parse(await readFile(etfSymbolsPath, "utf8")) as EtfSymbol[];
  const etfMapping = etfSymbols.map(({ symbol, name }) => {
    const resolved = resolveSectorCode(symbol, name, true);
    return {
      symbol, name, instrumentType: "ETF" as const, market: "ETF" as const,
      sectorCode: resolved.code, sectorName: resolved.name,
      isLeveraged: /레버리지|2X|3X/i.test(name),
      isInverse: /인버스|숏|SHORT/i.test(name),
      isActive: true,
    };
  });

  const instruments = [...stockMapping, ...etfMapping];
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({
    asOfDate: parsed.dataset.asOfDate,
    stats: { ...parsed.stats, etfs: etfMapping.length, stocks: stockMapping.length },
    warnings: parsed.warnings,
    sectors: parsed.dataset.sectors,
    instruments,
  }, null, 2) + "\n");
  process.stdout.write(JSON.stringify({
    output, instruments: instruments.length, etfs: etfMapping.length,
    stocks: stockMapping.length, asOfDate: parsed.dataset.asOfDate,
  }) + "\n");
}
main().catch((e) => {
  process.stderr.write((e instanceof Error ? e.stack ?? e.message : String(e)) + "\n");
  process.exitCode = 1;
});
