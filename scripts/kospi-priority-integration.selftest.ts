/** Synthetic genuine-engine integration: no credentials, network or real stores. */
import assert from "node:assert/strict";
import { input as fixture } from "./kospi-apply-fixture";
import {
  prepareKospiFinalRetrospective,
  compareKospiSessions,
} from "./kospi-final-retrospective-preparation";
import {
  proveKospiPriorityContinuation,
  projectKospiPriorityReference,
} from "./kospi-priority-continuation";
import { publicComputationPhase } from "./kr-vintage-preflight/phases";
import { verifyKospiPriorityAdmission } from "./kospi-priority-admission";
import { diagnoseKospiCompletedBoundary } from "./kospi-boundary-diagnostic";
import { verifyPreparationKospiBoundary } from "./kr-adjusted-recovery/verify";
import {
  applyPreparedKospiRetrospective,
  kospiRetrospectiveApprovalCandidate,
  type ApplyKospiRetrospectiveInput,
} from "./kospi-final-retrospective-apply";
import { hashSeriesValue, canonicalSeriesJson } from "../src/lib/ledger/modelSeries";
import {
  kospiShadowRevisionPath,
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
} from "../src/lib/kospiShadowSeries";
import {
  shadowObjectPath,
  type ShadowObjectStore,
  type KospiShadowView,
  type KospiShadowRegistry,
} from "../src/lib/kospiShadowStore";
import type { KospiShadowSnapshot } from "../src/lib/engine/kospiShadow";
const clone = <T>(v: T): T => structuredClone(v);
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const strict = await prepareKospiFinalRetrospective(fixture);
if (strict.status !== "PREPARED_FOR_INDEPENDENT_REVIEW") throw Error("Strict fixture blocked");
const owner = fixture.authority.owner,
  path = (s: string) => kospiShadowRevisionPath(owner, s);
const get = <T>(suffix: string) => ({
  path: path(suffix),
  hash: fixture.objects[path(suffix)]!.hash,
  payload: clone(fixture.objects[path(suffix)]!.payload as T),
});
const completed = get<KospiShadowSnapshot>("sessions/2026-10-23.json"),
  predecessor = get<KospiShadowSnapshot>("sessions/2026-10-22.json"),
  registry = get<KospiShadowRegistry>("registry.json"),
  originalView = get<KospiShadowView>("latest.json");
const baselineSession = clone(strict.boundaryDiagnostic.sessions.baseline.payload),
  adjustedSession = clone(strict.boundaryDiagnostic.sessions.adjusted.payload);
