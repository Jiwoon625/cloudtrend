import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { shadowEngineManifest, adoptedShadowFrozenCodeHash } from "./october-shadow-code-manifest";
import { integratedAllocationRuntimeManifest } from "./integrated-allocation-code-manifest";
import { canonicalSeriesJson } from "../src/lib/ledger/modelSeries";
import {
  reviewedIntegratedRuntime,
  INTEGRATED_ALLOCATION_FROZEN_CODE_HASH,
} from "../src/lib/integratedAllocationRuntimeAdmission";

/** Read-only preflight before a CLI can read private inputs or mutate external state.
 * Recompute executable digests from this checkout, not git SHA or stale generated JSON.
 * Build/deploy uses the same guard after generation; no runtime is implicitly admitted.
 */
export async function verifyShadowRuntimeManifests(root = process.cwd()) {
  const [october, integrated] = await Promise.all([
    shadowEngineManifest(root),
    integratedAllocationRuntimeManifest(root),
  ]);
  for (const [file, actual] of [
    ["src/lib/ledger/octoberShadowEngineManifest.generated.json", october],
    ["src/lib/integratedAllocationRuntime.generated.json", integrated],
  ] as const) {
    const saved = JSON.parse(await readFile(path.join(root, file), "utf8"));
    if (canonicalSeriesJson(saved) !== canonicalSeriesJson(actual))
      throw new Error("Stale Shadow executable manifest; reviewed build artifacts are required");
  }
  adoptedShadowFrozenCodeHash(october.codeHash);
  reviewedIntegratedRuntime(integrated.codeHash, INTEGRATED_ALLOCATION_FROZEN_CODE_HASH);
  return {
    octoberRuntimeCodeHash: october.codeHash,
    integratedRuntimeCodeHash: integrated.codeHash,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  verifyShadowRuntimeManifests().catch(() => {
    console.error(
      "Shadow runtime preflight failed; no source or publication actions were performed.",
    );
    process.exitCode = 1;
  });
