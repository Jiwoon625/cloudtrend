/** Pure, private preparation only. No network, filesystem, credentials or operational writes. */
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { ScoringConfig } from "../src/lib/engine/scoring";
import { buildKospiShadowSession } from "../src/lib/engine/kospiShadowDataset";
import {
  KOSPI_SHADOW_POLICY,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "../src/lib/engine/kospiShadow";
import { equivalentCompletedKospiShadow } from "../src/lib/kospiShadowEquivalence";
import {
  KOSPI_SHADOW_NAMESPACE,
  persistKospiShadow,
  shadowObjectPath,
  type KospiShadowView,
  type ShadowObjectStore,
} from "../src/lib/kospiShadowStore";
import {
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
  openKospiShadowRevisionStore,
} from "../src/lib/kospiShadowSeries";
import { canonicalSeriesJson, hashSeriesValue } from "../src/lib/ledger/modelSeries";
import { nextKrRegularSession } from "../src/lib/ledger/krShadowDecision";

export interface KospiFinalPreparationAuthority {
  owner: string;
  predecessorDate: string;
  targetDates: string[];
  baselineSourceHash: string;
  adjustedBasisHash: string;
  sourceManifestHash: string;
  captureManifestHash: string;
  baselineCollectedAt: string;
  adjustedCapturedAt: string;
  computedAt: string;
  codeVersion: string;
  runtimeCodeHash: string;
}
export interface KospiFinalPreparationInput {
  baselineDataset: MarketDataset;
  adjustedDataset: MarketDataset;
  scoringConfig: ScoringConfig;
  authority: KospiFinalPreparationAuthority;
  /** Materializer must obtain these from the exact owner-private authoritative Storage paths. */
  objects: Record<string, { hash: string; payload: unknown }>;
}
const equal = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const clone = <T>(v: T): T => structuredClone(v);
const validHash = (v: unknown): v is string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
const validDate = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v + "T00:00:00Z")) &&
  new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
function timestamp(v: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) ||
    !validDate(v.slice(0, 10)) ||
    !Number.isFinite(Date.parse(v))
  )
    throw new Error("Invalid actual preparation timestamp");
  return Date.parse(v);
}
/** Drop exactly transport provenance; row order and every economic/intent field remain binding. */
export function kospiEconomicSession(s: KospiShadowSession) {
  const { sourceHash: _s, sourceCollectedAt: _c, codeVersion: _v, ...rest } = s;
  return rest;
}
export async function compareKospiSessions(a: KospiShadowSession, b: KospiShadowSession) {
  const left = kospiEconomicSession(a),
    right = kospiEconomicSession(b);
  return {
    equalExceptTransportProvenance: equal(left, right),
    baselineEconomicHash: await hashSeriesValue(left),
    adjustedEconomicHash: await hashSeriesValue(right),
    baselineRowCount: a.rows.length,
    adjustedRowCount: b.rows.length,
  };
}
function memoryStore(initial: Record<string, unknown>) {
  const values = new Map(Object.entries(clone(initial)));
  const writes: Array<{ kind: "IMMUTABLE" | "PROJECTION"; path: string }> = [];
  const store: ShadowObjectStore = {
    read: async <T>(path: string) => clone(values.get(path) ?? null) as T | null,
    latestSessionDate: async (root) =>
      [...values.keys()]
        .filter((p) => p.startsWith(root + "/"))
        .map((p) => p.slice(root.length + 1))
        .filter((p) => /^\d{4}-\d{2}-\d{2}\.json$/.test(p))
        .map((p) => p.slice(0, -5))
        .sort()
        .at(-1) ?? null,
    putImmutable: async (path, value) => {
      if (values.has(path) && !equal(values.get(path), value))
        throw new Error("Preparation immutable collision");
      if (!values.has(path)) {
        values.set(path, clone(value));
        writes.push({ kind: "IMMUTABLE", path });
      }
    },
    putLatest: async (path, value) => {
      values.set(path, clone(value));
      writes.push({ kind: "PROJECTION", path });
    },
  };
  return { store, values, writes };
}
function chainPaths(
  objects: Record<string, unknown>,
  root: string,
  latestDate: string,
  initializedDate: string,
) {
  const paths: string[] = [];
  let date = latestDate;
  while (true) {
    if (!validDate(date) || date < initializedDate || paths.length > 10000)
      throw new Error("Invalid preparation journal chain");
    const path = `${root}/sessions/${date}.json`;
    const value = objects[path] as KospiShadowSnapshot | undefined;
    if (!value || value.source?.date !== date)
      throw new Error("Missing preparation journal snapshot");
    paths.push(path);
    if (date === initializedDate) break;
    const prior = value.source.previousSessionDate;
    if (!prior || prior >= date) throw new Error("Invalid preparation predecessor chain");
    date = prior;
  }
  return paths.reverse();
}

