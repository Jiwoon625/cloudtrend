/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import {
  stepKospiShadow,
  KOSPI_SHADOW_POLICY,
  type KospiShadowSession,
} from "../src/lib/engine/kospiShadow";
import { equivalentCompletedKospiShadow } from "../src/lib/kospiShadowEquivalence";
import { hashSeriesValue } from "../src/lib/ledger/modelSeries";
import {
  diagnoseKospiCompletedBoundary,
  publicKospiBoundarySummary,
  type KospiBoundaryDiagnosticInput,
} from "./kospi-boundary-diagnostic";
const H = "sha256:" + "a".repeat(64),
  root = "00000000-0000-0000-0000-000000000001/shadow/synthetic/revisions/synthetic";
function session(
  date: string,
  previousSessionDate: string | null,
  score: number,
): KospiShadowSession {
  return {
    date,
    previousSessionDate,
    sourceHash: H,
    configHash: H,
    codeVersion: "a".repeat(40),
    sourceCollectedAt: "2026-10-28T00:00:00Z",
    confirmedClose: true,
    benchmarkClose: 100,
    gate: { date, status: "NEUTRAL", issues: [] },
    rows: ["SYNTH_A", "SYNTH_B"].map((symbol) => ({
      symbol,
      name: symbol,
      sector: symbol,
      date,
      open: 100,
      close: 100,
      volume: 1000,
      score,
      priority: 50,
      rsAccel: 1,
      commonHistory: true,
      onsetEligible: true,
      priceObserved: true,
    })),
  };
}
async function fixture(): Promise<KospiBoundaryDiagnosticInput> {
  const prior = stepKospiShadow(session("2026-10-22", null, 7), null),
    s = session("2026-10-23", "2026-10-22", 8),
    completed = stepKospiShadow(s, prior.state),
    registry = {
      strategyId: KOSPI_SHADOW_POLICY.id,
      ruleVersion: KOSPI_SHADOW_POLICY.version,
      initializedDate: "2026-10-22",
      configHash: H,
      config: { synthetic: true },
      initialSourceHash: H,
      initialCodeVersion: "a".repeat(40),
    };
  return {
    baselineSession: structuredClone(s),
    adjustedSession: structuredClone(s),
    completed: {
      path: root + "/sessions/2026-10-23.json",
      hash: await hashSeriesValue(completed),
      payload: structuredClone(completed),
    },
    predecessor: {
      path: root + "/sessions/2026-10-22.json",
      hash: await hashSeriesValue(prior),
      payload: structuredClone(prior),
    },
    registry: {
      path: root + "/registry.json",
      hash: await hashSeriesValue(registry),
      payload: registry,
    },
    guardResults: { baseline: true, adjusted: true },
  };
}
async function refresh(x: KospiBoundaryDiagnosticInput) {
  for (const o of [x.completed, x.predecessor, x.registry])
    if (o) o.hash = await hashSeriesValue(o.payload);
  x.guardResults = {
    baseline: equivalentCompletedKospiShadow(
      x.baselineSession,
      x.completed.payload,
      x.predecessor?.payload ?? null,
      x.registry.payload.initializedDate,
    ),
    adjusted: equivalentCompletedKospiShadow(
      x.adjustedSession,
      x.completed.payload,
      x.predecessor?.payload ?? null,
      x.registry.payload.initializedDate,
    ),
  };
}
test("complete private input retention, immutable input, deterministic diagnostics and unchanged true guard", async () => {
  const x = await fixture(),
    before = JSON.stringify(x),
    a = await diagnoseKospiCompletedBoundary(x),
    b = await diagnoseKospiCompletedBoundary(x);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(x), before);
  assert.equal(a.baseline.category, "EQUIVALENT");
  assert.equal(a.adjusted.category, "EQUIVALENT");
  assert.equal(a.adjusted.replay.equal, true);
  assert.deepEqual(a.sessions.baseline.payload, x.baselineSession);
  assert.equal(a.sessions.adjusted.hash, await hashSeriesValue(x.adjustedSession));
  assert.deepEqual(a.capturedReferences.completed, {
    path: x.completed.path,
    hash: x.completed.hash,
  });
  assert.equal(a.operationalApproval, false);
});
const cases: Array<[string, string, (x: KospiBoundaryDiagnosticInput) => void]> = [
  [
    "incoming timestamp",
    "INCOMING_VALIDATION",
    (x) => {
      x.adjustedSession.sourceCollectedAt = "invalid";
    },
  ],
  [
    "incoming duplicate row",
    "INCOMING_VALIDATION",
    (x) => {
      x.adjustedSession.rows.push(structuredClone(x.adjustedSession.rows[0]!));
    },
  ],
  [
    "existing late recovery",
    "COMPLETED_STRUCTURAL_ELIGIBILITY",
    (x) => {
      (x.completed.payload.source as any).lateRecovery = { synthetic: true };
    },
  ],
  [
    "incoming warmup",
    "COMPLETED_STRUCTURAL_ELIGIBILITY",
    (x) => {
      x.adjustedSession.warmupRows = [];
    },
  ],
  [
    "existing execution policy",
    "COMPLETED_STRUCTURAL_ELIGIBILITY",
    (x) => {
      (x.completed.payload.state as any).executionPolicy = "different";
    },
  ],
  [
    "malformed original row",
    "COMPLETED_STRUCTURAL_ELIGIBILITY",
    (x) => {
      (x.completed.payload.state.previousRows["SYNTH_A"] as any).score = "invalid";
    },
  ],
  [
    "invalid original timestamp",
    "ORIGINAL_VALIDATION",
    (x) => {
      x.completed.payload.source.sourceCollectedAt = "invalid";
    },
  ],
  [
    "economic gate",
    "SOURCE_OR_ROWS_MISMATCH",
    (x) => {
      x.adjustedSession.gate.status = "RISK_OFF";
    },
  ],
  [
    "added economic source field",
    "SOURCE_OR_ROWS_MISMATCH",
    (x) => {
      (x.adjustedSession as any).syntheticAdditionalField = true;
    },
  ],
  [
    "economic row",
    "SOURCE_OR_ROWS_MISMATCH",
    (x) => {
      x.adjustedSession.rows[0]!.priority = 51;
    },
  ],
  [
    "missing predecessor",
    "PREDECESSOR_LINK",
    (x) => {
      x.predecessor = null;
    },
  ],
  [
    "predecessor session count",
    "PREDECESSOR_LINK",
    (x) => {
      x.predecessor!.payload.state.sessions += 1;
    },
  ],
  [
    "predecessor timestamp",
    "PREDECESSOR_VALIDATION",
    (x) => {
      x.predecessor!.payload.source.sourceCollectedAt = "invalid";
    },
  ],
  [
    "completed cash",
    "REPLAY_MISMATCH",
    (x) => {
      x.completed.payload.state.cashKrw += 1;
    },
  ],
  [
    "row ordering changes intent array",
    "REPLAY_MISMATCH",
    (x) => {
      x.adjustedSession.rows.reverse();
    },
  ],
  [
    "malformed replay state",
    "REPLAY_ERROR",
    (x) => {
      (x.predecessor!.payload.state as any).positions = null;
    },
  ],
];
for (const [name, category, edit] of cases)
  test(`diagnoses ${name} without changing false guard`, async () => {
    const x = await fixture();
    edit(x);
    await refresh(x);
    assert.equal(x.guardResults.adjusted, false);
    const before = JSON.stringify(x),
      r = await diagnoseKospiCompletedBoundary(x);
    assert.equal(r.adjusted.category, category);
    assert.equal(r.adjusted.guardResult, false);
    assert.equal(r.adjusted.mirrorAgreesWithGuard, true);
    assert.equal(JSON.stringify(x), before);
  });
