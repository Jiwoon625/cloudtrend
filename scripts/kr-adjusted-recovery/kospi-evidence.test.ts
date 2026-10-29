/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { stepKospiShadow, KOSPI_SHADOW_POLICY } from "../../src/lib/engine/kospiShadow";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { equivalentCompletedKospiShadow } from "../../src/lib/kospiShadowEquivalence";
import { shadowObjectPath } from "../../src/lib/kospiShadowStore";
import {
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
  kospiShadowRevisionPath,
} from "../../src/lib/kospiShadowSeries";
import { diagnoseKospiCompletedBoundary } from "../kospi-boundary-diagnostic";
import { verifyPreparationKospiBoundary } from "./verify";
const H = "sha256:" + "a".repeat(64),
  owner = "00000000-0000-0000-0000-000000000001";
async function fixture(blocked = false) {
  const session = (date: string, previousSessionDate: string | null): any => ({
    date,
    previousSessionDate,
    sourceHash: H,
    configHash: H,
    codeVersion: "a".repeat(40),
    sourceCollectedAt: "2026-10-28T00:00:00Z",
    confirmedClose: true,
    benchmarkClose: 100,
    gate: { date, status: "NEUTRAL", issues: [] },
    rows: [],
  });
  const prior = stepKospiShadow(session("2026-10-22", null), null),
    baseline = session("2026-10-23", "2026-10-22"),
    adjusted = structuredClone(baseline),
    completed = stepKospiShadow(baseline, prior.state);
  if (blocked) adjusted.benchmarkClose = 101;
  const registry = {
    strategyId: KOSPI_SHADOW_POLICY.id,
    ruleVersion: KOSPI_SHADOW_POLICY.version,
    initializedDate: "2026-10-22",
    configHash: H,
    config: { synthetic: true },
    initialSourceHash: H,
    initialCodeVersion: "a".repeat(40),
  };
  const root = kospiShadowRevisionPath(owner, "registry.json").slice(0, -"/registry.json".length);
  const captured = await Promise.all(
    [
      ["registry.json", registry],
      ["sessions/2026-10-22.json", prior],
      ["sessions/2026-10-23.json", completed],
      ["latest.json", { registry, latest: completed }],
    ].map(async ([path, payload]) => ({
      path: root + "/" + path,
      payload,
      hash: await hashSeriesValue(payload),
    })),
  );
  const baselineBoundaryEquivalent = equivalentCompletedKospiShadow(
      baseline,
      completed,
      prior,
      registry.initializedDate,
    ),
    adjustedBoundaryEquivalent = equivalentCompletedKospiShadow(
      adjusted,
      completed,
      prior,
      registry.initializedDate,
    );
  const boundaryDiagnostic = await diagnoseKospiCompletedBoundary({
    baselineSession: baseline,
    adjustedSession: adjusted,
    registry: captured[0] as any,
    predecessor: captured[1] as any,
    completed: captured[2] as any,
    guardResults: { baseline: baselineBoundaryEquivalent, adjusted: adjustedBoundaryEquivalent },
  });
  return {
    scope: { predecessorDate: "2026-10-23", dates: ["2026-10-26", "2026-10-27"] },
    codeCommit: "a".repeat(40),
    sourceRosterHash: H,
    captureManifestHash: H,
    candidate: { datasetHash: H },
    captureObservedAt: baseline.sourceCollectedAt,
    preparedAt: "2026-10-28T01:00:00Z",
    runtimeHashes: { kospi: H },
    clockSemantics: { sourceRegisteredAt: "2026-10-28T00:00:00.000Z" },
    kospi: {
      capturedObjects: captured,
      generationPins: captured.map(({ path }) => ({ path })),
      result: {
        authority: {
          owner,
          predecessorDate: "2026-10-23",
          targetDates: ["2026-10-26", "2026-10-27"],
          codeVersion: "a".repeat(40),
          sourceManifestHash: H,
          captureManifestHash: H,
          adjustedBasisHash: H,
          baselineSourceHash: H,
          baselineCollectedAt: baseline.sourceCollectedAt,
          adjustedCapturedAt: baseline.sourceCollectedAt,
          computedAt: "2026-10-28T01:00:00Z",
          runtimeCodeHash: H,
        },
        baselineBoundaryEquivalent,
        adjustedBoundaryEquivalent,
        boundaryDiagnostic,
        plan: null,
      },
    },
  };
}
describe("private completed KOSPI diagnostic receipt binding", () => {
  it.each([false, true])(
    "recomputes exact diagnostic; blocked=%s remains evidence not approval",
    async (blocked) => {
      const p = await fixture(blocked);
      expect(
        p.kospi.capturedObjects.every((o) =>
          o.path.startsWith(owner + "/shadow/kospi-confirm1-bear-rsaccel-v1/"),
        ),
      ).toBe(true);
      await verifyPreparationKospiBoundary(p);
      await verifyPreparationKospiBoundary(JSON.parse(JSON.stringify(p)));
      expect(p.kospi.result.adjustedBoundaryEquivalent).toBe(!blocked);
      expect(p.kospi.result.plan).toBeNull();
    },
  );
  it.each([
    "sessionHash",
    "sessionValue",
    "capturedHash",
    "capturedValue",
    "latest",
    "registry",
    "date",
    "owner",
    "code",
    "runtime",
    "guard",
    "diagnosticFlag",
    "reference",
    "duplicate",
    "doubleShadow",
    "originalRegistryAlias",
    "targetDates",
    "actualClock",
    "generationInventory",
    "unboundPriorityProof",
    "unboundPriorityMode",
    "missingTargetBodies",
  ])("rejects %s tampering before append", async (mode) => {
    const p: any = await fixture(),
      r = p.kospi.result,
      d = r.boundaryDiagnostic;
    if (mode === "unboundPriorityProof")
      r.priorityContinuation = { status: "PROVEN_PRIORITY_ONLY_CONTINUATION" };
    if (mode === "unboundPriorityMode")
      r.plan = {
        boundaryAdmission: { mode: "PRIORITY_ONLY_PREDECESSOR_CONTINUATION", proofHash: H },
      };
    if (mode === "missingTargetBodies") r.targetSessions = [];
    if (mode === "doubleShadow") {
      for (const item of p.kospi.capturedObjects)
        item.path = item.path.replace("/shadow/", "/shadow/shadow/");
      for (const item of p.kospi.generationPins)
        item.path = item.path.replace("/shadow/", "/shadow/shadow/");
    }
    if (mode === "originalRegistryAlias")
      p.kospi.capturedObjects[0].path = shadowObjectPath(owner, "registry.json");
    if (mode === "targetDates") r.authority.targetDates.pop();
    if (mode === "actualClock") p.clockSemantics.sourceRegisteredAt = "2026-10-28T01:00:00Z";
    if (mode === "generationInventory") p.kospi.generationPins.pop();
    if (mode === "sessionHash") d.sessions.adjusted.hash = "sha256:" + "b".repeat(64);
    if (mode === "sessionValue") d.sessions.adjusted.payload.benchmarkClose++;
    if (mode === "capturedHash") p.kospi.capturedObjects[2].hash = "sha256:" + "b".repeat(64);
    if (mode === "capturedValue") p.kospi.capturedObjects[2].payload.source.configHash = "changed";
    if (mode === "latest") p.kospi.capturedObjects[3].payload.latest.source.date = "2026-10-24";
    if (mode === "registry")
      p.kospi.capturedObjects[0].path = p.kospi.capturedObjects[0].path.replace(
        "/revisions/" + KOSPI_SHADOW_CORRECTION_REVISION_ID,
        "",
      );
    if (mode === "date") p.scope.predecessorDate = "2026-10-22";
    if (mode === "owner") r.authority.owner = "00000000-0000-0000-0000-000000000002";
    if (mode === "code") r.authority.codeVersion = "b".repeat(40);
    if (mode === "runtime") r.authority.runtimeCodeHash = "sha256:" + "b".repeat(64);
    if (mode === "guard") r.adjustedBoundaryEquivalent = false;
    if (mode === "diagnosticFlag") d.acceptanceGuardUnchanged = false;
    if (mode === "reference") d.capturedReferences.completed.path = "not-a-captured-path";
    if (mode === "duplicate")
      p.kospi.capturedObjects.push(structuredClone(p.kospi.capturedObjects[0]));
    await expect(verifyPreparationKospiBoundary(p)).rejects.toThrow();
  });
});
