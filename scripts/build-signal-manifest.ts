import { writeFile } from "node:fs/promises";
import { shadowEngineManifest } from "./october-shadow-code-manifest";
const kr = await shadowEngineManifest(
  process.cwd(),
  [
    "src/lib/engine/fullMarketAnalysis.ts",
    "src/lib/engine/manualDataset.ts",
    "src/lib/shadowReplayCalculation.ts",
    "src/lib/screeningPublicationAnalysis.ts",
    "src/lib/screeningSnapshot.ts",
    "src/lib/etfReportScore.ts",
    "src/lib/operationalUnderlyingIndex.ts",
  ],
  "screening-signal-engine-v1",
);
const us = await shadowEngineManifest(
  process.cwd(),
  ["src/lib/engine/usProspective.ts"],
  "screening-signal-engine-v1",
);
await writeFile(
  "src/lib/signalEngineManifest.generated.json",
  JSON.stringify(
    {
      version: 1,
      codeHash: kr.codeHash.slice(7),
      usCodeHash: us.codeHash.slice(7),
      KR: kr.manifest,
      US: us.manifest,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Signal engines KR ${kr.codeHash} / US ${us.codeHash}`);