test("transport-only provenance differences remain equal", async () => {
  const x = await fixture();
  x.adjustedSession.sourceHash = "sha256:" + "b".repeat(64);
  x.adjustedSession.sourceCollectedAt = "2026-10-29T00:00:00Z";
  x.adjustedSession.codeVersion = "b".repeat(40);
  await refresh(x);
  const r = await diagnoseKospiCompletedBoundary(x);
  assert.equal(r.adjusted.guardResult, true);
  assert.equal(r.baselineVsAdjusted.economicSourceEqual, true);
  assert.notEqual(r.sessions.baseline.hash, r.sessions.adjusted.hash);
});
test("legacy string research reference is the only ignored policy field", async () => {
  const x = await fixture();
  (x.completed.payload.policy as any).researchReference = "synthetic display note";
  (x.predecessor!.payload.policy as any).researchReference = "another display note";
  await refresh(x);
  assert.equal((await diagnoseKospiCompletedBoundary(x)).adjusted.guardResult, true);
});
for (const part of ["completed", "predecessor", "registry"] as const)
  test(`rejects ${part} changed captured hash`, async () => {
    const x = await fixture();
    x[part]!.hash = "sha256:" + "f".repeat(64);
    await assert.rejects(diagnoseKospiCompletedBoundary(x), /CAPTURE_HASH_MISMATCH/);
  });