const active = new Set(
  [
    ...predecessor.payload.state.awaiting,
    ...predecessor.payload.state.pendingEntries,
    ...Object.values(predecessor.payload.state.positions).map((x) => x.candidate),
    ...completed.payload.candidates,
  ].map((x) => x.symbol),
);
const row = adjustedSession.rows.find((x) => !active.has(x.symbol));
assert.ok(row);
row.priority = (row.priority ?? 0) + 1;
const proof = await proveKospiPriorityContinuation({
  authority: strict.authority,
  registry,
  completed,
  predecessor,
  originalView,
  baselineSession,
  adjustedSession,
  targetSessions: strict.targetSessions,
});
assert.equal(proof.status, "PROVEN_PRIORITY_ONLY_CONTINUATION");
const prepared = clone(strict);
prepared.adjustedBoundaryEquivalent = false;
prepared.boundaryDiagnostic = await diagnoseKospiCompletedBoundary({
  baselineSession,
  adjustedSession,
  registry,
  completed,
  predecessor,
  guardResults: { baseline: true, adjusted: false },
});
prepared.comparisons[0] = {
  date: fixture.authority.predecessorDate,
  ...(await compareKospiSessions(baselineSession, adjustedSession)),
};
prepared.priorityContinuation = proof;
prepared.priorityContinuationHash = await hashSeriesValue(proof);
prepared.plan.boundaryAdmission = {
  mode: "PRIORITY_ONLY_PREDECESSOR_CONTINUATION",
  proofHash: prepared.priorityContinuationHash,
};
prepared.planHash = await hashSeriesValue(prepared.plan);
const descriptor = fixture.objects[path("revision.json")]!.payload as Record<string, unknown>;
const oldApproval = Object.fromEntries(
  [
    "revisionId",
    "predecessorDate",
    "correctionDate",
    "expectedPredecessorHash",
    "expectedOriginalTargetHash",
  ].map((k) => [k, descriptor[k]]),
);
oldApproval.expectedCorrectedSourceHash = descriptor.correctedSourceHash;
// Production capture envelopes retain transport evidence; they are not semantic proof refs.
// Field names were independently checked against a saved real receipt; values here are synthetic.
const transportEvidence = {
  byteHash: "sha256:" + "e".repeat(64),
  metadata: {
    id: "synthetic-object",
    version: "synthetic-version",
    eTag: "synthetic-etag",
    size: 100,
    updatedAt: "2026-10-28T00:00:00Z",
  },
  stateHashPreapproved: false,
};
const capturedObjects = [
  ...Object.entries(fixture.objects).map(([p, v]) => ({ path: p, ...clone(v) })),
  {
    path:
      shadowObjectPath(owner, "registry.json").slice(0, -"registry.json".length) +
      `correction-approvals/${KOSPI_SHADOW_CORRECTION_REVISION_ID}.json`,
    hash: await hashSeriesValue(oldApproval),
    payload: oldApproval,
  },
].map((reference) => ({ ...reference, ...clone(transportEvidence) }));
const capturedBefore = clone(capturedObjects);
await verifyKospiPriorityAdmission(prepared, capturedObjects);
assert.ok(same(capturedObjects, capturedBefore));
const receipt = {
  version: "kr-adjusted-recovery-preparation-v1" as const,
  kind: "RECOVERY_PREPARATION_ONLY" as const,
  operationalApproval: false as const,
  historicalAvailabilityClaim: false as const,
  kospi: { capturedObjects, result: prepared },
};
const preparationHash = await hashSeriesValue(receipt),
  approval = kospiRetrospectiveApprovalCandidate(preparationHash, prepared);
