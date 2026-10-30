import { describe, it, expect } from "vitest";
import { input as fixture } from "../kospi-apply-fixture";
import { prepareKospiFinalRetrospective } from "../kospi-final-retrospective-preparation";
import {
  applyPreparedKospiRetrospective,
  type KospiRecoveryPreparationReceipt,
  type KospiRetrospectiveApproval,
} from "../kospi-final-retrospective-apply";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { KOSPI_SHADOW_NAMESPACE, type ShadowObjectStore } from "../../src/lib/kospiShadowStore";
import { KOSPI_SHADOW_CORRECTION_REVISION_ID } from "../../src/lib/kospiShadowSeries";
import {
  assertFinalWorkflow,
  assertFinalExclusiveScope,
  finalExecutionPhase,
} from "./runtime-admission";
// Synthetic26/27 fixture tests only the real legacy callback contract; never operational authority.
const prepared = await prepareKospiFinalRetrospective(fixture);
if (prepared.status !== "PREPARED_FOR_INDEPENDENT_REVIEW")
  throw new Error("Fixture preparation blocked");
const root = `${fixture.authority.owner}/${KOSPI_SHADOW_NAMESPACE}`;
const rev = `${root}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
const descriptor = fixture.objects[rev + "/revision.json"]!.payload as Record<string, unknown>;
const oldApproval = {
  revisionId: descriptor["revisionId"],
  predecessorDate: descriptor["predecessorDate"],
  correctionDate: descriptor["correctionDate"],
  expectedPredecessorHash: descriptor["expectedPredecessorHash"],
  expectedOriginalTargetHash: descriptor["expectedOriginalTargetHash"],
  expectedCorrectedSourceHash: descriptor["correctedSourceHash"],
};
const capturedObjects = [
  ...Object.entries(fixture.objects).map(([path, v]) => ({
    path,
    ...structuredClone(v),
  })),
  {
    path: `${root}/correction-approvals/${KOSPI_SHADOW_CORRECTION_REVISION_ID}.json`,
    hash: await hashSeriesValue(oldApproval),
    payload: oldApproval,
  },
];
const receipt: KospiRecoveryPreparationReceipt = {
  version: "kr-adjusted-recovery-preparation-v1",
  kind: "RECOVERY_PREPARATION_ONLY",
  operationalApproval: false,
  historicalAvailabilityClaim: false,
  kospi: { capturedObjects, result: prepared },
};
const preparationHash = await hashSeriesValue(receipt);
const approval: KospiRetrospectiveApproval = {
  version: "kospi-final-retrospective-approval-v1",
  status: "APPROVED",
  owner: fixture.authority.owner,
  preparationHash,
  planHash: prepared.planHash,
  runtimeCodeHash: fixture.authority.runtimeCodeHash,
  predecessorDate: fixture.authority.predecessorDate,
  targetDates: fixture.authority.targetDates,
  predecessorHash: prepared.plan.predecessorHash,
  snapshotHashes: prepared.plan.snapshotHashes,
  finalProjectionHash: prepared.plan.finalProjectionHash,
};
const approvalHash = await hashSeriesValue(approval);
const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW: "KR final retrospective reviewed PLAN APPLY",
  RECOVERY_CONCURRENCY_GROUP: "kospi-prospective-shadow",
  GITHUB_SHA: "a".repeat(40),
};
describe("final runtime admission and real legacy helper", () => {
  it("rejects incorrect workflow, branch, event, concurrency and commit", () => {
    assertFinalWorkflow(env);
    for (const key of Object.keys(env))
      expect(() => assertFinalWorkflow({ ...env, [key]: "wrong" })).toThrow();
  });
  it("admits only explicit validation or application phases", () => {
    expect(finalExecutionPhase({ ...env, RECOVERY_PHASE: "VALIDATE" })).toBe("VALIDATE");
    expect(finalExecutionPhase({ ...env, RECOVERY_PHASE: "APPLY" })).toBe("APPLY");
    for (const phase of [undefined, "", "PLAN", "apply"])
      expect(() => finalExecutionPhase({ ...env, RECOVERY_PHASE: phase })).toThrow();
  });
  it("rejects bare namespace, wrong owner and wrong group", () => {
    const scope = {
      owner: fixture.authority.owner,
      namespace: rev,
      requiredConcurrencyGroup: "kospi-prospective-shadow",
    };
    assertFinalExclusiveScope(scope, fixture.authority.owner, env);
    for (const patch of [
      { owner: "foreign" },
      { namespace: KOSPI_SHADOW_NAMESPACE },
      { namespace: root },
      { requiredConcurrencyGroup: "other" },
    ])
      expect(() =>
        assertFinalExclusiveScope({ ...scope, ...patch }, fixture.authority.owner, env),
      ).toThrow();
  });
  it("accepts the full revision scope emitted by the actual apply helper", async () => {
    const values = new Map(capturedObjects.map((x) => [x.path, structuredClone(x.payload)]));
    const writes: string[] = [];
    const scopes: string[] = [];
    const store: ShadowObjectStore = {
      read: async <T>(p: string) => structuredClone(values.get(p) ?? null) as T | null,
      latestSessionDate: async (p) =>
        [...values.keys()]
          .filter((k) => k.startsWith(p + "/"))
          .map((k) => k.slice(p.length + 1))
          .filter((k) => /^\d{4}-\d{2}-\d{2}\.json$/.test(k))
          .sort()
          .at(-1)
          ?.slice(0, -5) ?? null,
      putImmutable: async (p, v) => {
        expect(values.has(p)).toBe(false);
        values.set(p, structuredClone(v));
        writes.push(p);
      },
      putLatest: async (p, v) => {
        values.set(p, structuredClone(v));
        writes.push(p);
      },
    };
    await applyPreparedKospiRetrospective({
      store,
      preparationReceipt: receipt,
      approval,
      authoritativePreparationHash: preparationHash,
      authoritativeApprovalHash: approvalHash,
      approvedRuntimeCodeHash: fixture.authority.runtimeCodeHash,
      assertExclusiveWriter: async (scope) => {
        assertFinalExclusiveScope(scope, fixture.authority.owner, env);
        scopes.push(scope.namespace);
      },
    });
    expect(scopes.length).toBeGreaterThan(0);
    expect(new Set(scopes)).toEqual(new Set([rev]));
    expect(writes.filter((p) => p.includes("/sessions/"))).toHaveLength(2);
    expect(values.get(rev + "/latest.json")).toEqual(prepared.finalProjection);
  });
});