test("rejects captured reference escape", async () => {
  const x = await fixture();
  x.predecessor!.path = "different/sessions/2026-10-22.json";
  await assert.rejects(diagnoseKospiCompletedBoundary(x), /CAPTURE_PATH_MISMATCH/);
});
test("rejects caller's forged true equivalence result", async () => {
  const x = await fixture();
  x.adjustedSession.rows[0]!.close = 101;
  await assert.rejects(diagnoseKospiCompletedBoundary(x), /GUARD_RESULT_CHANGED/);
});
test("public summary emits only finite categories, booleans, counts and fixed version", async () => {
  const r = await diagnoseKospiCompletedBoundary(await fixture()),
    s = publicKospiBoundarySummary(r),
    json = JSON.stringify(s);
  assert(!/SYNTH|sha256|2026-|sessions\/|00000000/.test(json));
  assert(
    JSON.stringify(s, (_key, value) => {
      if (value && typeof value === "object") return value;
      assert(
        typeof value === "boolean" ||
          (typeof value === "number" && Number.isSafeInteger(value)) ||
          ["kospi-boundary-public-summary-v1", "EQUIVALENT"].includes(String(value)),
      );
      return value;
    }),
  );
  assert(
    Object.values(s)
      .filter((x) => !x || typeof x !== "object")
      .every(
        (x) =>
          typeof x === "boolean" ||
          (typeof x === "number" && Number.isSafeInteger(x)) ||
          ["kospi-boundary-public-summary-v1", "EQUIVALENT"].includes(String(x)),
      ),
  );
  assert.equal(s.baselineRowCount, 2);
  (r.baseline as any).category = "PRIVATE_SYMBOL";
  assert.throws(() => publicKospiBoundarySummary(r), /PUBLIC_CATEGORY_REJECTED/);
});

test("public summary diagnoses static failure using fixed booleans only", async () => {
  const x = await fixture();
  (x.completed.payload.source as any).lateRecovery = {
    privateValue: "NEVER_PUBLIC",
  };
  await refresh(x);
  const s = publicKospiBoundarySummary(await diagnoseKospiCompletedBoundary(x));
  assert.equal(s.adjustedCategory, "COMPLETED_STRUCTURAL_ELIGIBILITY");
  assert.deepEqual(s.adjustedChecks["existingLateRecoveryAbsent"], {
    evaluated: true,
    passed: false,
  });
  assert.deepEqual(s.adjustedChecks["keyedRowsEqual"], {
    evaluated: false,
    passed: false,
  });
  assert(!JSON.stringify(s).includes("NEVER_PUBLIC"));
});
test("public projection rejects invalid primitive types and ignores arbitrary private keys", async () => {
  const r = await diagnoseKospiCompletedBoundary(await fixture());
  (r.baseline.checks as any).SECRET_KEY = "NEVER_PUBLIC";
  assert(!JSON.stringify(publicKospiBoundarySummary(r)).includes("SECRET_KEY"));
  (r.adjusted.checks as any).existingLateRecoveryAbsent = "NEVER_PUBLIC";
  assert.throws(() => publicKospiBoundarySummary(r), /PUBLIC_BOOLEAN_REJECTED/);
  r.adjusted.checks["existingLateRecoveryAbsent"] = true;
  (r.adjusted.rowComparison as any).added = { length: "NEVER_PUBLIC" };
  assert.throws(() => publicKospiBoundarySummary(r), /PUBLIC_COUNT_REJECTED/);
});