assert.equal(approval.version, "kospi-priority-continuation-approval-v1");
let tests = 1;
const invalidMode = clone(strict);
(invalidMode.plan.boundaryAdmission as { mode: string }).mode = "UNKNOWN";
assert.throws(() => kospiRetrospectiveApprovalCandidate(preparationHash, invalidMode));
const invalidHash = clone(prepared);
invalidHash.plan.boundaryAdmission = {
  mode: "PRIORITY_ONLY_PREDECESSOR_CONTINUATION",
  proofHash: "sha256:bad",
};
invalidHash.priorityContinuationHash = "sha256:bad";
assert.throws(() => kospiRetrospectiveApprovalCandidate(preparationHash, invalidHash));
tests += 2;
function make() {
  const values = new Map(capturedObjects.map((x) => [x.path, clone(x.payload)]));
  const writes: string[] = [];
  let calls = 0,
    fault: { n: number; after: boolean } | null = null;
  const write = async (p: string, v: unknown, immutable: boolean) => {
    const hit = ++calls === fault?.n;
    if (hit && !fault?.after) throw Error("synthetic before");
    if (immutable && values.has(p)) throw Error("collision");
    values.set(p, clone(v));
    writes.push(p);
    if (hit) throw Error("synthetic after");
  };
  const store: ShadowObjectStore = {
    read: async <T>(p: string) => clone(values.get(p) ?? null) as T | null,
    latestSessionDate: async (root) =>
      [...values.keys()]
        .filter((p) => p.startsWith(root + "/"))
        .map((p) => p.slice(root.length + 1))
        .filter((p) => /^\d{4}-\d{2}-\d{2}\.json$/.test(p))
        .sort()
        .at(-1)
        ?.slice(0, -5) ?? null,
    putImmutable: (p, v) => write(p, v, true),
    putLatest: (p, v) => write(p, v, false),
  };
  const args: ApplyKospiRetrospectiveInput = {
    store,
    preparationReceipt: clone(receipt),
    approval: clone(approval),
    authoritativePreparationHash: preparationHash,
    authoritativeApprovalHash: "",
    approvedRuntimeCodeHash: fixture.authority.runtimeCodeHash,
    assertExclusiveWriter: async () => {},
  };
  return { values, writes, args, setFault: (v: typeof fault) => (fault = v) };
}
async function repin(a: ApplyKospiRetrospectiveInput) {
  const p = a.preparationReceipt.kospi.result;
  p.planHash = await hashSeriesValue(p.plan);
  a.authoritativePreparationHash = await hashSeriesValue(a.preparationReceipt);
  a.approval.preparationHash = a.authoritativePreparationHash;
  a.approval.planHash = p.planHash;
  if (a.approval.version === "kospi-priority-continuation-approval-v1")
    a.approval.boundaryProofHash = p.priorityContinuationHash ?? "sha256:" + "0".repeat(64);
  a.authoritativeApprovalHash = await hashSeriesValue(a.approval);
}
const fresh = make();
await repin(fresh.args);
assert.equal((await applyPreparedKospiRetrospective(fresh.args)).status, "VERIFIED");
assert.equal(fresh.writes.length, 4);
assert.ok(same(fresh.values.get(completed.path), completed.payload));
assert.equal((await applyPreparedKospiRetrospective(fresh.args)).verifiedWriteCount, 0);
tests++;
for (const n of [1, 2, 3, 4])
  for (const after of [false, true]) {
    const f = make();
    await repin(f.args);
    f.setFault({ n, after });
    if (after) assert.equal((await applyPreparedKospiRetrospective(f.args)).status, "VERIFIED");
    else await assert.rejects(() => applyPreparedKospiRetrospective(f.args));
    f.setFault(null);
    assert.equal((await applyPreparedKospiRetrospective(f.args)).status, "VERIFIED");
    assert.equal(f.writes.length, 4);
    assert.ok(same(f.values.get(completed.path), completed.payload));
    tests++;
  }
