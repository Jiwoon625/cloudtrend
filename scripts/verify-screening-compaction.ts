import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { stableValueHash } from "./screening-compaction-core";
import { withOnsetProfiles } from "../src/lib/onsetProfile";

// Separate process keeps baseline/candidate analysis heaps from overlapping.
const manifestPath = process.argv[2];
const resultPath = process.argv[3];
if (!manifestPath || !resultPath)
  throw new Error("Usage: verify-screening-compaction <input-manifest.json> <result.json>");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { canonicalFiles: string[] };
if (!Array.isArray(manifest.canonicalFiles) || !manifest.canonicalFiles.length)
  throw new Error("No compaction verification inputs");
const texts: string[] = [];
for (const file of manifest.canonicalFiles)
  texts.push(await readFile(path.resolve(path.dirname(manifestPath), file), "utf8"));
const parsed = parseManualMarketData(texts);
texts.length = 0;
const datasetDigest = stableValueHash(parsed.dataset);
const { analysis: engineAnalysis, dataset } = runFullMarketAnalysis(
  parsed.dataset,
  DEFAULT_SCORING_CONFIG,
);
const analysis = withOnsetProfiles(engineAnalysis, dataset, DEFAULT_SCORING_CONFIG);
await writeFile(
  resultPath,
  JSON.stringify(
    {
      datasetDigest,
      sectorDatasetDigest: stableValueHash(dataset),
      analysisDigest: stableValueHash({ ...analysis, calculatedAt: "" }),
      configHash: stableValueHash(DEFAULT_SCORING_CONFIG),
      stats: parsed.stats,
      asOfDate: parsed.dataset.asOfDate,
    },
    null,
    2,
  ) + "\n",
);
