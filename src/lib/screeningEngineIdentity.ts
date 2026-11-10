import manifest from "./signalEngineManifest.generated.json";

/** Calculation provenance, deliberately separate from source/data identities. */
export interface ScreeningEngineIdentity {
  version: "kr-screening-engine-v1";
  codeHash: string;
}
export const currentScreeningEngineIdentity: ScreeningEngineIdentity = Object.freeze({
  version: "kr-screening-engine-v1",
  codeHash: manifest.codeHash,
});
// Reviewed historical semantic identity, from 897da85e6972c848c24c3d4d1ebf637138c8a751.
const reviewedEngines = new Set([
  manifest.codeHash,
  "0d2307099c51f1d0e3a37773651001fdbb2bd83cefcc45bb279018689e27d09b",
]);
export function assertScreeningEngineIdentity(
  value: unknown,
): asserts value is ScreeningEngineIdentity {
  const v = value as ScreeningEngineIdentity | undefined;
  if (
    !v ||
    v.version !== "kr-screening-engine-v1" ||
    !reviewedEngines.has(v.codeHash) ||
    Object.keys(v).sort().join(",") !== "codeHash,version"
  )
    throw new Error(
      "Missing or unreviewed screening engine identity; recalculate before publication",
    );
}

export interface ScreeningResultIdentity {
  version?: string;
  publicationId?: string | undefined;
  inputFingerprint?: string;
  resultDigest?: string;
  engineIdentity?: ScreeningEngineIdentity;
  asOfDate?: string | undefined;
}

/** A one-way, exact legacy bridge. Absence of identity is never a general escape hatch. */
export function assertScreeningResultTransition(
  previous: ScreeningResultIdentity | null,
  next: ScreeningResultIdentity,
) {
  assertScreeningEngineIdentity(next.engineIdentity);
  if (previous?.engineIdentity !== undefined)
    assertScreeningEngineIdentity(previous.engineIdentity);
  if (
    previous &&
    previous.version === next.version &&
    (!previous.inputFingerprint || !previous.resultDigest)
  )
    throw new Error("Invalid predecessor screening identity");
  if (
    !previous ||
    previous.version !== next.version ||
    previous.inputFingerprint !== next.inputFingerprint ||
    previous.resultDigest === next.resultDigest
  )
    return;
  if (previous.engineIdentity && previous.engineIdentity.codeHash !== next.engineIdentity.codeHash)
    return;
  if (
    previous.engineIdentity === undefined &&
    previous.publicationId === "5f52ffb3-ecd9-420c-a293-bb86cee064d7" &&
    previous.inputFingerprint ===
      "5d36ba2fd0dce10c5f1df5ab118af9badd7b1afae5f8b27b76d04555e1d207f4" &&
    previous.resultDigest === "4b6e1bd68a308b63efacacebdfb963ace16650c6797bcbe1cac08b6dc6d0f12a" &&
    previous.asOfDate === "2026-11-09" &&
    next.asOfDate === "2026-11-09" &&
    next.engineIdentity.codeHash ===
      "729a289cfbb034401aae889cc49bbcd52d7de1ab23e5b165dc65b8053189d083" &&
    next.resultDigest === "ee349d7f807c728e46a58aa48efd3501158843867370e926f36d2fce634fe95a"
  )
    return;
  throw new Error(
    "스크리닝 regression guard 실패: 동일 원천·동일 산식 또는 검증되지 않은 이전 산식의 결과 digest가 변경되었습니다.",
  );
}