for (const mode of [
  "strict",
  "proof",
  "missing",
  "strictFlag",
  "targetTime",
  "targetOrder",
  "targetMissing",
  "targetPriority",
  "pendingEconomic",
  "priorCash",
  "outputBody",
  "outputHash",
  "projection",
  "targetMetadata",
]) {
  const f = make(),
    p = f.args.preparationReceipt.kospi.result;
  if (mode === "proof")
    p.priorityContinuation = {
      ...p.priorityContinuation!,
      status: "PROVEN_PRIORITY_ONLY_CONTINUATION",
      invented: true,
    } as typeof p.priorityContinuation;
  if (mode === "missing") p.priorityContinuation = null;
  if (mode === "strictFlag") p.adjustedBoundaryEquivalent = true;
  if (mode === "targetTime") p.targetSessions[0]!.sourceCollectedAt = "2026-10-29T00:00:00Z";
  if (mode === "targetOrder") p.targetSessions.reverse();
  if (mode === "targetMissing") p.targetSessions.pop();
  if (mode === "targetPriority") p.targetSessions[0]!.rows[0]!.priority = 123456;
  if (mode === "targetMetadata")
    p.targetSessions[0]!.lateRecovery!.captureObservedAt = "2026-10-29T00:00:00Z";
  if (mode === "outputBody") p.snapshots[0]!.state.totalFeesKrw += 1;
  if (mode === "outputHash") p.plan.snapshotHashes[0] = `sha256:${"0".repeat(64)}`;
  if (mode === "projection") p.finalProjection.latest.state.cashKrw += 1;
  if (mode === "pendingEconomic")
    p.boundaryDiagnostic.sessions.adjusted.payload.benchmarkClose += 1;
  if (mode === "priorCash") {
    const prior = f.args.preparationReceipt.kospi.capturedObjects.find(
      (x) => x.path === predecessor.path,
    )!;
    (prior.payload as KospiShadowSnapshot).state.cashKrw += 1;
    prior.hash = await hashSeriesValue(prior.payload);
    p.inputObjectHashes[prior.path] = prior.hash;
  }
  if (p.priorityContinuation) {
    p.priorityContinuationHash = await hashSeriesValue(p.priorityContinuation);
    p.plan.boundaryAdmission = {
      mode: "PRIORITY_ONLY_PREDECESSOR_CONTINUATION",
      proofHash: p.priorityContinuationHash,
    };
  }
  await repin(f.args);
  if (mode === "strict") {
    const {
      boundaryMode: _m,
      boundaryProofHash: _h,
      ...rest
    } = f.args.approval as Extract<
      typeof approval,
      { version: "kospi-priority-continuation-approval-v1" }
    >;
    f.args.approval = { ...rest, version: "kospi-final-retrospective-approval-v1" };
    f.args.authoritativeApprovalHash = await hashSeriesValue(f.args.approval);
  }
  await assert.rejects(() => applyPreparedKospiRetrospective(f.args));
  assert.equal(f.writes.length, 0);
  tests++;
}
// End-to-end DATASET branch, not a hand-assembled prepared success or mocked engine.
const realInput = clone(fixture);
const instrument = realInput.adjustedDataset.instruments.find((x) => x.symbol === row.symbol)!;
assert.ok(instrument && instrument.market === "KOSPI");
assert.notEqual(instrument.indexMembershipsKnown, false);
const priorityIndexes = new Set(["KOSPI200", "KOSDAQ150", "KRX300"]);
const wasMember = instrument.indexMemberships.some((x) => priorityIndexes.has(x));
instrument.indexMembershipsKnown = true;
instrument.indexMemberships = wasMember
  ? instrument.indexMemberships.filter((x) => !priorityIndexes.has(x))
  : [...instrument.indexMemberships, "KOSPI200"];
const genuine = JSON.parse(JSON.stringify(await prepareKospiFinalRetrospective(realInput)));
assert.equal(genuine.status, "PREPARED_FOR_INDEPENDENT_REVIEW");
assert.equal(genuine.adjustedBoundaryEquivalent, false);
assert.equal(genuine.priorityContinuation.status, "PROVEN_PRIORITY_ONLY_CONTINUATION");
const oldRows = completed.payload.state.previousRows;
const genuineRows = genuine.boundaryDiagnostic.sessions.adjusted.payload.rows;
let changedRows = 0;
for (const r of genuineRows) {
  const old = oldRows[r.symbol]!;
  const keys = [...new Set([...Object.keys(old), ...Object.keys(r)])].filter(
    (k) => !same((old as unknown as Record<string, unknown>)[k], r[k]),
  );
  if (keys.length) {
    assert.deepEqual(keys, ["priority"]);
    changedRows++;
  }
}
assert.ok(changedRows > 0);
const a = genuine.authority;
const genuineReceipt = JSON.parse(
  JSON.stringify({
    scope: { predecessorDate: a.predecessorDate, dates: a.targetDates },
    codeCommit: a.codeVersion,
    sourceRosterHash: a.sourceManifestHash,
    captureManifestHash: a.captureManifestHash,
    candidate: { datasetHash: a.adjustedBasisHash },
    captureObservedAt: a.adjustedCapturedAt,
    preparedAt: a.computedAt,
    runtimeHashes: { kospi: a.runtimeCodeHash },
    clockSemantics: { sourceRegisteredAt: a.baselineCollectedAt },
    kospi: {
      result: genuine,
      capturedObjects,
      generationPins: capturedObjects.map((x) => ({ path: x.path, metadata: x.metadata })),
    },
  }),
);
const genuinePhases: string[] = [];
await verifyPreparationKospiBoundary(genuineReceipt, (phase) => genuinePhases.push(phase));
assert.equal(genuinePhases.at(-1), "RECEIPT_KOSPI_PRIORITY_PLAN_TARGETS");
assert.ok(genuinePhases.every((phase) => publicComputationPhase(phase) === phase));
assert.ok(same(genuineReceipt.kospi.capturedObjects, capturedBefore));
const real = make();
real.args.preparationReceipt.kospi.result = genuine;
real.args.authoritativePreparationHash = await hashSeriesValue(real.args.preparationReceipt);
real.args.approval = kospiRetrospectiveApprovalCandidate(
  real.args.authoritativePreparationHash,
  genuine,
);
real.args.authoritativeApprovalHash = await hashSeriesValue(real.args.approval);
assert.equal((await applyPreparedKospiRetrospective(real.args)).status, "VERIFIED");
assert.equal(real.writes.length, 4);
assert.ok(same(real.values.get(completed.path), completed.payload));
assert.ok(same(real.values.get(path("latest.json")), genuine.finalProjection));
tests++;
// Both producer and verifier share exactly the semantic reference projection.
assert.deepEqual(Object.keys(projectKospiPriorityReference(capturedObjects[0]!)).sort(), [
  "hash",
  "path",
  "payload",
]);
const enrichedProducerInput = clone(realInput);
for (const [objectPath, value] of Object.entries(enrichedProducerInput.objects))
  enrichedProducerInput.objects[objectPath] = { ...value, ...clone(transportEvidence) };
