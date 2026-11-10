import { shadowEngineManifest } from "./october-shadow-code-manifest";
import { currentScreeningEngineIdentity } from "../src/lib/screeningEngineIdentity";

export const SCREENING_ENGINE_ROOTS = [
  "src/lib/currentScreening.ts",
  "src/lib/engine/manualDataset.ts",
  "src/lib/shadowReplayCalculation.ts",
  "src/lib/screeningPublicationAnalysis.ts",
  "src/lib/screeningSnapshot.ts",
  "src/lib/etfReportScore.ts",
  "src/lib/operationalUnderlyingIndex.ts",
];
/** Fail closed when checked-in metadata does not describe the executable calculation. */
export async function verifiedCalculationEngineIdentity(root = process.cwd()) {
  const actual = await shadowEngineManifest(
    root,
    SCREENING_ENGINE_ROOTS,
    "screening-signal-engine-v1",
  );
  if (actual.codeHash !== `sha256:${currentScreeningEngineIdentity.codeHash}`)
    throw new Error("Stale screening engine manifest; rebuild before calculation/publication");
  return { ...currentScreeningEngineIdentity };
}