export async function prepareKospiFinalRetrospective(input: KospiFinalPreparationInput) {
  const a = input.authority;
  if (
    !a ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(a.owner) ||
    !validDate(a.predecessorDate) ||
    !Array.isArray(a.targetDates) ||
    a.targetDates.length < 1 ||
    a.targetDates.length > 2
  )
    throw new Error("Invalid bounded preparation authority");
  let previous = a.predecessorDate;
  for (const date of a.targetDates) {
    if (!validDate(date) || nextKrRegularSession(previous) !== date)
      throw new Error("Exact next-session preparation dates required");
    previous = date;
  }
  if (
    ![
      a.baselineSourceHash,
      a.adjustedBasisHash,
      a.sourceManifestHash,
      a.captureManifestHash,
      a.runtimeCodeHash,
    ].every(validHash) ||
    !/^[a-f0-9]{40}$/.test(a.codeVersion)
  )
    throw new Error("Preparation provenance hashes required");
  const baseTime = timestamp(a.baselineCollectedAt),
    captureTime = timestamp(a.adjustedCapturedAt),
    computed = timestamp(a.computedAt);
  if (
    captureTime < baseTime ||
    computed < captureTime ||
    baseTime < Date.parse(a.targetDates.at(-1)! + "T06:30:00Z")
  )
    throw new Error("Actual final-source and capture clocks required");
  if (
    input.baselineDataset.asOfDate !== a.targetDates.at(-1) ||
    input.adjustedDataset.asOfDate !== input.baselineDataset.asOfDate ||
    !input.baselineDataset.isLive ||
    !input.adjustedDataset.isLive
  )
    throw new Error("Exact approved final analytical horizon required");
  const originalRoot = `${a.owner}/${KOSPI_SHADOW_NAMESPACE}`;
  const revisionRoot = `${originalRoot}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
  const allowed = new RegExp(
    `^(${originalRoot}|${revisionRoot})/(registry\\.json|latest\\.json|sessions/\\d{4}-\\d{2}-\\d{2}\\.json)$`,
  );
  const originals: Record<string, unknown> = {};
  const inputObjectHashes: Record<string, string> = {};
  for (const [path, item] of Object.entries(input.objects)) {
    if (
      !(allowed.test(path) || path === revisionRoot + "/revision.json") ||
      !validHash(item.hash) ||
      (await hashSeriesValue(item.payload)) !== item.hash
    )
      throw new Error("Preparation private object identity mismatch");
    originals[path] = clone(item.payload);
    inputObjectHashes[path] = item.hash;
  }
  const originalView = originals[originalRoot + "/latest.json"] as KospiShadowView;
  const view = originals[revisionRoot + "/latest.json"] as KospiShadowView;
  if (
    !originalView ||
    !view ||
    view.latest.source.date !== a.predecessorDate ||
    view.latest.state.lastDate !== a.predecessorDate
  )
    throw new Error("Preparation requires exact unadvanced authoritative predecessor");
  const originalChain = chainPaths(
    originals,
    originalRoot,
    originalView.latest.source.date,
    originalView.registry.initializedDate,
  );
  const revisionChain = chainPaths(
    originals,
    revisionRoot,
    a.predecessorDate,
    view.registry.initializedDate,
  );
  const expectedPaths = [
    originalRoot + "/registry.json",
    originalRoot + "/latest.json",
    revisionRoot + "/revision.json",
    revisionRoot + "/registry.json",
    revisionRoot + "/latest.json",
    ...originalChain,
    ...revisionChain,
  ].sort();
  if (!equal(Object.keys(originals).sort(), expectedPaths))
    throw new Error("Preparation object inventory contains missing or orphan snapshots");
  const memory = memoryStore(originals);
  const revision = await openKospiShadowRevisionStore(memory.store, a.owner);
  const config = { policy: KOSPI_SHADOW_POLICY, scoring: input.scoringConfig };
  const configHash = await hashSeriesValue(config);
  if (configHash !== view.registry.configHash || !equal(config, view.registry.config))
    throw new Error("Frozen KOSPI policy/config differs");
  const build = (dataset: MarketDataset, date: string, adjusted: boolean) =>
    buildKospiShadowSession(
      dataset,
      input.scoringConfig,
      {
        sourceHash: adjusted ? a.adjustedBasisHash : a.baselineSourceHash,
        configHash,
        codeVersion: a.codeVersion,
        sourceCollectedAt: adjusted ? a.adjustedCapturedAt : a.baselineCollectedAt,
        now: a.computedAt,
      },
      date,
    );
  const comparisons = [];
  const prepared = new Map<string, KospiShadowSession>();
  for (const date of [a.predecessorDate, ...a.targetDates]) {
    const baseline = build(input.baselineDataset, date, false),
      adjusted = build(input.adjustedDataset, date, true);
    comparisons.push({
      date,
      ...(await compareKospiSessions(baseline, adjusted)),
    });
    prepared.set(date, adjusted);
  }
  const priorDate = view.latest.source.previousSessionDate;
  const predecessor = priorDate
    ? (originals[`${revisionRoot}/sessions/${priorDate}.json`] as KospiShadowSnapshot)
    : null;
  const baselineBoundary = equivalentCompletedKospiShadow(
    build(input.baselineDataset, a.predecessorDate, false),
    view.latest,
    predecessor,
    view.registry.initializedDate,
  );
  const adjustedBoundary = equivalentCompletedKospiShadow(
    prepared.get(a.predecessorDate)!,
    view.latest,
    predecessor,
    view.registry.initializedDate,
  );
  const common = {
    version: "kospi-final-retrospective-preparation-v1",
    operationalApproval: false as const,
    historicalAvailabilityClaim: false as const,
    retrospective: true,
    resetCapital: false,
    authority: clone(a),
    inputObjectHashes,
    baselineBoundaryEquivalent: baselineBoundary,
    adjustedBoundaryEquivalent: adjustedBoundary,
    comparisons,
  };
  // Never silently bridge revised predecessor signals into the immutable model accounting state.
  if (!adjustedBoundary)
    return {
      ...common,
      status: "BLOCKED_ADJUSTED_PREDECESSOR_MISMATCH" as const,
      plan: null,
    };
  const predecessorHash = await hashSeriesValue(view.latest);
  const sessions = [];
  const snapshots = [];
  for (const date of a.targetDates) {
    const source = prepared.get(date)!;
    const session = Object.assign(source, {
      lateRecovery: {
        version: "kospi-final-retrospective-v1",
        historicalAvailabilityClaim: false as const,
        retrospective: true,
        sourceDataAsOf: input.adjustedDataset.asOfDate,
        sourceCollectedAt: a.baselineCollectedAt,
        captureObservedAt: a.adjustedCapturedAt,
        computedAt: a.computedAt,
        sourceManifestHash: a.sourceManifestHash,
        captureManifestHash: a.captureManifestHash,
        adjustedBasisHash: a.adjustedBasisHash,
        runtimeCodeHash: a.runtimeCodeHash,
        predecessorDate: a.predecessorDate,
        predecessorHash,
      },
    });
    sessions.push(clone(session));
    const result = await persistKospiShadow(revision, a.owner, session, config);
    snapshots.push(clone(result.view.latest));
  }
  const verified = await openKospiShadowRevisionStore(memory.store, a.owner);
  const final = await verified.read<KospiShadowView>(shadowObjectPath(a.owner, "latest.json"));
  if (!final || final.latest.source.date !== a.targetDates.at(-1))
    throw new Error("Preparation final projection mismatch");
  for (const [path, value] of Object.entries(originals)) {
    if (path !== revisionRoot + "/latest.json" && !equal(memory.values.get(path), value))
      throw new Error("Preparation mutated immutable original prefix");
  }
  const permittedAppends = new Set(a.targetDates.map((d) => `${revisionRoot}/sessions/${d}.json`));
  if (
    memory.writes.some((w) =>
      w.kind === "IMMUTABLE"
        ? !permittedAppends.has(w.path)
        : w.path !== revisionRoot + "/latest.json",
    ) ||
    memory.writes.filter((w) => w.kind === "IMMUTABLE").length !== a.targetDates.length
  )
    throw new Error("Preparation write-set escape");
  const plan = {
    version: "kospi-final-retrospective-plan-v1",
    authority: clone(a),
    predecessorHash,
    prefixHashes: inputObjectHashes,
    configHash,
    sessions,
    snapshotHashes: await Promise.all(snapshots.map(hashSeriesValue)),
    finalProjectionHash: await hashSeriesValue(final),
    immutablePrefixPreserved: true,
    writeSet: memory.writes,
    historicalAvailabilityClaim: false as const,
    resetCapital: false,
  };
  return {
    ...common,
    status: "PREPARED_FOR_INDEPENDENT_REVIEW" as const,
    planHash: await hashSeriesValue(plan),
    plan,
    snapshots,
    finalProjection: final,
  };
}
