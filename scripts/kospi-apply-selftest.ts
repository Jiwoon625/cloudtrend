import assert from "node:assert/strict";
import { input as fixture } from "./kospi-apply-fixture";
import { prepareKospiFinalRetrospective } from "./kospi-final-retrospective-preparation";
import {
  applyPreparedKospiRetrospective,
  type ApplyKospiRetrospectiveInput,
  type KospiRecoveryPreparationReceipt,
  type KospiRetrospectiveApproval,
} from "./kospi-final-retrospective-apply";
import { hashSeriesValue, canonicalSeriesJson } from "../src/lib/ledger/modelSeries";
import { KOSPI_SHADOW_NAMESPACE, type ShadowObjectStore } from "../src/lib/kospiShadowStore";
import { KOSPI_SHADOW_CORRECTION_REVISION_ID } from "../src/lib/kospiShadowSeries";

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
function makeStore() {
  const values = new Map(capturedObjects.map((v) => [v.path, structuredClone(v.payload)]));
  const writes: string[] = [];
  let fault: {
    kind: "IMMUTABLE" | "PROJECTION";
    mode: "BEFORE" | "AFTER";
    trigger: number;
  } | null = null;
  let calls = 0;
  const write = async (kind: "IMMUTABLE" | "PROJECTION", p: string, v: unknown) => {
    calls++;
    const fail = fault && fault.kind === kind && fault.trigger === calls;
    if (fail && fault?.mode === "BEFORE") throw new Error("synthetic rejected before commit");
    if (kind === "IMMUTABLE" && values.has(p)) throw new Error("immutable collision");
    values.set(p, structuredClone(v));
    writes.push(p);
    if (fail && fault?.mode === "AFTER") throw new Error("synthetic uncertain after commit");
  };
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
    putImmutable: (p, v) => write("IMMUTABLE", p, v),
    putLatest: (p, v) => write("PROJECTION", p, v),
  };
  const args: ApplyKospiRetrospectiveInput = {
    store,
    preparationReceipt: structuredClone(receipt),
    approval: structuredClone(approval),
    authoritativePreparationHash: preparationHash,
    authoritativeApprovalHash: approvalHash,
    approvedRuntimeCodeHash: fixture.authority.runtimeCodeHash,
    assertExclusiveWriter: async (scope) => {
      assert.equal(scope.owner, fixture.authority.owner);
      assert.equal(scope.namespace, rev);
      assert.equal(scope.requiredConcurrencyGroup, "kospi-prospective-shadow");
    },
  };
  return {
    values,
    writes,
    store,
    args,
    setFault: (f: typeof fault) => {
      fault = f;
    },
  };
}
let tests = 0;
const first = makeStore(),
  before = canonicalSeriesJson([...first.values]);
const out = await applyPreparedKospiRetrospective(first.args);
assert.equal(out.status, "VERIFIED");
assert.equal(out.verifiedWriteCount, 4);
assert.equal(first.writes.length, 4);
assert.equal(out.alreadyCompletedCount, 0);
for (const [p, v] of capturedObjects.map((x) => [x.path, x.payload] as const))
  if (p !== rev + "/latest.json")
    assert.equal(canonicalSeriesJson(first.values.get(p)), canonicalSeriesJson(v));
