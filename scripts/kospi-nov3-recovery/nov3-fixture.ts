/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic immutable lineage */

import { createNovemberFixture } from "./fixture";
import { prepareNovemberRecovery } from "../kospi-november-recovery/core";
import { novemberApprovalCandidate } from "../kospi-november-recovery/apply";
import { prepareNov3Recovery, type Nov3RecoveryInput } from "./core";
import { captureCanonicalProof } from "../kr-final-retrospective/capture-codec";
const H = (x: unknown) => captureCanonicalProof(x).hash;

export async function createNov3Fixture() {
  const priorInput = await createNovemberFixture();
  const result = await prepareNovemberRecovery(priorInput);
  if (result.status !== "PROVEN_NOVEMBER_RETROSPECTIVE_CONTINUATION") throw Error("PRIOR_BLOCKED");
  const receipt = {
    version: "kospi-november-recovery-preparation-v1",
    kind: "RECOVERY_PREPARATION_ONLY",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    input: priorInput,
    result,
  };
  const approval = await novemberApprovalCandidate(H(receipt), result, {
    codeCommit: "a".repeat(40),
    runtimeHash: H("writer"),
  });
  const completion = {
    version: "kospi-november-recovery-execution-v1",
    owner: approval.owner,
    preparationHash: H(receipt),
    approvalHash: H(approval),
    historicalAvailabilityClaim: false,
    completedAt: "2026-11-03T11:16:45Z",
    result: {
      version: "kospi-november-recovery-completion-v1",
      status: "VERIFIED",
      preparationHash: H(receipt),
      approvalHash: H(approval),
      inputHash: result.inputHash,
      planHash: result.planHash,
      completedDates: ["2026-10-30", "2026-11-02"],
      finalProjectionHash: result.plan.finalProjectionHash,
      writerCodeCommit: approval.writerCodeCommit,
      writerRuntimeHash: approval.writerRuntimeHash,
      originalPrefixUnchanged: true,
      actualLedgerWrites: 0,
      historicalAvailabilityClaim: false,
    },
  };
  const root = `${approval.owner}/shadow/kospi-confirm1-bear-rsaccel-v1/revisions/october14-retrospective-v1`;
  const objects = new Map(
    priorInput.capturedObjects.map((x) => [x.path, structuredClone(x.payload)]),
  );
  for (const snapshot of result.snapshots)
    objects.set(`${root}/sessions/${snapshot.source.date}.json`, snapshot);
  objects.set(`${root}/latest.json`, result.finalProjection);
  const capturedObjects = [...objects].map(([path, payload]) => ({
    path,
    payload,
    hash: H(payload),
  }));
  const authority = {
    ...priorInput.authority,
    predecessorDate: "2026-11-02",
    targetDates: ["2026-11-03"],
    baselineCollectedAt: "2026-11-04T01:59:27Z",
    adjustedCapturedAt: "2026-11-04T03:45:00Z",
    computedAt: "2026-11-04T03:46:00Z",
    baselineSourceHash: H("nov3 sources"),
    adjustedBasisHash: H("nov3 basis"),
  };
  const baselineSession: any = structuredClone(result.plan.sessions[1]);
  delete baselineSession.lateRecovery;
  Object.assign(baselineSession, {
    sourceHash: authority.baselineSourceHash,
    sourceCollectedAt: authority.baselineCollectedAt,
  });
  const adjustedSession = {
    ...structuredClone(baselineSession),
    sourceHash: authority.adjustedBasisHash,
    sourceCollectedAt: authority.adjustedCapturedAt,
  };
  const date = "2026-11-03";
  const target = {
    ...structuredClone(adjustedSession),
    date,
    previousSessionDate: "2026-11-02",
    gate: { ...adjustedSession.gate, date },
    rows: adjustedSession.rows.map((x: any) => ({ ...x, date })),
    lateRecovery: {
      version: "kospi-final-retrospective-v1",
      historicalAvailabilityClaim: false,
      retrospective: true,
      sourceDataAsOf: date,
      sourceCollectedAt: authority.baselineCollectedAt,
      captureObservedAt: authority.adjustedCapturedAt,
      computedAt: authority.computedAt,
      sourceManifestHash: authority.sourceManifestHash,
      captureManifestHash: authority.captureManifestHash,
      adjustedBasisHash: authority.adjustedBasisHash,
      runtimeCodeHash: authority.runtimeCodeHash,
      predecessorDate: authority.predecessorDate,
      predecessorHash: H(result.snapshots[1]),
    },
  };
  return {
    authority,
    baselineSession,
    adjustedSession,
    targetSessions: [target],
    capturedObjects,
    generationPins: capturedObjects.map((x, i) => ({
      path: x.path,
      hash: x.hash,
      generation: {
        id: `id${i}`,
        version: `v${i}`,
        eTag: `e${i}`,
        size: 100,
        updatedAt: authority.adjustedCapturedAt,
      },
    })),
    priorRecovery: {
      plan: { hash: H(receipt), payload: receipt },
      approval: { hash: H(approval), payload: approval },
      completion: { hash: H(completion), payload: completion },
    },
  };
}
