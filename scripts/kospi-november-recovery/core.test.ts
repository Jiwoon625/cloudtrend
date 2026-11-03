/* eslint-disable @typescript-eslint/no-explicit-any -- synthetic complete immutable evidence fixtures */
import { beforeAll, expect, it } from "vitest";
import { input as oldInput } from "../kospi-apply-fixture";
import { prepareKospiFinalRetrospective } from "../kospi-final-retrospective-preparation";
import { kospiRetrospectiveApprovalCandidate } from "../kospi-final-retrospective-apply";
import {
  KOSPI_SHADOW_NAMESPACE,
  persistKospiShadow,
  type ShadowObjectStore,
} from "../../src/lib/kospiShadowStore";
import {
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
  openKospiShadowRevisionStore,
} from "../../src/lib/kospiShadowSeries";
import { equivalentCompletedKospiShadow } from "../../src/lib/kospiShadowEquivalence";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { preparationSourceId } from "../kr-adjusted-recovery/evidence-storage";
import {
  proveRepeatedRetrospectiveBoundary,
  type RepeatedPredecessorInput,
} from "../kr-final-retrospective/repeated-predecessor";
import {
  applyRepeatedLegacy,
  repeatedLegacyApprovalCandidate,
} from "../kr-final-retrospective/repeated-legacy-apply";
const clone = structuredClone;
const owner = oldInput.authority.owner;
const root = `${owner}/${KOSPI_SHADOW_NAMESPACE}`;
const revision = `${root}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
const h = (name: string) => hashSeriesValue({ synthetic: name });

async function syntheticFixture(
  options: {
    priorRuntime?: string;
    inconsistentRuntime?: boolean;
    damageReplay?: boolean;
    economicPriority?: boolean;
  } = {},
): Promise<RepeatedPredecessorInput> {
  const previousInput = clone(oldInput);
  if (options.priorRuntime) previousInput.authority.runtimeCodeHash = options.priorRuntime;
  const old = await prepareKospiFinalRetrospective(previousInput);
  if (old.status !== "PREPARED_FOR_INDEPENDENT_REVIEW") throw Error("SYNTHETIC_OLD_BLOCKED");
  if (options.economicPriority) {
    const map = new Map(
      Object.entries(previousInput.objects).map(([p, v]) => [p, clone(v.payload)]),
    );
    const previous: any = map.get(revision + "/sessions/2026-10-23.json");
    const symbol = Object.values(previous.state.previousRows).find(
      (r: any) => r.score !== null && r.score < 8,
    ) as any;
    if (!symbol) throw Error("NO_SYNTHETIC_ONSET_ROW");
    const store: ShadowObjectStore = {
      read: async <T>(p: string) => clone(map.get(p) ?? null) as T | null,
      latestSessionDate: async (p) =>
        [...map.keys()]
          .filter((k) => k.startsWith(p + "/"))
          .map((k) => k.slice(p.length + 1))
          .filter((k) => /^\d{4}-\d{2}-\d{2}\.json$/.test(k))
          .sort()
          .at(-1)
          ?.slice(0, -5) ?? null,
      putImmutable: async (p, v) => {
        if (map.has(p)) throw Error("SYNTHETIC_COLLISION");
        map.set(p, clone(v));
      },
      putLatest: async (p, v) => {
        map.set(p, clone(v));
      },
    };
    const adapter = await openKospiShadowRevisionStore(store, owner);
    for (const [i, session] of old.plan.sessions.entries()) {
      const row = session.rows.find((r) => r.symbol === symbol.symbol)!;
      Object.assign(row, {
        score: 8.5,
        commonHistory: true,
        onsetEligible: true,
        universeDataPending: false,
        rsAccel: 1,
      });
      session.gate.status = "RISK_ON";
      const result = await persistKospiShadow(
        adapter,
        owner,
        session,
        old.finalProjection.registry.config,
      );
      old.snapshots[i] = clone(result.view.latest);
      old.finalProjection = clone(result.view);
    }
    old.targetSessions = clone(old.plan.sessions);
    old.plan.snapshotHashes = await Promise.all(old.snapshots.map(hashSeriesValue));
    old.plan.finalProjectionHash = await hashSeriesValue(old.finalProjection);
    old.planHash = await hashSeriesValue(old.plan);
  }
  if (options.damageReplay) {
    old.snapshots[1]!.state.cashKrw += 1;
    old.finalProjection.latest = clone(old.snapshots[1]!);
    old.plan.snapshotHashes[1] = await hashSeriesValue(old.snapshots[1]);
    old.plan.finalProjectionHash = await hashSeriesValue(old.finalProjection);
    old.planHash = await hashSeriesValue(old.plan);
  }
  const descriptor: any = oldInput.objects[revision + "/revision.json"]!.payload;
  const originalApproval = {
    revisionId: descriptor.revisionId,
    predecessorDate: descriptor.predecessorDate,
    correctionDate: descriptor.correctionDate,
    expectedPredecessorHash: descriptor.expectedPredecessorHash,
    expectedOriginalTargetHash: descriptor.expectedOriginalTargetHash,
    expectedCorrectedSourceHash: descriptor.correctedSourceHash,
  };
  const values = new Map(Object.entries(oldInput.objects).map(([p, v]) => [p, clone(v.payload)]));
  for (const snapshot of old.snapshots)
    values.set(`${revision}/sessions/${snapshot.source.date}.json`, clone(snapshot));
  values.set(revision + "/latest.json", clone(old.finalProjection));
  values.set(
    `${root}/correction-approvals/${KOSPI_SHADOW_CORRECTION_REVISION_ID}.json`,
    originalApproval,
  );
  const capturedObjects = await Promise.all(
    [...values].map(async ([path, payload]) => ({
      path,
      payload,
      hash: await hashSeriesValue(payload),
    })),
  );
  const prep = {
    version: "kr-adjusted-recovery-preparation-v1",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    planHash: await h("prior operation plan"),
    kospi: {
      result: old,
      capturedObjects: [
        ...Object.entries(previousInput.objects).map(([path, v]) => ({ path, ...clone(v) })),
        {
          path: `${root}/correction-approvals/${KOSPI_SHADOW_CORRECTION_REVISION_ID}.json`,
          hash: await hashSeriesValue(originalApproval),
          payload: clone(originalApproval),
        },
      ],
    },
  };
  const prepHash = await hashSeriesValue(prep);
  const k = kospiRetrospectiveApprovalCandidate(prepHash, old);
  const full = {
    version: "kr-adjusted-recovery-full-plan-v1",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    preparationHash: prepHash,
    operationManifestHash: await h("prior operation manifest"),
    executionProvenance: { synthetic: true },
    kospiApprovalCandidate: k,
    runtimeHashes: {
      kospi: options.inconsistentRuntime
        ? await h("inconsistent prior runtime")
        : previousInput.authority.runtimeCodeHash,
    },
  };
  const fullHash = await hashSeriesValue(full);
  const approval = {
    version: "kr-adjusted-recovery-apply-approval-v1",
    status: "APPROVED",
    owner,
    preparationHash: prepHash,
    fullPlanHash: fullHash,
    operationManifestHash: full.operationManifestHash,
    executionProvenanceHash: await hashSeriesValue(full.executionProvenance),
    kospiApprovalHash: await hashSeriesValue(k),
    runtimeHashes: full.runtimeHashes,
  };
  const approvalHash = await hashSeriesValue(approval);
  const terminal = {
    version: "kr-adjusted-recovery-model-stage-receipt-v1",
    approvalHash,
    fullPlanHash: fullHash,
    operationManifestHash: full.operationManifestHash,
    legacyTargetDate: "2026-10-27",
    actualLedgersUnchanged: true,
    historicalAvailabilityClaim: false,
  };
  const terminalHash = await hashSeriesValue(terminal);
  const evidence = async (payload: any, sourceId: string) => ({
    sourceId,
    sourceRevision: "1" as const,
    userId: owner,
    storageHash: await hashSeriesValue(payload),
    logicalHash: await hashSeriesValue(payload),
    rowHash: await h("synthetic immutable row " + sourceId),
    payload,
  });
  const priorRecovery = {
    version: "kr-final-prior-recovery-lineage-v1" as const,
    preparation: await evidence(prep, preparationSourceId(prep.planHash, prepHash)),
    fullPlan: await evidence(
      full,
      "kr-adjusted-recovery-full-plan:" + full.operationManifestHash.slice(7),
    ),
    approval: await evidence(approval, "kr-adjusted-recovery-apply-approval:" + fullHash.slice(7)),
    terminal: await evidence(terminal, "kr-adjusted-recovery-model-stage:" + terminalHash.slice(7)),
  };
  const authority = {
    ...clone(oldInput.authority),
    predecessorDate: "2026-10-27",
    targetDates: ["2026-10-28", "2026-10-29"],
    baselineSourceHash: await h("current baseline"),
    adjustedBasisHash: await h("current adjusted"),
    baselineCollectedAt: "2026-10-30T00:00:00Z",
    adjustedCapturedAt: "2026-10-30T01:00:00Z",
    computedAt: "2026-10-30T02:00:00Z",
  };
  const baselineSession: any = clone(old.plan.sessions[1]);
  delete baselineSession.lateRecovery;
  Object.assign(baselineSession, {
    sourceHash: authority.baselineSourceHash,
    sourceCollectedAt: authority.baselineCollectedAt,
    codeVersion: authority.codeVersion,
  });
  const adjustedSession = {
    ...clone(baselineSession),
    sourceHash: authority.adjustedBasisHash,
    sourceCollectedAt: authority.adjustedCapturedAt,
  };
  const predecessorHash = await hashSeriesValue(old.snapshots[1]);
  const targetSessions = authority.targetDates.map((date, i) => ({
    ...clone(adjustedSession),
    date,
    previousSessionDate: i ? authority.targetDates[i - 1] : authority.predecessorDate,
    gate: { ...clone(adjustedSession.gate), date },
    rows: adjustedSession.rows.map((row: any) => ({ ...clone(row), date })),
    lateRecovery: {
      version: "kospi-final-retrospective-v1",
      historicalAvailabilityClaim: false,
      retrospective: true,
      sourceDataAsOf: "2026-10-29",
      sourceCollectedAt: authority.baselineCollectedAt,
      captureObservedAt: authority.adjustedCapturedAt,
      computedAt: authority.computedAt,
      sourceManifestHash: authority.sourceManifestHash,
      captureManifestHash: authority.captureManifestHash,
      adjustedBasisHash: authority.adjustedBasisHash,
      runtimeCodeHash: authority.runtimeCodeHash,
      predecessorDate: authority.predecessorDate,
      predecessorHash,
    },
  }));
  return {
    authority,
    priorRecovery,
    capturedObjects,
    baselineSession,
    adjustedSession,
    targetSessions,
    generationPins: capturedObjects.map((x, i) => ({
      path: x.path,
      hash: x.hash,
      generation: {
        id: "synthetic-id-" + i,
        version: "synthetic-version-" + i,
        eTag: "synthetic-tag-" + i,
        size: 100,
        updatedAt: "2026-10-29T21:00:00Z",
      },
    })),
  };
}

import {
  prepareNovemberRecovery,
  verifyNovemberPriorLineage,
  type NovemberRecoveryInput,
} from "./core";
import runtime from "../../src/lib/kospiShadowPublicationRuntime.generated.json";
let input: NovemberRecoveryInput;
async function fixture(): Promise<NovemberRecoveryInput> {
  const oldInput = await syntheticFixture();
  const r = await proveRepeatedRetrospectiveBoundary(oldInput);
  if (r.status !== "PROVEN_REPEATED_RETROSPECTIVE_CONTINUATION")
    throw Error("SYNTHETIC_PRIOR_BLOCKED");
  const receipt = {
    version: "kr-repeated-retrospective-preparation-v1",
    kind: "RECOVERY_PREPARATION_ONLY",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    kospi: {
      capturedObjects: clone(oldInput.capturedObjects),
      repeatedProofInput: clone(oldInput),
      result: r,
    },
  };
  const receiptHash = await hashSeriesValue(receipt);
  const k = await repeatedLegacyApprovalCandidate(receiptHash, r);
  const preparation = {
    owner,
    codeCommit: oldInput.authority.codeVersion,
    captureHash: await h("capture28-29"),
    runtimeHashes: { kospi: oldInput.authority.runtimeCodeHash },
    scope: { dates: ["2026-10-28", "2026-10-29"], predecessorDate: "2026-10-27" },
  };
  const p = {
    version: "kr-final-retrospective-plan-v1",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    actualMutation: false,
    sourceRegistryMutation: false,
    integratedMutation: false,
    expectedNewLegacySessions: 2,
    expectedNewModelSessions: 10,
    captureHash: preparation.captureHash,
    preparation,
    preparationHash: await hashSeriesValue(preparation),
    legacyReceipt: receipt,
    legacyReceiptHash: receiptHash,
    legacyApprovalCandidate: k,
    legacyApprovalHash: await hashSeriesValue(k),
  };
  const ph = await hashSeriesValue(p);
  const a = {
    version: "kr-final-retrospective-approval-v1",
    status: "APPROVED",
    owner,
    planHash: ph,
    captureHash: p.captureHash,
    codeCommit: preparation.codeCommit,
    runtimeHashes: preparation.runtimeHashes,
    legacyApprovalHash: p.legacyApprovalHash,
    historicalAvailabilityClaim: false,
  };
  const ah = await hashSeriesValue(a);
  const t = {
    version: "kr-final-retrospective-completion-v1",
    owner,
    planHash: ph,
    approvalHash: ah,
    historicalAvailabilityClaim: false,
    result: {
      status: "APPLIED",
      legacy: {
        version: "kr-repeated-legacy-apply-result-v1",
        status: "VERIFIED",
        approvalHash: p.legacyApprovalHash,
        planHash: r.planHash,
        preparationHash: receiptHash,
        completedDates: ["2026-10-28", "2026-10-29"],
        finalProjectionHash: r.plan.finalProjectionHash,
        actualLedgerWrites: 0,
        originalPrefixUnchanged: true,
        historicalAvailabilityClaim: false,
      },
    },
  };
  const objects = new Map(oldInput.capturedObjects.map((x) => [x.path, clone(x.payload)]));
  r.snapshots.forEach((x) => objects.set(`${revision}/sessions/${x.source.date}.json`, clone(x)));
  objects.set(revision + "/latest.json", clone(r.finalProjection));
  const capturedObjects = await Promise.all(
    [...objects].map(async ([path, payload]) => ({
      path,
      payload,
      hash: await hashSeriesValue(payload),
    })),
  );
  const authority = {
    ...clone(oldInput.authority),
    predecessorDate: "2026-10-29",
    targetDates: ["2026-10-30", "2026-11-02"],
    runtimeCodeHash: runtime.codeHash,
    baselineCollectedAt: "2026-11-03T01:05:34.360Z",
    adjustedCapturedAt: "2026-11-03T02:15:00Z",
    computedAt: "2026-11-03T02:16:00Z",
    baselineSourceHash: await h("November source"),
    adjustedBasisHash: await h("November basis"),
  };
  const baselineSession: any = clone(r.plan.sessions[1]);
  delete baselineSession.lateRecovery;
  Object.assign(baselineSession, {
    sourceHash: authority.baselineSourceHash,
    sourceCollectedAt: authority.baselineCollectedAt,
    codeVersion: authority.codeVersion,
  });
  const adjustedSession = {
    ...clone(baselineSession),
    sourceHash: authority.adjustedBasisHash,
    sourceCollectedAt: authority.adjustedCapturedAt,
  };
  const predecessorHash = await hashSeriesValue(r.snapshots[1]);
  const targetSessions = authority.targetDates.map((date, i) => ({
    ...clone(adjustedSession),
    date,
    previousSessionDate: i ? authority.targetDates[i - 1] : authority.predecessorDate,
    gate: { ...clone(adjustedSession.gate), date },
    rows: adjustedSession.rows.map((x: any) => ({ ...clone(x), date })),
    lateRecovery: {
      version: "kospi-final-retrospective-v1",
      historicalAvailabilityClaim: false,
      retrospective: true,
      sourceDataAsOf: "2026-11-02",
      sourceCollectedAt: authority.baselineCollectedAt,
      captureObservedAt: authority.adjustedCapturedAt,
      computedAt: authority.computedAt,
      sourceManifestHash: authority.sourceManifestHash,
      captureManifestHash: authority.captureManifestHash,
      adjustedBasisHash: authority.adjustedBasisHash,
      runtimeCodeHash: authority.runtimeCodeHash,
      predecessorDate: authority.predecessorDate,
      predecessorHash,
    },
  }));
  return {
    authority,
    priorRecovery: {
      plan: { hash: ph, payload: p },
      approval: { hash: ah, payload: a },
      completion: { hash: await hashSeriesValue(t), payload: t },
    },
    capturedObjects,
    generationPins: capturedObjects.map((x, i) => ({
      path: x.path,
      hash: x.hash,
      generation: {
        id: `synthetic-${i}`,
        version: `version-${i}`,
        eTag: `tag-${i}`,
        size: 100,
        updatedAt: "2026-11-03T02:15:00Z",
      },
    })),
    baselineSession,
    adjustedSession,
    targetSessions,
  };
}
beforeAll(async () => {
  input = await fixture();
}, 60000);
it("prepares only Oct30 and Nov2 while preserving tagged29 and all input bytes", async () => {
  const before = clone(input),
    r = await prepareNovemberRecovery(input);
  expect(r.status, JSON.stringify(r)).toBe("PROVEN_NOVEMBER_RETROSPECTIVE_CONTINUATION");
  expect(input).toEqual(before);
  expect(r.operationalApproval).toBe(false);
  if (r.status !== "PROVEN_NOVEMBER_RETROSPECTIVE_CONTINUATION") return;
  expect(r.snapshots.map((x) => x.source.date)).toEqual(["2026-10-30", "2026-11-02"]);
  expect(r.plan.writeSet).toHaveLength(4);
  expect(r.actualPredecessorTagPreserved).toBe(true);
  expect(r.checks.originalFullReplay).toBe(true);
  expect((await prepareNovemberRecovery(input)).planHash).toBe(r.planHash);
});
it.each([
  "skip30",
  "unknownDate",
  "clock",
  "runtime",
  "hash",
  "owner",
  "approval",
  "completion",
  "price",
  "benchmark",
  "config",
  "orphan",
  "warmup",
  "provenance",
])("rejects %s without any approvable plan", async (kind) => {
  const x: any = clone(input);
  if (kind === "skip30") x.authority.targetDates = ["2026-11-02"];
  if (kind === "unknownDate") x.authority.targetDates[1] = "2026-11-03";
  if (kind === "clock") x.authority.computedAt = "2026-11-02T00:00:00Z";
  if (kind === "runtime") x.authority.runtimeCodeHash = await h("wrong runtime");
  if (kind === "hash") x.capturedObjects[0].hash = await h("wrong object");
  if (kind === "owner") x.authority.owner = "00000000-0000-0000-0000-000000000002";
  if (kind === "approval") x.priorRecovery.approval.payload.status = "PENDING";
  if (kind === "completion") x.priorRecovery.completion.payload.result.status = "WAITING";
  if (kind === "price") x.adjustedSession.rows[0].close += 1;
  if (kind === "benchmark") x.adjustedSession.benchmarkClose += 1;
  if (kind === "config") x.targetSessions[0].configHash = await h("different config");
  if (kind === "orphan") {
    const z = clone(x.capturedObjects.at(-1));
    z.path = revision + "/sessions/2026-11-03.json";
    x.capturedObjects.push(z);
    x.generationPins.push({ ...clone(x.generationPins.at(-1)), path: z.path });
  }
  if (kind === "warmup") x.targetSessions[0].warmupRows = [];
  if (kind === "provenance") x.targetSessions[0].lateRecovery.historicalAvailabilityClaim = true;
  const r = await prepareNovemberRecovery(x);
  expect(r.status).toBe("BLOCKED_NOVEMBER_RETROSPECTIVE_BOUNDARY");
  expect(r.plan).toBeNull();
});
it("does not make ordinary completed guard accept the historical29 tag", () => {
  const actual29: any = input.capturedObjects.find(
    (x) => x.path === revision + "/sessions/2026-10-29.json",
  )!.payload;
  const actual28: any = input.capturedObjects.find(
    (x) => x.path === revision + "/sessions/2026-10-28.json",
  )!.payload;
  expect(
    equivalentCompletedKospiShadow(
      input.baselineSession,
      actual29,
      actual28,
      actual29.state.initializedDate,
    ),
  ).toBe(false);
});
it("rejects forged prior hash even if an unrelated field is changed", async () => {
  const x = clone(input.priorRecovery);
  x.plan.payload.extra = "changed";
  await expect(verifyNovemberPriorLineage(x, owner)).rejects.toThrow();
});

it("rejects generation pin hash not matching captured bytes", async () => {
  const x = clone(input);
  x.generationPins[0]!.hash = await h("wrong generation hash");
  const result = await prepareNovemberRecovery(x);
  expect(result.status).toBe("BLOCKED_NOVEMBER_RETROSPECTIVE_BOUNDARY");
  expect(result.plan).toBeNull();
});
it("rejects a self-consistent modified prefix that is not the prior approved snapshot", async () => {
  const x = clone(input);
  const item = x.capturedObjects.find((x) => x.path === revision + "/sessions/2026-10-28.json")!;
  (item.payload as any).state.cashKrw += 1;
  item.hash = await hashSeriesValue(item.payload);
  x.generationPins.find((x) => x.path === item.path)!.hash = item.hash;
  const result = await prepareNovemberRecovery(x);
  expect(result.status).toBe("BLOCKED_NOVEMBER_RETROSPECTIVE_BOUNDARY");
  expect(result.plan).toBeNull();
});
it("returns complete projections for each exact partial prefix", async () => {
  const result = await prepareNovemberRecovery(input);
  expect(result.status).toBe("PROVEN_NOVEMBER_RETROSPECTIVE_CONTINUATION");
  if (result.status !== "PROVEN_NOVEMBER_RETROSPECTIVE_CONTINUATION") return;
  expect(result.projections.map((x) => x.latest.source.date)).toEqual(["2026-10-30", "2026-11-02"]);
  expect(result.projections[1]).toEqual(result.finalProjection);
  expect(result.projections.map((x) => x.latest)).toEqual(result.snapshots);
});