const second = await applyPreparedKospiRetrospective(first.args);
assert.equal(second.verifiedWriteCount, 0);
assert.equal(second.alreadyCompletedCount, 2);
assert.equal(first.writes.length, 4);
tests += 2;
for (const [kind, trigger] of [
  ["IMMUTABLE", 1],
  ["PROJECTION", 2],
  ["IMMUTABLE", 3],
  ["PROJECTION", 4],
] as const) {
  for (const mode of ["BEFORE", "AFTER"] as const) {
    const f = makeStore();
    f.setFault({ kind, mode, trigger });
    if (mode === "BEFORE")
      await assert.rejects(() => applyPreparedKospiRetrospective(f.args), /UNCERTAIN/);
    else assert.equal((await applyPreparedKospiRetrospective(f.args)).status, "VERIFIED");
    f.setFault(null);
    const recovered = await applyPreparedKospiRetrospective(f.args);
    assert.equal(recovered.status, "VERIFIED");
    assert.equal(f.writes.length, 4);
    tests++;
  }
}
for (const mutation of [
  (a: ApplyKospiRetrospectiveInput) => {
    a.authoritativeApprovalHash = "sha256:" + "0".repeat(64);
  },
  (a: ApplyKospiRetrospectiveInput) => {
    a.authoritativePreparationHash = "sha256:" + "0".repeat(64);
  },
  (a: ApplyKospiRetrospectiveInput) => {
    a.approvedRuntimeCodeHash = "sha256:" + "0".repeat(64);
  },
  (a: ApplyKospiRetrospectiveInput) => {
    a.approval.owner = "00000000-0000-0000-0000-000000000002";
  },
  (a: ApplyKospiRetrospectiveInput) => {
    a.preparationReceipt.kospi.result.snapshots[0]!.state.cashKrw += 1;
  },
]) {
  const f = makeStore();
  mutation(f.args);
  await assert.rejects(() => applyPreparedKospiRetrospective(f.args));
  assert.equal(f.writes.length, 0);
  tests++;
}
const altered = makeStore();
const p = rev + "/sessions/2026-10-23.json";
const v = structuredClone(altered.values.get(p)) as {
  state: { cashKrw: number };
};
v.state.cashKrw += 1;
altered.values.set(p, v);
await assert.rejects(() => applyPreparedKospiRetrospective(altered.args), /PREFIX_CHANGED/);
assert.equal(altered.writes.length, 0);
tests++;
const notExclusive = makeStore();
notExclusive.args.assertExclusiveWriter = async () => {
  throw new Error("synthetic workflow exclusion not admitted");
};
await assert.rejects(() => applyPreparedKospiRetrospective(notExclusive.args), /exclusion/);
assert.equal(notExclusive.writes.length, 0);
tests++;
const collision = makeStore();
collision.values.set(rev + "/sessions/2026-10-26.json", { different: true });
await assert.rejects(() => applyPreparedKospiRetrospective(collision.args));
assert.equal(collision.writes.length, 0);
tests++;
const skipped = makeStore();
skipped.values.set(rev + "/sessions/2026-10-27.json", prepared.snapshots[1]);
await assert.rejects(() => applyPreparedKospiRetrospective(skipped.args));
assert.equal(skipped.writes.length, 0);
tests++;
const newer = makeStore();
newer.values.set(rev + "/sessions/2026-10-28.json", prepared.snapshots[1]);
await assert.rejects(() => applyPreparedKospiRetrospective(newer.args));
assert.equal(newer.writes.length, 0);
tests++;
// Lost readback must stop this invocation, leaving only the exact immutable append.
const lost = makeStore();
const realRead = lost.store.read.bind(lost.store);
const realPut = lost.store.putImmutable.bind(lost.store);
let failReadPath: string | null = null;
lost.store.putImmutable = async (path, value) => {
  await realPut(path, value);
  failReadPath = path;
};
lost.store.read = async <T>(path: string): Promise<T | null> => {
  if (path === failReadPath) {
    failReadPath = null;
    throw new Error("synthetic lost authoritative readback");
  }
  return realRead<T>(path);
};
await assert.rejects(
  () => applyPreparedKospiRetrospective(lost.args),
  /UNCERTAIN_IMMUTABLE_READBACK/,
);
assert.equal(lost.writes.length, 1);
lost.store.putImmutable = realPut;
assert.equal((await applyPreparedKospiRetrospective(lost.args)).status, "VERIFIED");
assert.equal(lost.writes.length, 4);
tests++;
assert.notEqual(before, canonicalSeriesJson([...first.values]));
console.log(
  JSON.stringify({
    syntheticApplyTests: tests,
    status: "PASS",
    realOperationalWrites: 0,
    networkOrPrivateReads: false,
  }),
);