const enrichedProducer = JSON.parse(
  JSON.stringify(await prepareKospiFinalRetrospective(enrichedProducerInput)),
);
assert.ok(same(enrichedProducer, genuine));
await verifyKospiPriorityAdmission(enrichedProducer, capturedObjects);
tests++;
for (const kind of ["path", "hash", "payload"] as const) {
  const bad = clone(genuineReceipt);
  const reference = bad.kospi.capturedObjects.find(
    (x: { path: string }) => x.path === path("registry.json"),
  )!;
  if (kind === "path") reference.path += ".foreign";
  if (kind === "hash") reference.hash = "sha256:" + "0".repeat(64);
  if (kind === "payload") reference.payload.configHash = "sha256:" + "0".repeat(64);
  const phases: string[] = [];
  await assert.rejects(() =>
    verifyKospiPriorityAdmission(bad.kospi.result, bad.kospi.capturedObjects, (p) =>
      phases.push(p),
    ),
  );
  assert.equal(
    phases.at(-1),
    kind === "path"
      ? "RECEIPT_KOSPI_PRIORITY_REFERENCE_PATHS"
      : "RECEIPT_KOSPI_PRIORITY_REFERENCE_HASHES",
  );
  const attempt = make();
  attempt.args.preparationReceipt.kospi = bad.kospi;
  await repin(attempt.args);
  await assert.rejects(() => applyPreparedKospiRetrospective(attempt.args));
  assert.equal(attempt.writes.length, 0);
  tests++;
}
for (const kind of ["proofInputHash", "planSnapshotHash"] as const) {
  const bad = clone(genuine);
  if (kind === "proofInputHash") bad.priorityContinuation.inputHash = "sha256:" + "0".repeat(64);
  else bad.plan.snapshotHashes[0] = "sha256:" + "0".repeat(64);
  const phases: string[] = [];
  await assert.rejects(() =>
    verifyKospiPriorityAdmission(bad, capturedObjects, (p) => phases.push(p)),
  );
  assert.equal(
    phases.at(-1),
    kind === "proofInputHash"
      ? "RECEIPT_KOSPI_PRIORITY_PROOF_EQUALITY"
      : "RECEIPT_KOSPI_PRIORITY_PLAN_OUTPUTS",
  );
  tests++;
}
console.log(
  JSON.stringify({
    syntheticPriorityIntegrationTests: tests,
    status: "PASS",
    realOperationalWrites: 0,
  }),
);
