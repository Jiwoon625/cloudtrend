/** Separate pure repeated-retrospective adapter; frozen preparation/ordinary guard untouched. */
import { buildKospiShadowSession } from "../../src/lib/engine/kospiShadowDataset";
import type { KospiShadowSession } from "../../src/lib/engine/kospiShadow";
import type { FinalCaptureV1, FinalPriorRecoveryLineage } from "./contracts";
import type { KospiFinalPreparationAuthority } from "../kospi-final-retrospective-preparation";
import { KOSPI_SHADOW_NAMESPACE, type KospiShadowView } from "../../src/lib/kospiShadowStore";
import { KOSPI_SHADOW_CORRECTION_REVISION_ID } from "../../src/lib/kospiShadowSeries";
import {
  proveRepeatedRetrospectiveBoundary,
  type RepeatedGenerationPin,
  type RepeatedPredecessorInput,
} from "./repeated-predecessor";

export async function prepareRepeatedRetrospective(
  c: FinalCaptureV1,
  authority: KospiFinalPreparationAuthority,
  targetSessions: KospiShadowSession[],
) {
  const manifest = c.captureManifest as {
    priorRecovery: FinalPriorRecoveryLineage;
    legacy: RepeatedGenerationPin[];
  };
  const root = `${c.owner}/${KOSPI_SHADOW_NAMESPACE}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
  const view = c.legacyObjects[root + "/latest.json"]?.payload as KospiShadowView;
  const build = (adjusted: boolean) =>
    buildKospiShadowSession(
      c.dataset,
      c.config,
      {
        sourceHash: adjusted ? authority.adjustedBasisHash : authority.baselineSourceHash,
        configHash: view.registry.configHash,
        codeVersion: authority.codeVersion,
        sourceCollectedAt: adjusted ? authority.adjustedCapturedAt : authority.baselineCollectedAt,
        now: authority.computedAt,
      },
      authority.predecessorDate,
    );
  const input: RepeatedPredecessorInput = {
    authority,
    priorRecovery: manifest.priorRecovery,
    capturedObjects: Object.entries(c.legacyObjects).map(([path, x]) => ({ path, ...x })),
    generationPins: manifest.legacy,
    baselineSession: build(false),
    adjustedSession: build(true),
    targetSessions,
  };
  return { input, result: await proveRepeatedRetrospectiveBoundary(input) };
}
