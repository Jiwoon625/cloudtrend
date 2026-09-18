import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildPortfolioSignalContext } from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import { readManifest } from "./backtest-source-cache";

// A batch pins a single manifest; no re-download or re-parse between studies.
const inputs = new Map<
  string,
  Promise<{
    texts: string[];
    manifest: Awaited<ReturnType<typeof readManifest>>;
  }>
>();
const parsed = new WeakMap<string[], ReturnType<typeof parseManualMarketData>>();
const contexts = new WeakMap<
  Parameters<typeof buildPortfolioSignalContext>[0],
  Map<number, ReturnType<typeof buildPortfolioSignalContext>>
>();

export function loadResearchTexts(manifestPath: string, cacheDir: string) {
  const key = JSON.stringify([path.resolve(manifestPath), path.resolve(cacheDir)]);
  let pending = inputs.get(key);
  if (!pending) {
    pending = (async () => {
      const manifest = await readManifest(manifestPath);
      const texts: string[] = [];
      for (const file of manifest.files) {
        if (!/^[0-9a-f]{64}\.source$/.test(file.cacheFile)) throw new Error("Invalid cache path");
        const bytes = await readFile(path.join(cacheDir, file.cacheFile));
        if (
          bytes.byteLength !== file.bytes ||
          `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== file.fileHash
        )
          throw new Error(`Source cache integrity failure: ${file.fileName}`);
        try {
          texts.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          texts.push(new TextDecoder("euc-kr").decode(bytes));
        }
      }
      process.stderr.write(`Batch source read once: ${manifest.fileCount} files\n`);
      return { texts, manifest };
    })();
    inputs.set(key, pending);
    pending.catch(() => inputs.delete(key));
  }
  return pending;
}

export function parseSharedMarketData(texts: string[]) {
  let result = parsed.get(texts);
  if (!result) {
    result = parseManualMarketData(texts);
    parsed.set(texts, result);
    process.stderr.write("Batch dataset parsed once\n");
  }
  return result;
}

export function buildSharedSignalContext(
  dataset: Parameters<typeof buildPortfolioSignalContext>[0],
  limit: number,
) {
  let byLimit = contexts.get(dataset);
  if (!byLimit) {
    byLimit = new Map();
    contexts.set(dataset, byLimit);
  }
  let result = byLimit.get(limit);
  if (!result) {
    result = buildPortfolioSignalContext(dataset, limit);
    byLimit.set(limit, result);
  }
  return result;
}
