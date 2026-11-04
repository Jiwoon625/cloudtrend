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
import { captureCanonicalProof } from "../kr-final-retrospective/capture-codec";
import type { KospiFinalPreparationAuthority } from "../kospi-final-retrospective-preparation";
import { verifyNovemberPriorLineage } from "../kospi-november-recovery/core";
import admissions from "../../src/lib/kospiShadowRuntimeAdmissions.json";
import { novemberApprovalCandidate } from "../kospi-november-recovery/apply";
import runtime from "../../src/lib/kospiShadowPublicationRuntime.generated.json";
const H = /^sha256:[a-f0-9]{64}$/;
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const clone = <T>(v: T): T => structuredClone(v);
function need(ok: unknown): asserts ok {
  if (!ok) throw Error("NOV3_RECOVERY_REJECTED");
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
export interface Nov3RecoveryInput {
  authority: KospiFinalPreparationAuthority;
  priorRecovery: Nov3PriorRecoveryLineage;
  capturedObjects: RepeatedCapturedObject[];
  generationPins: RepeatedGenerationPin[];
  baselineSession: KospiShadowSession;
  adjustedSession: KospiShadowSession;
  targetSessions: KospiShadowSession[];
}
export interface Nov3Evidence {
  hash: string;
  payload: any;
}
export interface Nov3PriorRecoveryLineage {
  plan: Nov3Evidence;
  approval: Nov3Evidence;
  completion: Nov3Evidence;
}
/** Completed Oct30/Nov2 approval is lineage only, never authority for Nov3. */
export async function verifyNov3PriorLineage(lineage: Nov3PriorRecoveryLineage, owner: string) {
  for (const x of [lineage.plan, lineage.approval, lineage.completion])
    need(x && H.test(x.hash) && captureCanonicalProof(x.payload).hash === x.hash);
  const receipt = lineage.plan.payload,
    approval = lineage.approval.payload,
    terminal = lineage.completion.payload;
  need(
    receipt.version === "kospi-november-recovery-preparation-v1" &&
      receipt.kind === "RECOVERY_PREPARATION_ONLY" &&
      receipt.operationalApproval === false &&
      receipt.historicalAvailabilityClaim === false &&
      receipt.input &&
      receipt.result,
  );
  // Historical proof is authenticated evidence, not a new run through an obsolete
  // admission gate. Current-engine full tagged replay remains mandatory below.
  const result = receipt.result,
    oldInput = receipt.input;
  const ancestor = await verifyNovemberPriorLineage(oldInput.priorRecovery, owner);
  need(
    result.version === "kospi-november-retrospective-proof-v1" &&
      result.status === "PROVEN_NOVEMBER_RETROSPECTIVE_CONTINUATION" &&
      result.operationalApproval === false &&
      result.historicalAvailabilityClaim === false &&
      result.strictAcceptanceGuardUnchanged === true &&
      result.actualPredecessorTagPreserved === true &&
      result.inputHash === captureCanonicalProof(oldInput).hash &&
      result.planHash === captureCanonicalProof(result.plan).hash &&
      same(result.authority, oldInput.authority) &&
      same(result.authority, result.plan.authority) &&
      result.authority.owner === owner &&
      result.authority.predecessorDate === "2026-10-29" &&
      same(result.authority.targetDates, ["2026-10-30", "2026-11-02"]) &&
      admissions.admissions.some((x) => x.runtimeCodeHash === result.authority.runtimeCodeHash) &&
      same(result.plan.sessions, oldInput.targetSessions) &&
      result.plan.version === "kospi-november-retrospective-plan-v1" &&
      result.plan.historicalAvailabilityClaim === false &&
      result.plan.immutablePrefixPreserved === true &&
      result.plan.resetCapital === false,
  );
  need(
    result.runtimeBridge.priorApprovedRuntimeHash === ancestor.result.authority.runtimeCodeHash &&
      result.runtimeBridge.currentRuntimeHash === result.authority.runtimeCodeHash &&
      result.runtimeBridge.originalTaggedFullReplayEqual === true &&
      result.runtimeBridge.currentFullContinuationEqual === true,
  );
  need(
    same(result.priorLineageHashes, {
      preparation: oldInput.priorRecovery.plan.hash,
      fullPlan: oldInput.priorRecovery.plan.hash,
      approval: oldInput.priorRecovery.approval.hash,
      terminal: oldInput.priorRecovery.completion.hash,
    }),
  );
  need(
    Array.isArray(oldInput.capturedObjects) &&
      oldInput.capturedObjects.length > 0 &&
      new Set(oldInput.capturedObjects.map((x: any) => x.path)).size ===
        oldInput.capturedObjects.length,
  );
  for (const x of oldInput.capturedObjects) need(captureCanonicalProof(x.payload).hash === x.hash);
  need(
    same(
      result.plan.prefixHashes,
      Object.fromEntries(oldInput.capturedObjects.map((x: any) => [x.path, x.hash])),
    ),
  );
  need(
    result.snapshots.length === 2 &&
      result.plan.snapshotHashes.length === 2 &&
      result.projections.length === 2 &&
      result.plan.sessions.length === 2,
  );
  for (let i = 0; i < 2; i++)
    need(
      result.snapshots[i].source.date === result.authority.targetDates[i] &&
        result.plan.snapshotHashes[i] === captureCanonicalProof(result.snapshots[i]).hash &&
        same(result.projections[i].latest, result.snapshots[i]) &&
        result.plan.sessions[i].date === result.authority.targetDates[i] &&
        result.plan.sessions[i].lateRecovery?.runtimeCodeHash ===
          result.authority.runtimeCodeHash &&
        result.plan.sessions[i].lateRecovery?.historicalAvailabilityClaim === false,
    );
  need(
    result.plan.finalProjectionHash === captureCanonicalProof(result.finalProjection).hash &&
      same(result.finalProjection.latest, result.snapshots[1]) &&
      same(result.finalProjection, result.projections[1]),
  );
  need(
    approval.owner === owner &&
      result.authority.owner === owner &&
      same(
        approval,
        await novemberApprovalCandidate(lineage.plan.hash as SeriesHash, result, {
          codeCommit: approval.writerCodeCommit,
          runtimeHash: approval.writerRuntimeHash,
        }),
      ),
  );
  need(
    terminal.version === "kospi-november-recovery-execution-v1" &&
      terminal.owner === owner &&
      terminal.preparationHash === lineage.plan.hash &&
      terminal.approvalHash === lineage.approval.hash &&
      terminal.historicalAvailabilityClaim === false &&
      Number.isFinite(Date.parse(terminal.completedAt)),
  );
  const t = terminal.result;
  need(
    t.version === "kospi-november-recovery-completion-v1" &&
      t.status === "VERIFIED" &&
      t.approvalHash === lineage.approval.hash &&
      t.preparationHash === lineage.plan.hash &&
      t.planHash === result.planHash &&
      t.inputHash === result.inputHash &&
      same(t.completedDates, ["2026-10-30", "2026-11-02"]) &&
      t.finalProjectionHash === result.plan.finalProjectionHash &&
      t.writerCodeCommit === approval.writerCodeCommit &&
      t.writerRuntimeHash === approval.writerRuntimeHash &&
      t.originalPrefixUnchanged === true &&
      t.actualLedgerWrites === 0 &&
      t.historicalAvailabilityClaim === false,
  );
  return { receipt: { kospi: { capturedObjects: receipt.input.capturedObjects } }, result };
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
export async function prepareNov3Recovery(input: Nov3RecoveryInput) {
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
        a.predecessorDate === "2026-11-02" &&
        same(a.targetDates, ["2026-11-03"]) &&
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
        collected >= Date.parse("2026-11-03T06:30:00Z") &&
        Number.isFinite(captured) &&
        captured >= collected &&
        Number.isFinite(computed) &&
        computed >= captured,
    );
    blockedAt = "LINEAGE";
    const lineage = await verifyNov3PriorLineage(input.priorRecovery, a.owner);
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
      need(pin && pin.hash === x.hash);
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
    const priorObjects = lineage.receipt.kospi.capturedObjects as RepeatedCapturedObject[];
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
      root + "/sessions/2026-10-30.json",
      root + "/sessions/2026-11-02.json",
    ]);
    need(same([...originals.keys()].sort(), [...expectedPaths].sort()));
    checks.originalEntirePrefixPreserved = true;
    const actual28 = originals.get(root + "/sessions/2026-10-30.json") as KospiShadowSnapshot,
      actual29 = originals.get(root + "/sessions/2026-11-02.json") as KospiShadowSnapshot,
      view = originals.get(root + "/latest.json") as KospiShadowView;
    need(
      actual28 &&
        actual29 &&
        view &&
        same(actual28, lineage.result.snapshots[0]) &&
        same(actual29, lineage.result.snapshots[1]) &&
        same(view, lineage.result.finalProjection) &&
        same(originals.get(root + "/registry.json"), view.registry),
    );
    need(
      (actual29.source as any).lateRecovery &&
        (actual29.source as any).lateRecovery.historicalAvailabilityClaim === false &&
        actual29.source.previousSessionDate === "2026-10-30",
    );
    const readOnly = memory(originals, root, []);
    await openKospiShadowRevisionStore(readOnly.store, a.owner);
    need(readOnly.writes.length === 0);
    blockedAt = "ACTUAL_REPLAY";
    const originalSession = lineage.result.plan.sessions[1] as KospiShadowSession;
    const actual27 = originals.get(root + "/sessions/2026-10-29.json") as KospiShadowSnapshot;
    validateShadowSession(lineage.result.plan.sessions[0]);
    validateShadowSession(originalSession);
    need(
      actual27 &&
        same(
          stepKospiShadow(clone(lineage.result.plan.sessions[0]), clone(actual27.state)),
          actual28,
        ),
    );
    need(same(stepKospiShadow(clone(originalSession), clone(actual28.state)), actual29));
    checks.originalFullReplay = true;
    checks.priorToCurrentRuntimeFullReplay = true;
    const predecessorHash = captureCanonicalProof(actual29).hash;
    for (const [s, hash, clock] of [
      [input.baselineSession, a.baselineSourceHash, a.baselineCollectedAt],
      [input.adjustedSession, a.adjustedBasisHash, a.adjustedCapturedAt],
    ] as const) {
      validateShadowSession(s);
      need(
        s.date === a.predecessorDate &&
          s.previousSessionDate === actual28.source.date &&
          s.sourceHash === hash &&
          s.sourceCollectedAt === clock &&
          s.codeVersion === a.codeVersion &&
          s.configHash === view.registry.configHash &&
          !Object.hasOwn(s, "lateRecovery") &&
          !Object.hasOwn(s, "warmupRows"),
      );
    }
    need(input.targetSessions.length === 1);
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
          sourceDataAsOf: a.targetDates[0],
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
    const comparable = withoutHistoricalTag(actual29);
    const strict = [input.baselineSession, input.adjustedSession].map((s) =>
      equivalentCompletedKospiShadow(s, comparable, actual28, view.registry.initializedDate),
    );
    const restored = [input.baselineSession, input.adjustedSession].map((s) =>
      equivalentCompletedKospiShadow(
        restoredPriority(s, actual29),
        comparable,
        actual28,
        view.registry.initializedDate,
      ),
    );
    checks.baselineStrict = strict[0]!;
    checks.adjustedStrict = strict[1]!;
    checks.baselinePriorityRestored = restored[0]!;
    checks.adjustedPriorityRestored = restored[1]!;
    need(restored.every(Boolean));
    const rebuilt = [input.baselineSession, input.adjustedSession].map((s) =>
      stepKospiShadow(clone(s), clone(actual28.state)),
    );
    need(
      rebuilt.every((s) =>
        same(comparison(s, actual29, true), comparison(actual29, actual29, true)),
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
    const actual = await continueFrom(actual29),
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
      actual.m.writes.length === 2 &&
        actual.m.writes.filter((x) => x.kind === "IMMUTABLE").length === 1 &&
        captureCanonicalProof(input).hash === inputHash,
    );
    await openKospiShadowRevisionStore(actual.m.store, a.owner);
    const finalProjection = actual.projections.at(-1)!;
    const plan = {
      version: "kospi-nov3-retrospective-plan-v1" as const,
      authority: clone(a),
      boundaryAdmission: {
        mode: "VERIFIED_NOV3_RETROSPECTIVE_CONTINUATION" as const,
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
      version: "kospi-nov3-retrospective-proof-v1" as const,
      status: "PROVEN_NOV3_RETROSPECTIVE_CONTINUATION" as const,
      authority: clone(a),
      operationalApproval: false as const,
      historicalAvailabilityClaim: false as const,
      strictAcceptanceGuardUnchanged: true as const,
      actualPredecessorTagPreserved: true as const,
      inputHash,
      checks,
      priorLineageHashes: {
        preparation: input.priorRecovery.plan.hash,
        fullPlan: input.priorRecovery.plan.hash,
        approval: input.priorRecovery.approval.hash,
        terminal: input.priorRecovery.completion.hash,
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
      projections: actual.projections,
      finalProjection,
    };
  } catch {
    return {
      version: "kospi-nov3-retrospective-proof-v1" as const,
      status: "BLOCKED_NOV3_RETROSPECTIVE_BOUNDARY" as const,
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
export type RepeatedPredecessorProof = Awaited<ReturnType<typeof prepareNov3Recovery>>;
