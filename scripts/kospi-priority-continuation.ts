/** Pure private counterfactual certificate. Never an approval or a replacement for strict reuse. */
import {
  stepKospiShadow,
  validateShadowSession,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "../src/lib/engine/kospiShadow";
import { equivalentCompletedKospiShadow } from "../src/lib/kospiShadowEquivalence";
import {
  persistKospiShadow,
  shadowObjectPath,
  type KospiShadowRegistry,
  type KospiShadowView,
  type ShadowObjectStore,
} from "../src/lib/kospiShadowStore";
import { kospiShadowRevisionPath } from "../src/lib/kospiShadowSeries";
import { canonicalSeriesJson, hashSeriesValue } from "../src/lib/ledger/modelSeries";
import { nextKrRegularSession } from "../src/lib/ledger/krShadowDecision";
import runtime from "../src/lib/kospiShadowPublicationRuntime.generated.json";
import type { KospiFinalPreparationAuthority } from "./kospi-final-retrospective-preparation";

interface Captured<T> {
  path: string;
  hash: string;
  payload: T;
}
export interface KospiPriorityContinuationInput {
  authority: KospiFinalPreparationAuthority;
  registry: Captured<KospiShadowRegistry>;
  completed: Captured<KospiShadowSnapshot>;
  predecessor: Captured<KospiShadowSnapshot> | null;
  originalView: Captured<KospiShadowView>;
  baselineSession: KospiShadowSession;
  adjustedSession: KospiShadowSession;
  targetSessions: KospiShadowSession[];
}
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const clone = <T>(v: T): T => structuredClone(v);
const H = /^sha256:[a-f0-9]{64}$/;
function requireIntegrity(value: unknown) {
  if (!value) throw new Error("KOSPI_PRIORITY_CONTINUATION_INTEGRITY");
}
function validDate(d: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(d) &&
    Number.isFinite(Date.parse(d + "T00:00:00Z")) &&
    new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d
  );
}
function time(v: string) {
  requireIntegrity(
    typeof v === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) &&
      validDate(v.slice(0, 10)) &&
      Number.isFinite(Date.parse(v)),
  );
  return Date.parse(v);
}
function comparison(snapshot: KospiShadowSnapshot) {
  const { sourceHash: _h, sourceCollectedAt: _t, codeVersion: _c, ...source } = snapshot.source;
  const { researchReference: _r, ...policy } = snapshot.policy as unknown as Record<
    string,
    unknown
  >;
  return { ...snapshot, source, policy };
}
/** Mask exactly the non-consumed previous-row priority cache; candidate/current priorities remain binding. */
function restoreCache(snapshot: KospiShadowSnapshot, original: KospiShadowSnapshot) {
  const copy = clone(snapshot);
  for (const [symbol, row] of Object.entries(copy.state.previousRows)) {
    const old = original.state.previousRows[symbol];
    if (old) row.priority = old.priority;
  }
  return copy;
}
function restoredInput(session: KospiShadowSession, original: KospiShadowSnapshot) {
  const copy = clone(session);
  for (const row of copy.rows) {
    const old = original.state.previousRows[row.symbol];
    if (old) row.priority = old.priority;
  }
  return copy;
}
interface Replay {
  payload: KospiShadowSnapshot | null;
  hash: string | null;
  error: boolean;
}
interface Continuation {
  snapshots: KospiShadowSnapshot[];
  projections: KospiShadowView[];
  snapshotHashes: string[];
  projectionHashes: string[];
  error: boolean;
}
async function replay(
  session: KospiShadowSession,
  previous: KospiShadowSnapshot | null,
): Promise<Replay> {
  try {
    const payload = stepKospiShadow(clone(session), previous ? clone(previous.state) : null);
    return { payload, hash: await hashSeriesValue(payload), error: false };
  } catch {
    return { payload: null, hash: null, error: true };
  }
}
async function continueInMemory(
  input: KospiPriorityContinuationInput,
  start: KospiShadowSnapshot,
): Promise<Continuation> {
  const a = input.authority,
    path = (s: string) => shadowObjectPath(a.owner, s),
    view = clone(input.originalView.payload);
  view.latest = clone(start);
  const values = new Map<string, unknown>([
    [path("registry.json"), clone(input.registry.payload)],
    [path("latest.json"), view],
    [path(`sessions/${a.predecessorDate}.json`), clone(start)],
  ]);
  const targets = new Set(a.targetDates.map((d) => path(`sessions/${d}.json`)));
  const store: ShadowObjectStore = {
    read: async <T>(p: string) => clone(values.get(p) ?? null) as T | null,
    latestSessionDate: async (root: string) =>
      [...values.keys()]
        .filter((p) => p.startsWith(root + "/"))
        .map((p) => p.slice(root.length + 1))
        .filter((p) => /^\d{4}-\d{2}-\d{2}\.json$/.test(p))
        .sort()
        .at(-1)
        ?.slice(0, -5) ?? null,
    putImmutable: async (p, v) => {
      requireIntegrity(targets.has(p) && !values.has(p));
      values.set(p, clone(v));
    },
    putLatest: async (p, v) => {
      requireIntegrity(p === path("latest.json"));
      values.set(p, clone(v));
    },
  };
  const result: Continuation = {
    snapshots: [],
    projections: [],
    snapshotHashes: [],
    projectionHashes: [],
    error: false,
  };
  try {
    for (const session of input.targetSessions) {
      const appended = await persistKospiShadow(
        store,
        a.owner,
        clone(session),
        clone(input.registry.payload.config),
      );
      requireIntegrity(!appended.reused);
      result.snapshots.push(clone(appended.view.latest));
      result.projections.push(clone(appended.view));
      result.snapshotHashes.push(await hashSeriesValue(appended.view.latest));
      result.projectionHashes.push(await hashSeriesValue(appended.view));
    }
  } catch {
    result.error = true;
  }
  return result;
}

