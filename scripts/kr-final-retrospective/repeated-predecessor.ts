/* eslint-disable @typescript-eslint/no-explicit-any -- independently hashed legacy JSON evidence */
/** Separate pure certificate. NEVER an ordinary reuse guard or an operational approval. */
import { canonicalSeriesJson, type SeriesHash } from "../../src/lib/ledger/modelSeries";
import {
  stepKospiShadow,
  validateShadowSession,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "../../src/lib/engine/kospiShadow";
import { equivalentCompletedKospiShadow } from "../../src/lib/kospiShadowEquivalence";
import {
  KOSPI_SHADOW_NAMESPACE,
  persistKospiShadow,
  type KospiShadowView,
  type ShadowObjectStore,
} from "../../src/lib/kospiShadowStore";
import {
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
  openKospiShadowRevisionStore,
} from "../../src/lib/kospiShadowSeries";
import {
  decodeRecoveryEvidence,
  preparationSourceId,
} from "../kr-adjusted-recovery/evidence-storage";
import type { KospiFinalPreparationAuthority } from "../kospi-final-retrospective-preparation";
import type { FinalPriorRecoveryLineage } from "./contracts";
import { captureCanonicalProof } from "./capture-codec";
import runtime from "../../src/lib/kospiShadowPublicationRuntime.generated.json";
const H = /^sha256:[a-f0-9]{64}$/;
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const clone = <T>(v: T): T => structuredClone(v);
function need(ok: unknown): asserts ok {
  if (!ok) throw Error("REPEATED_PREDECESSOR_REJECTED");
}
export interface RepeatedCapturedObject {
  path: string;
  hash: string;
  payload: unknown;
}
export interface RepeatedGenerationPin {
  path: string;
  hash?: string;
  generation: { id: string; version: string; eTag: string; size: number; updatedAt: string };
}
export interface RepeatedPredecessorInput {
  authority: KospiFinalPreparationAuthority;
  priorRecovery: FinalPriorRecoveryLineage;
  capturedObjects: RepeatedCapturedObject[];
  generationPins: RepeatedGenerationPin[];
  baselineSession: KospiShadowSession;
  adjustedSession: KospiShadowSession;
  targetSessions: KospiShadowSession[];
}
/** Full four-artifact verification; previous approval establishes lineage ONLY. */
export async function verifyPriorRecoveryLineage(
  lineage: FinalPriorRecoveryLineage,
  owner: string,
) {
  need(lineage.version === "kr-final-prior-recovery-lineage-v1");
  for (const x of [lineage.preparation, lineage.fullPlan, lineage.approval, lineage.terminal])
    need(
      x.userId === owner &&
        x.sourceRevision === "1" &&
        H.test(x.storageHash) &&
        H.test(x.logicalHash) &&
        H.test(x.rowHash),
    );
  const p = (await decodeRecoveryEvidence(
    lineage.preparation.payload,
    lineage.preparation.storageHash,
    lineage.preparation.logicalHash,
    "PREPARATION",
  )) as any;
  const f = (await decodeRecoveryEvidence(
    lineage.fullPlan.payload,
    lineage.fullPlan.storageHash,
    lineage.fullPlan.logicalHash,
    "FULL_PLAN",
  )) as any;
  const a = lineage.approval.payload as any,
    t = lineage.terminal.payload as any;
  for (const x of [lineage.approval, lineage.terminal])
    need(
      x.storageHash === x.logicalHash && captureCanonicalProof(x.payload).hash === x.logicalHash,
    );
  need(
    lineage.preparation.sourceId ===
      preparationSourceId(p.planHash, lineage.preparation.logicalHash) &&
      lineage.fullPlan.sourceId ===
        "kr-adjusted-recovery-full-plan:" + f.operationManifestHash.slice(7) &&
      lineage.approval.sourceId ===
        "kr-adjusted-recovery-apply-approval:" + lineage.fullPlan.logicalHash.slice(7) &&
      lineage.terminal.sourceId ===
        "kr-adjusted-recovery-model-stage:" + lineage.terminal.logicalHash.slice(7),
  );
  need(
    p.historicalAvailabilityClaim === false &&
      f.historicalAvailabilityClaim === false &&
      a.version === "kr-adjusted-recovery-apply-approval-v1" &&
      a.status === "APPROVED" &&
      a.owner === owner &&
      a.preparationHash === lineage.preparation.logicalHash &&
      a.fullPlanHash === lineage.fullPlan.logicalHash &&
      f.preparationHash === a.preparationHash &&
      a.operationManifestHash === f.operationManifestHash &&
      a.executionProvenanceHash === captureCanonicalProof(f.executionProvenance).hash,
  );
  need(
    t.version === "kr-adjusted-recovery-model-stage-receipt-v1" &&
      t.approvalHash === lineage.approval.logicalHash &&
      t.fullPlanHash === a.fullPlanHash &&
      t.operationManifestHash === f.operationManifestHash &&
      t.legacyTargetDate === "2026-10-27" &&
      t.actualLedgersUnchanged === true &&
      t.historicalAvailabilityClaim === false,
  );
  const r = p.kospi.result,
    k = f.kospiApprovalCandidate;
  need(
    r.status === "PREPARED_FOR_INDEPENDENT_REVIEW" &&
      r.operationalApproval === false &&
      r.historicalAvailabilityClaim === false &&
      r.authority.owner === owner &&
      same(r.authority.targetDates, ["2026-10-26", "2026-10-27"]) &&
      r.planHash === captureCanonicalProof(r.plan).hash &&
      k.status === "APPROVED" &&
      k.owner === owner &&
      k.preparationHash === a.preparationHash &&
      k.planHash === r.planHash &&
      a.kospiApprovalHash === captureCanonicalProof(k).hash &&
      same(k.targetDates, r.authority.targetDates) &&
      same(k.snapshotHashes, r.plan.snapshotHashes) &&
      k.finalProjectionHash === r.plan.finalProjectionHash &&
      k.predecessorHash === r.plan.predecessorHash &&
      H.test(r.authority.runtimeCodeHash) &&
      k.runtimeCodeHash === r.authority.runtimeCodeHash &&
      a.runtimeHashes.kospi === r.authority.runtimeCodeHash &&
      f.runtimeHashes.kospi === r.authority.runtimeCodeHash,
  );
  need(
    r.snapshots.length === 2 &&
      r.plan.sessions.length === 2 &&
      same(r.targetSessions, r.plan.sessions) &&
      same(
        r.snapshots.map((s: KospiShadowSnapshot) => s.source.date),
        ["2026-10-26", "2026-10-27"],
      ),
  );
  for (let i = 0; i < 2; i++)
    need(captureCanonicalProof(r.snapshots[i]).hash === r.plan.snapshotHashes[i]);
  need(
    captureCanonicalProof(r.finalProjection).hash === r.plan.finalProjectionHash &&
      same(r.finalProjection.latest, r.snapshots[1]),
  );
  return { preparation: p, fullPlan: f, approval: a, terminal: t, result: r };
}
function withoutHistoricalTag(snapshot: KospiShadowSnapshot) {
  const copy = clone(snapshot);
  delete (copy.source as unknown as Record<string, unknown>)["lateRecovery"];
  return copy;
}
function restoredPriority(session: KospiShadowSession, original: KospiShadowSnapshot) {
  const copy = clone(session);
  for (const row of copy.rows) {
    need(Object.hasOwn(original.state.previousRows, row.symbol));
    row.priority = original.state.previousRows[row.symbol]!.priority;
  }
  return copy;
}
/** Existing guard's three audit fields + historical display policy only; optional cache is explicit. */
function comparison(snapshot: KospiShadowSnapshot, original: KospiShadowSnapshot, cache: boolean) {
  const copy = withoutHistoricalTag(snapshot);
  if (cache)
    for (const [symbol, row] of Object.entries(copy.state.previousRows)) {
      need(Object.hasOwn(original.state.previousRows, symbol));
      row.priority = original.state.previousRows[symbol]!.priority;
    }
  const {
    sourceHash: _hash,
    sourceCollectedAt: _time,
    codeVersion: _code,
    ...source
  } = copy.source;
  void _hash;
  void _time;
  void _code;
  const { researchReference: _display, ...policy } = copy.policy as unknown as Record<
    string,
    unknown
  >;
  void _display;
  return { ...copy, source, policy };
}
function memory(
  originals: Map<string, unknown>,
  root: string,
  dates: string[],
  start?: KospiShadowSnapshot,
) {
  const values = new Map([...originals].map(([p, v]) => [p, clone(v)]));
  const writes: Array<{ kind: "IMMUTABLE" | "PROJECTION"; path: string }> = [];
  if (start) {
    const view = values.get(root + "/latest.json") as KospiShadowView;
    view.latest = clone(start);
    values.set(root + "/sessions/" + start.source.date + ".json", clone(start));
  }
  const allowed = new Set(dates.map((d) => root + "/sessions/" + d + ".json"));
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
    putImmutable: async (p, v) => {
      need(allowed.has(p) && !values.has(p));
      values.set(p, clone(v));
      writes.push({ kind: "IMMUTABLE", path: p });
    },
    putLatest: async (p, v) => {
      need(p === root + "/latest.json");
      values.set(p, clone(v));
      writes.push({ kind: "PROJECTION", path: p });
    },
  };
  return { store, values, writes };
}
export async function proveRepeatedRetrospectiveBoundary(input: RepeatedPredecessorInput) {
  let inputHash: SeriesHash | null = null;
  let blockedAt = "INPUT" as
    "INPUT" | "LINEAGE" | "CAPTURE" | "ACTUAL_REPLAY" | "CURRENT_BOUNDARY" | "CONTINUATION";
  const checks: Record<string, boolean> = {};
  try {
    inputHash = captureCanonicalProof(input).hash;
    const a = input.authority;
    need(
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(a.owner) &&
        /^[a-f0-9]{40}$/.test(a.codeVersion) &&
        a.predecessorDate === "2026-10-27" &&
        same(a.targetDates, ["2026-10-28", "2026-10-29"]) &&
        a.runtimeCodeHash === runtime.codeHash,
    );
    for (const h of [
      a.baselineSourceHash,
      a.adjustedBasisHash,
      a.sourceManifestHash,
      a.captureManifestHash,
    ])
      need(H.test(h));
    const collected = Date.parse(a.baselineCollectedAt),
      captured = Date.parse(a.adjustedCapturedAt),
      computed = Date.parse(a.computedAt);
    need(
      Number.isFinite(collected) &&
        collected >= Date.parse("2026-10-29T06:30:00Z") &&
        Number.isFinite(captured) &&
        captured >= collected &&
        Number.isFinite(computed) &&
        computed >= captured,
    );
    blockedAt = "LINEAGE";
    const lineage = await verifyPriorRecoveryLineage(input.priorRecovery, a.owner);
    blockedAt = "CAPTURE";
    const root = `${a.owner}/${KOSPI_SHADOW_NAMESPACE}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
    const originalRoot = `${a.owner}/${KOSPI_SHADOW_NAMESPACE}`;
    const journalPath = new RegExp(
      `^(${originalRoot}|${root})/(registry\\.json|latest\\.json|sessions/\\d{4}-\\d{2}-\\d{2}\\.json)$`,
    );
    const approvalPath = `${originalRoot}/correction-approvals/${KOSPI_SHADOW_CORRECTION_REVISION_ID}.json`;
    const originals = new Map<string, unknown>();
    need(
      input.capturedObjects.length > 0 &&
        input.capturedObjects.length <= 256 &&
        input.generationPins.length === input.capturedObjects.length &&
        new Set(input.generationPins.map((x) => x.path)).size === input.generationPins.length,
    );
    for (const x of input.capturedObjects) {
      need(
        (journalPath.test(x.path) ||
          x.path === root + "/revision.json" ||
          x.path === approvalPath) &&
          !x.path.includes("..") &&
          !originals.has(x.path) &&
          H.test(x.hash) &&
          captureCanonicalProof(x.payload).hash === x.hash,
      );
      const pin = input.generationPins.find((p) => p.path === x.path);
      need(pin && (!pin.hash || H.test(pin.hash)));
      const g = pin.generation;
      need(
        typeof g.id === "string" &&
          g.id.length > 0 &&
          typeof g.version === "string" &&
          g.version.length > 0 &&
          typeof g.eTag === "string" &&
          g.eTag.length > 0 &&
          Number.isSafeInteger(g.size) &&
          g.size > 0 &&
          Number.isFinite(Date.parse(g.updatedAt)),
      );
      originals.set(x.path, clone(x.payload));
    }
    const priorObjects = lineage.preparation.kospi.capturedObjects as RepeatedCapturedObject[];
    need(Array.isArray(priorObjects) && priorObjects.length > 0 && priorObjects.length <= 256);
    const priorPaths = new Set<string>();
    for (const old of priorObjects) {
      need(
        !priorPaths.has(old.path) &&
          H.test(old.hash) &&
          captureCanonicalProof(old.payload).hash === old.hash,
      );
      priorPaths.add(old.path);
      need(originals.has(old.path));
      if (old.path !== root + "/latest.json") need(same(originals.get(old.path), old.payload));
    }
    const expectedPaths = new Set([
      ...priorPaths,
      root + "/sessions/2026-10-26.json",
      root + "/sessions/2026-10-27.json",
    ]);
    need(same([...originals.keys()].sort(), [...expectedPaths].sort()));
    checks.originalEntirePrefixPreserved = true;
    const actual26 = originals.get(root + "/sessions/2026-10-26.json") as KospiShadowSnapshot,
      actual27 = originals.get(root + "/sessions/2026-10-27.json") as KospiShadowSnapshot,
      view = originals.get(root + "/latest.json") as KospiShadowView;
    need(
      actual26 &&
        actual27 &&
        view &&
        same(actual26, lineage.result.snapshots[0]) &&
        same(actual27, lineage.result.snapshots[1]) &&
        same(view, lineage.result.finalProjection) &&
        same(originals.get(root + "/registry.json"), view.registry),
    );
    need(
      (actual27.source as any).lateRecovery &&
        (actual27.source as any).lateRecovery.historicalAvailabilityClaim === false &&
        actual27.source.previousSessionDate === "2026-10-26",
    );
    const readOnly = memory(originals, root, []);
    await openKospiShadowRevisionStore(readOnly.store, a.owner);
    need(readOnly.writes.length === 0);
    blockedAt = "ACTUAL_REPLAY";
    const originalSession = lineage.result.plan.sessions[1] as KospiShadowSession;
    validateShadowSession(originalSession);
    need(same(stepKospiShadow(clone(originalSession), clone(actual26.state)), actual27));
    checks.originalFullReplay = true;
    checks.priorToCurrentRuntimeFullReplay = true;
    const predecessorHash = captureCanonicalProof(actual27).hash;
    for (const [s, hash, clock] of [
      [input.baselineSession, a.baselineSourceHash, a.baselineCollectedAt],
      [input.adjustedSession, a.adjustedBasisHash, a.adjustedCapturedAt],
    ] as const) {
      validateShadowSession(s);
      need(
        s.date === a.predecessorDate &&
          s.previousSessionDate === actual26.source.date &&
          s.sourceHash === hash &&
          s.sourceCollectedAt === clock &&
          s.codeVersion === a.codeVersion &&
          s.configHash === view.registry.configHash &&
          !Object.hasOwn(s, "lateRecovery") &&
          !Object.hasOwn(s, "warmupRows"),
      );
    }
    need(input.targetSessions.length === 2);
    for (const [i, s] of input.targetSessions.entries()) {
      validateShadowSession(s);
      need(
        s.date === a.targetDates[i] &&
          s.previousSessionDate === (i ? a.targetDates[i - 1] : a.predecessorDate) &&
          s.sourceHash === a.adjustedBasisHash &&
          s.sourceCollectedAt === a.adjustedCapturedAt &&
          s.codeVersion === a.codeVersion &&
          s.configHash === view.registry.configHash &&
          !Object.hasOwn(s, "warmupRows"),
      );
      need(
        same((s as any).lateRecovery, {
          version: "kospi-final-retrospective-v1",
          historicalAvailabilityClaim: false,
          retrospective: true,
          sourceDataAsOf: a.targetDates[1],
          sourceCollectedAt: a.baselineCollectedAt,
          captureObservedAt: a.adjustedCapturedAt,
          computedAt: a.computedAt,
          sourceManifestHash: a.sourceManifestHash,
          captureManifestHash: a.captureManifestHash,
          adjustedBasisHash: a.adjustedBasisHash,
          runtimeCodeHash: a.runtimeCodeHash,
          predecessorDate: a.predecessorDate,
          predecessorHash,
        }),
      );
    }
    for (const s of [input.baselineSession, input.adjustedSession, ...input.targetSessions])
      need(
        s.rows.every(
          (r) =>
            Object.hasOwn(r, "priority") &&
            (r.priority === null ||
              (typeof r.priority === "number" && Number.isFinite(r.priority))),
        ),
      );
    blockedAt = "CURRENT_BOUNDARY";
    const comparable = withoutHistoricalTag(actual27);
    const strict = [input.baselineSession, input.adjustedSession].map((s) =>
      equivalentCompletedKospiShadow(s, comparable, actual26, view.registry.initializedDate),
    );
    const restored = [input.baselineSession, input.adjustedSession].map((s) =>
      equivalentCompletedKospiShadow(
        restoredPriority(s, actual27),
        comparable,
        actual26,
        view.registry.initializedDate,
      ),
    );
    checks.baselineStrict = strict[0]!;
    checks.adjustedStrict = strict[1]!;
    checks.baselinePriorityRestored = restored[0]!;
    checks.adjustedPriorityRestored = restored[1]!;
    need(restored.every(Boolean));
    const rebuilt = [input.baselineSession, input.adjustedSession].map((s) =>
      stepKospiShadow(clone(s), clone(actual26.state)),
    );
    need(
      rebuilt.every((s) =>
        same(comparison(s, actual27, true), comparison(actual27, actual27, true)),
      ),
    );
    checks.currentEconomicBoundary = true;
    blockedAt = "CONTINUATION";
    async function continueFrom(start: KospiShadowSnapshot) {
      const m = memory(originals, root, a.targetDates, start);
      const snapshots: KospiShadowSnapshot[] = [],
        projections: KospiShadowView[] = [];
      // Only the actual branch's immutable prefix is authoritative; comparison branches remain local.
      const revision: ShadowObjectStore = {
        ...m.store,
        read: async <T>(p: string) =>
          m.store.read<T>(p.replace(a.owner + "/" + KOSPI_SHADOW_NAMESPACE, root)),
        latestSessionDate: async (p) =>
          m.store.latestSessionDate(p.replace(a.owner + "/" + KOSPI_SHADOW_NAMESPACE, root)),
        putImmutable: async (p, v) =>
          m.store.putImmutable(p.replace(a.owner + "/" + KOSPI_SHADOW_NAMESPACE, root), v),
        putLatest: async (p, v) =>
          m.store.putLatest(p.replace(a.owner + "/" + KOSPI_SHADOW_NAMESPACE, root), v),
      };
      for (const s of input.targetSessions) {
        const result = await persistKospiShadow(
          revision,
          a.owner,
          clone(s),
          clone(view.registry.config),
        );
        need(!result.reused);
        snapshots.push(clone(result.view.latest));
        projections.push(clone(result.view));
      }
      return { m, snapshots, projections };
    }
    const actual = await continueFrom(actual27),
      baseline = await continueFrom(rebuilt[0]!),
      adjusted = await continueFrom(rebuilt[1]!);
    checks.baselineContinuationEqual =
      same(actual.snapshots, baseline.snapshots) && same(actual.projections, baseline.projections);
    checks.adjustedContinuationEqual =
      same(actual.snapshots, adjusted.snapshots) && same(actual.projections, adjusted.projections);
    need(checks.baselineContinuationEqual && checks.adjustedContinuationEqual);
    for (const [path, value] of originals)
      if (path !== root + "/latest.json") need(same(actual.m.values.get(path), value));
    need(
      actual.m.writes.length === 4 &&
        actual.m.writes.filter((x) => x.kind === "IMMUTABLE").length === 2 &&
        captureCanonicalProof(input).hash === inputHash,
    );
    await openKospiShadowRevisionStore(actual.m.store, a.owner);
    const finalProjection = actual.projections.at(-1)!;
    const plan = {
      version: "kospi-repeated-retrospective-plan-v1" as const,
      authority: clone(a),
      boundaryAdmission: {
        mode: "VERIFIED_REPEATED_RETROSPECTIVE_CONTINUATION" as const,
        comparisonMode: strict.every(Boolean)
          ? ("STRICT_INPUT_EQUIVALENCE" as const)
          : ("PRIORITY_CACHE_ONLY_WITH_FULL_CONTINUATION" as const),
        inputHash,
      },
      predecessorHash,
      prefixHashes: Object.fromEntries(
        input.capturedObjects.map((x) => [x.path, x.hash]).sort(([a], [b]) => a!.localeCompare(b!)),
      ),
      configHash: view.registry.configHash,
      sessions: clone(input.targetSessions),
      snapshotHashes: actual.snapshots.map((x) => captureCanonicalProof(x).hash),
      finalProjectionHash: captureCanonicalProof(finalProjection).hash,
      immutablePrefixPreserved: true as const,
      writeSet: actual.m.writes,
      historicalAvailabilityClaim: false as const,
      resetCapital: false as const,
    };
    return {
      version: "kospi-repeated-retrospective-proof-v1" as const,
      status: "PROVEN_REPEATED_RETROSPECTIVE_CONTINUATION" as const,
      authority: clone(a),
      operationalApproval: false as const,
      historicalAvailabilityClaim: false as const,
      strictAcceptanceGuardUnchanged: true as const,
      actualPredecessorTagPreserved: true as const,
      inputHash,
      checks,
      priorLineageHashes: {
        preparation: input.priorRecovery.preparation.logicalHash,
        fullPlan: input.priorRecovery.fullPlan.logicalHash,
        approval: input.priorRecovery.approval.logicalHash,
        terminal: input.priorRecovery.terminal.logicalHash,
      },
      runtimeBridge: {
        priorApprovedRuntimeHash: lineage.result.authority.runtimeCodeHash,
        currentRuntimeHash: a.runtimeCodeHash,
        originalTaggedFullReplayEqual: true as const,
        currentFullContinuationEqual: true as const,
      },
      comparisonHashes: {
        baselinePredecessor: captureCanonicalProof(rebuilt[0]).hash,
        adjustedPredecessor: captureCanonicalProof(rebuilt[1]).hash,
        baselineContinuation: captureCanonicalProof({
          snapshots: baseline.snapshots,
          projections: baseline.projections,
        }).hash,
        adjustedContinuation: captureCanonicalProof({
          snapshots: adjusted.snapshots,
          projections: adjusted.projections,
        }).hash,
      },
      plan,
      planHash: captureCanonicalProof(plan).hash,
      snapshots: actual.snapshots,
      finalProjection,
    };
  } catch {
    return {
      version: "kospi-repeated-retrospective-proof-v1" as const,
      status: "BLOCKED_REPEATED_RETROSPECTIVE_BOUNDARY" as const,
      operationalApproval: false as const,
      historicalAvailabilityClaim: false as const,
      strictAcceptanceGuardUnchanged: true as const,
      inputHash,
      blockedAt,
      checks,
      plan: null,
      planHash: null,
    };
  }
}
export type RepeatedPredecessorProof = Awaited<
  ReturnType<typeof proveRepeatedRetrospectiveBoundary>
>;
