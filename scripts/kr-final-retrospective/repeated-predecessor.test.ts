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
} from "./repeated-predecessor";
import { applyRepeatedLegacy, repeatedLegacyApprovalCandidate } from "./repeated-legacy-apply";
const clone = structuredClone;
const owner = oldInput.authority.owner;
const root = `${owner}/${KOSPI_SHADOW_NAMESPACE}`;
const revision = `${root}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
const h = (name: string) => hashSeriesValue({ synthetic: name });
let input: RepeatedPredecessorInput, proved: any;
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
beforeAll(async () => {
  input = await syntheticFixture();
  proved = await proveRepeatedRetrospectiveBoundary(input);
}, 60000);

it("proves exact unchanged tagged predecessor and full continuation without modifying input", async () => {
  const before = clone(input);
  const result = await proveRepeatedRetrospectiveBoundary(input);
  expect(result.status, JSON.stringify(result)).toBe("PROVEN_REPEATED_RETROSPECTIVE_CONTINUATION");
  expect(input).toEqual(before);
  if (result.status !== "PROVEN_REPEATED_RETROSPECTIVE_CONTINUATION") return;
  expect(result.snapshots.map((s) => s.source.date)).toEqual(["2026-10-28", "2026-10-29"]);
  expect(result.actualPredecessorTagPreserved).toBe(true);
  expect(result.operationalApproval).toBe(false);
  const actual27: any = input.capturedObjects.find(
    (x) => x.path === revision + "/sessions/2026-10-27.json",
  )!.payload;
  const actual26: any = input.capturedObjects.find(
    (x) => x.path === revision + "/sessions/2026-10-26.json",
  )!.payload;
  expect(actual27.source.lateRecovery).toBeTruthy();
  expect(
    equivalentCompletedKospiShadow(
      input.baselineSession,
      actual27,
      actual26,
      actual27.state.initializedDate,
    ),
  ).toBe(false);
});
it.each(["price", "source", "capture", "lineage"])(
  "blocks %s mismatch with no approvable plan",
  async (kind) => {
    const modified: any = clone(input);
    if (kind === "price") modified.adjustedSession.rows[0].close += 1;
    if (kind === "source") modified.adjustedSession.benchmarkClose += 1;
    if (kind === "capture") modified.capturedObjects[0].hash = await h("wrong capture");
    if (kind === "lineage")
      modified.priorRecovery.approval.payload.owner = "00000000-0000-0000-0000-000000000002";
    const result = await proveRepeatedRetrospectiveBoundary(modified);
    expect(result.status).toBe("BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY");
    expect(result.plan).toBeNull();
    await expect(
      repeatedLegacyApprovalCandidate(await h("blocked receipt"), result),
    ).rejects.toThrow();
  },
);

async function harness() {
  const receipt = {
    version: "kr-repeated-retrospective-preparation-v1",
    kind: "RECOVERY_PREPARATION_ONLY",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    kospi: {
      capturedObjects: clone(input.capturedObjects),
      repeatedProofInput: clone(input),
      result: clone(proved),
    },
  };
  const receiptHash = await hashSeriesValue(receipt);
  const approval = await repeatedLegacyApprovalCandidate(receiptHash, proved);
  const values = new Map(input.capturedObjects.map((x) => [x.path, clone(x.payload)]));
  const writes: string[] = [];
  let fault: { at: number; after: boolean } | null = null,
    calls = 0;
  const write = async (path: string, payload: unknown, immutable: boolean) => {
    const trigger = ++calls === fault?.at;
    if (trigger && !fault?.after) throw Error("SYNTHETIC_BEFORE");
    if (immutable && values.has(path)) throw Error("SYNTHETIC_COLLISION");
    values.set(path, clone(payload));
    writes.push(path);
    if (trigger && fault?.after) throw Error("SYNTHETIC_AFTER");
  };
  const store: ShadowObjectStore = {
    read: async <T>(p: string) => clone(values.get(p) ?? null) as T | null,
    latestSessionDate: async (p) =>
      [...values.keys()]
        .filter((k) => k.startsWith(p + "/"))
        .map((k) => k.slice(p.length + 1))
        .filter((k) => /^\d{4}-\d{2}-\d{2}\.json$/.test(k))
        .sort()
        .at(-1)
        ?.slice(0, -5) ?? null,
    putImmutable: (p, v) => write(p, v, true),
    putLatest: (p, v) => write(p, v, false),
  };
  const args = {
    store,
    preparationReceipt: receipt,
    approval,
    authoritativePreparationHash: receiptHash,
    authoritativeApprovalHash: await hashSeriesValue(approval),
    approvedRuntimeCodeHash: input.authority.runtimeCodeHash as `sha256:${string}`,
    assertExclusiveWriter: async (scope: any) => {
      expect(scope.owner).toBe(owner);
      expect(scope.requiredConcurrencyGroup).toBe("kospi-prospective-shadow");
    },
  };
  return {
    args,
    writes,
    values,
    fault: (value: typeof fault) => {
      fault = value;
    },
  };
}
it("writer recomputes proof, appends only two sessions, preserves tagged prefix and is idempotent", async () => {
  const f = await harness();
  expect((await applyRepeatedLegacy(f.args)).verifiedWriteCount).toBe(4);
  expect((await applyRepeatedLegacy(f.args)).verifiedWriteCount).toBe(0);
  expect(f.writes).toHaveLength(4);
  for (const x of input.capturedObjects)
    if (x.path !== revision + "/latest.json") expect(f.values.get(x.path)).toEqual(x.payload);
});
it.each([1, 2, 3, 4])(
  "uncertain post-commit write %i is read back without duplicates",
  async (at) => {
    const f = await harness();
    f.fault({ at, after: true });
    expect((await applyRepeatedLegacy(f.args)).status).toBe("VERIFIED");
    expect(f.writes).toHaveLength(4);
  },
);
it.each([1, 2, 3, 4])(
  "pre-commit failure %i stops, then exact approved resumption avoids duplicate writes",
  async (at) => {
    const f = await harness();
    f.fault({ at, after: false });
    await expect(applyRepeatedLegacy(f.args)).rejects.toThrow(/UNCERTAIN/);
    f.fault(null);
    expect((await applyRepeatedLegacy(f.args)).status).toBe("VERIFIED");
    expect(f.writes).toHaveLength(4);
  },
);

it("rejects rehashed prior approval that does not authenticate its prior plan", async () => {
  const modified = clone(input);
  const evidence = modified.priorRecovery.approval;
  (evidence.payload as any).fullPlanHash = await h("unrelated old full plan");
  evidence.logicalHash = evidence.storageHash = await hashSeriesValue(evidence.payload);
  const result = await proveRepeatedRetrospectiveBoundary(modified);
  expect(result.status).toBe("BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY");
  if (result.status === "BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY")
    expect(result.blockedAt).toBe("LINEAGE");
});
it("rejects tampered prepared proof before any operational write", async () => {
  const f = await harness();
  (f.args.preparationReceipt.kospi.result as any).snapshots[0].state.cashKrw += 1;
  await expect(applyRepeatedLegacy(f.args)).rejects.toThrow(/AUTHORITY_HASH/);
  expect(f.writes).toHaveLength(0);
});
it("rejects changed live immutable prefix before any operational write", async () => {
  const f = await harness();
  const path = revision + "/sessions/2026-10-27.json";
  const current: any = clone(f.values.get(path));
  current.state.cashKrw += 1;
  f.values.set(path, current);
  await expect(applyRepeatedLegacy(f.args)).rejects.toThrow(/LIVE_PREFIX_CHANGED/);
  expect(f.writes).toHaveLength(0);
});

it("bridges a different authenticated prior runtime only through current exact original replay", async () => {
  const value = await syntheticFixture({ priorRuntime: await h("genuine prior runtime identity") });
  expect(
    (value.priorRecovery.preparation.payload as any).kospi.result.authority.runtimeCodeHash,
  ).not.toBe(value.authority.runtimeCodeHash);
  const result = await proveRepeatedRetrospectiveBoundary(value);
  expect(result.status, JSON.stringify(result)).toBe("PROVEN_REPEATED_RETROSPECTIVE_CONTINUATION");
  expect(result.checks.originalFullReplay).toBe(true);
});
it("blocks authenticated prior output that current engine cannot replay exactly", async () => {
  const value = await syntheticFixture({
    priorRuntime: await h("genuine prior runtime identity"),
    damageReplay: true,
  });
  const result = await proveRepeatedRetrospectiveBoundary(value);
  expect(result.status).toBe("BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY");
  if (result.status === "BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY")
    expect(result.blockedAt).toBe("ACTUAL_REPLAY");
});
it("blocks internally inconsistent old runtime even when every artifact is rehashed", async () => {
  const value = await syntheticFixture({ inconsistentRuntime: true });
  const result = await proveRepeatedRetrospectiveBoundary(value);
  expect(result.status).toBe("BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY");
  if (result.status === "BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY")
    expect(result.blockedAt).toBe("LINEAGE");
});
it.each(["empty-version", "invalid-size", "invalid-clock", "path-traversal", "duplicate-path"])(
  "blocks malformed captured generation/path: %s",
  async (kind) => {
    const value = clone(input);
    if (kind === "empty-version") value.generationPins[0]!.generation.version = "";
    if (kind === "invalid-size") value.generationPins[0]!.generation.size = -1;
    if (kind === "invalid-clock") value.generationPins[0]!.generation.updatedAt = "invalid";
    if (kind === "path-traversal") value.capturedObjects[0]!.path = root + "/../escape.json";
    if (kind === "duplicate-path") value.generationPins[0]!.path = value.generationPins[1]!.path;
    const result = await proveRepeatedRetrospectiveBoundary(value);
    expect(result.status).toBe("BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY");
    if (result.status === "BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY")
      expect(result.blockedAt).toBe("CAPTURE");
  },
);

it("permits only non-economic previous-row priority cache drift with equal full continuations", async () => {
  const value = clone(input);
  for (const session of [value.baselineSession, value.adjustedSession])
    for (const row of session.rows) row.priority = (row.priority ?? 0) + 100;
  const result = await proveRepeatedRetrospectiveBoundary(value);
  expect(result.status, JSON.stringify(result)).toBe("PROVEN_REPEATED_RETROSPECTIVE_CONTINUATION");
  if (result.status !== "PROVEN_REPEATED_RETROSPECTIVE_CONTINUATION") return;
  expect(result.plan.boundaryAdmission.comparisonMode).toBe(
    "PRIORITY_CACHE_ONLY_WITH_FULL_CONTINUATION",
  );
  expect(result.checks.baselineStrict).toBe(false);
  expect(result.checks.adjustedStrict).toBe(false);
  expect(result.checks.baselineContinuationEqual).toBe(true);
  expect(result.checks.adjustedContinuationEqual).toBe(true);
});
it("blocks priority changes that alter a candidate's economic pending-entry intent", async () => {
  const value = await syntheticFixture({ economicPriority: true });
  const actual: any = value.capturedObjects.find(
    (x) => x.path === revision + "/sessions/2026-10-27.json",
  )!.payload;
  expect(actual.state.pendingEntries.length).toBeGreaterThan(0);
  const symbol = actual.state.pendingEntries[0].symbol;
  for (const session of [value.baselineSession, value.adjustedSession]) {
    const row = session.rows.find((r) => r.symbol === symbol)!;
    row.priority = (row.priority ?? 0) + 100;
  }
  const result = await proveRepeatedRetrospectiveBoundary(value);
  expect(result.status).toBe("BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY");
  if (result.status === "BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY")
    expect(result.blockedAt).toBe("CURRENT_BOUNDARY");
});

it("blocks an orphan captured object even with a matching generation pin", async () => {
  const value = clone(input);
  const path = root + "/sessions/2026-10-01.json",
    payload = { synthetic: "orphan" };
  value.capturedObjects.push({ path, payload, hash: await hashSeriesValue(payload) });
  value.generationPins.push({ ...clone(value.generationPins[0]!), path });
  const result = await proveRepeatedRetrospectiveBoundary(value);
  expect(result.status).toBe("BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY");
});
it("blocks a missing authenticated original prefix object", async () => {
  const value = clone(input);
  const path = root + "/sessions/2026-10-02.json";
  expect(value.capturedObjects.some((x) => x.path === path)).toBe(true);
  value.capturedObjects = value.capturedObjects.filter((x) => x.path !== path);
  value.generationPins = value.generationPins.filter((x) => x.path !== path);
  const result = await proveRepeatedRetrospectiveBoundary(value);
  expect(result.status).toBe("BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY");
});