export async function proveKospiPriorityContinuation(input: KospiPriorityContinuationInput) {
  const inputHash = await hashSeriesValue(input),
    a = input.authority;
  // The only restored field must be valid in the ACTUAL input, not only its copy.
  // validateShadowSession checks date/symbol provenance but not numeric priority.
  for (const session of [input.baselineSession, input.adjustedSession, ...input.targetSessions])
    requireIntegrity(
      session.rows.every(
        (row) =>
          Object.hasOwn(row, "priority") &&
          (row.priority === null ||
            (typeof row.priority === "number" && Number.isFinite(row.priority))),
      ),
    );
  requireIntegrity(/^[a-f\d-]{36}$/i.test(a.owner) && /^[a-f0-9]{40}$/.test(a.codeVersion));
  for (const value of [
    a.baselineSourceHash,
    a.adjustedBasisHash,
    a.sourceManifestHash,
    a.captureManifestHash,
    a.runtimeCodeHash,
  ])
    requireIntegrity(H.test(value));
  requireIntegrity(
    validDate(a.predecessorDate) &&
      a.targetDates.length === 2 &&
      a.targetDates[0] === nextKrRegularSession(a.predecessorDate) &&
      a.targetDates[1] === nextKrRegularSession(a.targetDates[0]!),
  );
  requireIntegrity(a.runtimeCodeHash === runtime.codeHash);
  const collected = time(a.baselineCollectedAt),
    captured = time(a.adjustedCapturedAt),
    computed = time(a.computedAt);
  requireIntegrity(
    collected >= Date.parse(a.targetDates[1] + "T06:30:00Z") &&
      captured >= collected &&
      computed >= captured,
  );
  for (const object of [input.registry, input.completed, input.predecessor, input.originalView])
    if (object)
      requireIntegrity(
        H.test(object.hash) && (await hashSeriesValue(object.payload)) === object.hash,
      );
  const original = input.completed.payload,
    prior = input.predecessor?.payload ?? null,
    registry = input.registry.payload;
  const revisionPath = (suffix: string) => kospiShadowRevisionPath(a.owner, suffix);
  requireIntegrity(
    input.registry.path === revisionPath("registry.json") &&
      input.originalView.path === revisionPath("latest.json") &&
      input.completed.path === revisionPath(`sessions/${a.predecessorDate}.json`),
  );
  requireIntegrity(
    original.source.date === a.predecessorDate &&
      same(input.originalView.payload.latest, original) &&
      same(input.originalView.payload.registry, registry),
  );
  requireIntegrity(
    input.originalView.payload.schemaVersion === 1 &&
      input.originalView.payload.history.at(-1)?.date === a.predecessorDate &&
      same(input.originalView.payload.history.at(-1), original.daily),
  );
  requireIntegrity((await hashSeriesValue(registry.config)) === registry.configHash);
  if (input.predecessor)
    requireIntegrity(
      input.predecessor.path ===
        revisionPath(`sessions/${original.source.previousSessionDate}.json`) &&
        prior!.source.date === original.source.previousSessionDate,
    );
  else
    requireIntegrity(
      original.source.previousSessionDate === null &&
        registry.initializedDate === a.predecessorDate,
    );
  for (const [session, sourceHash, clock] of [
    [input.baselineSession, a.baselineSourceHash, a.baselineCollectedAt],
    [input.adjustedSession, a.adjustedBasisHash, a.adjustedCapturedAt],
  ] as const) {
    validateShadowSession(session);
    requireIntegrity(
      session.date === a.predecessorDate &&
        session.previousSessionDate === original.source.previousSessionDate &&
        session.sourceHash === sourceHash &&
        session.sourceCollectedAt === clock &&
        session.codeVersion === a.codeVersion &&
        session.configHash === registry.configHash,
    );
  }
  requireIntegrity(input.targetSessions.length === 2);
  for (const [i, session] of input.targetSessions.entries()) {
    validateShadowSession(session);
    requireIntegrity(
      session.date === a.targetDates[i] &&
        session.previousSessionDate === (i === 0 ? a.predecessorDate : a.targetDates[i - 1]) &&
        session.sourceHash === a.adjustedBasisHash &&
        session.sourceCollectedAt === a.adjustedCapturedAt &&
        session.codeVersion === a.codeVersion &&
        session.configHash === registry.configHash &&
        !Object.hasOwn(session, "warmupRows"),
    );
    const expected = {
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
      predecessorHash: input.completed.hash,
    };
    requireIntegrity(
      same((session as unknown as Record<string, unknown>)["lateRecovery"], expected),
    );
  }
  const baselineRestored = restoredInput(input.baselineSession, original),
    adjustedRestored = restoredInput(input.adjustedSession, original);
  const checks = {
    baselineStrict: equivalentCompletedKospiShadow(
      input.baselineSession,
      original,
      prior,
      registry.initializedDate,
    ),
    adjustedStrict: equivalentCompletedKospiShadow(
      input.adjustedSession,
      original,
      prior,
      registry.initializedDate,
    ),
    baselinePriorityRestoredStrict: equivalentCompletedKospiShadow(
      baselineRestored,
      original,
      prior,
      registry.initializedDate,
    ),
    adjustedPriorityRestoredStrict: equivalentCompletedKospiShadow(
      adjustedRestored,
      original,
      prior,
      registry.initializedDate,
    ),
    originalReplayEqual: false,
    baselineReplayCacheOnly: false,
    adjustedReplayCacheOnly: false,
    originalContinuationComplete: false,
    baselineContinuationEqual: false,
    adjustedContinuationEqual: false,
  };
  // Use incoming baseline order only after the unchanged guard proves its restored input equivalent.
  const restoredPrerequisites =
    checks.baselinePriorityRestoredStrict && checks.adjustedPriorityRestoredStrict;
  const originalReplay: Replay = restoredPrerequisites
    ? await replay(
        {
          ...clone(original.source),
          rows: baselineRestored.rows.map((r) => clone(original.state.previousRows[r.symbol]!)),
        },
        prior,
      )
    : { payload: null, hash: null, error: false };
  const replays = {
    original: originalReplay,
    baseline: await replay(input.baselineSession, prior),
    adjusted: await replay(input.adjustedSession, prior),
  };
  checks.originalReplayEqual =
    !!replays.original.payload && same(comparison(replays.original.payload), comparison(original));
  checks.baselineReplayCacheOnly =
    !!replays.baseline.payload &&
    same(comparison(restoreCache(replays.baseline.payload, original)), comparison(original));
  checks.adjustedReplayCacheOnly =
    !!replays.adjusted.payload &&
    same(comparison(restoreCache(replays.adjusted.payload, original)), comparison(original));
  const empty = (): Continuation => ({
    snapshots: [],
    projections: [],
    snapshotHashes: [],
    projectionHashes: [],
    error: false,
  });
  const continuations = {
    original: empty(),
    baseline: empty(),
    adjusted: empty(),
  };
  const boundaryEligible =
    !checks.adjustedStrict &&
    checks.baselinePriorityRestoredStrict &&
    checks.adjustedPriorityRestoredStrict &&
    checks.originalReplayEqual &&
    checks.baselineReplayCacheOnly &&
    checks.adjustedReplayCacheOnly;
  if (boundaryEligible) {
    continuations.original = await continueInMemory(input, original);
    continuations.baseline = await continueInMemory(input, replays.baseline.payload!);
    continuations.adjusted = await continueInMemory(input, replays.adjusted.payload!);
    checks.originalContinuationComplete =
      !continuations.original.error &&
      continuations.original.snapshots.length === 2 &&
      continuations.original.projections.length === 2;
    checks.baselineContinuationEqual =
      checks.originalContinuationComplete &&
      !continuations.baseline.error &&
      same(continuations.original.snapshots, continuations.baseline.snapshots) &&
      same(continuations.original.projections, continuations.baseline.projections);
    checks.adjustedContinuationEqual =
      checks.originalContinuationComplete &&
      !continuations.adjusted.error &&
      same(continuations.original.snapshots, continuations.adjusted.snapshots) &&
      same(continuations.original.projections, continuations.adjusted.projections);
  }
  requireIntegrity(inputHash === (await hashSeriesValue(input)));
  const passed =
    boundaryEligible &&
    checks.originalContinuationComplete &&
    checks.baselineContinuationEqual &&
    checks.adjustedContinuationEqual;
  return {
    version: "kospi-priority-continuation-v1",
    mode: "PRIORITY_ONLY_PREDECESSOR_CONTINUATION",
    status: passed
      ? ("PROVEN_PRIORITY_ONLY_CONTINUATION" as const)
      : ("BLOCKED_PRIORITY_ONLY_CONTINUATION" as const),
    operationalApproval: false as const,
    historicalAvailabilityClaim: false as const,
    strictAcceptanceGuardUnchanged: true,
    inputHash,
    authority: clone(a),
    capturedReferences: Object.fromEntries(
      (["registry", "completed", "predecessor", "originalView"] as const).map((k) => [
        k,
        input[k] ? { path: input[k]!.path, hash: input[k]!.hash } : null,
      ]),
    ),
    inputSessionHashes: {
      baseline: await hashSeriesValue(input.baselineSession),
      adjusted: await hashSeriesValue(input.adjustedSession),
      targets: await Promise.all(input.targetSessions.map(hashSeriesValue)),
    },
    checks,
    replays,
    continuations,
  };
}
