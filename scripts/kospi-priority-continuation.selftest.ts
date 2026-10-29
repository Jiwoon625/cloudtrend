/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import {
  KOSPI_SHADOW_POLICY,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "../src/lib/engine/kospiShadow";
import {
  persistKospiShadow,
  shadowObjectPath,
  type ShadowObjectStore,
  type KospiShadowView,
  type KospiShadowRegistry,
} from "../src/lib/kospiShadowStore";
import { kospiShadowRevisionPath } from "../src/lib/kospiShadowSeries";
import { hashSeriesValue, canonicalSeriesJson } from "../src/lib/ledger/modelSeries";
import runtime from "../src/lib/kospiShadowPublicationRuntime.generated.json";
import {
  proveKospiPriorityContinuation,
  type KospiPriorityContinuationInput,
} from "./kospi-priority-continuation";
const owner = "00000000-0000-0000-0000-000000000001",
  code = "a".repeat(40);
const symbols = [
  "SYNTH_HELD",
  "SYNTH_EXIT",
  "SYNTH_PENDING_A",
  "SYNTH_PENDING_B",
  "SYNTH_AWAIT",
  "SYNTH_NEW",
  "SYNTH_UNUSED",
];
const hash = (s: string) => hashSeriesValue({ synthetic: s });
const clone = <T>(v: T): T => structuredClone(v);
async function fixture(): Promise<KospiPriorityContinuationInput> {
  const config = { policy: KOSPI_SHADOW_POLICY, synthetic: true },
    configHash = await hashSeriesValue(config),
    source = await hash("original");
  const values = new Map<string, any>();
  const store: ShadowObjectStore = {
    read: async <T>(p: string) => clone(values.get(p) ?? null) as T | null,
    latestSessionDate: async (p) =>
      [...values.keys()]
        .filter((k) => k.startsWith(p + "/"))
        .map((k) => k.slice(p.length + 1))
        .sort()
        .at(-1)
        ?.slice(0, -5) ?? null,
    putImmutable: async (p, v) => {
      assert(!values.has(p));
      values.set(p, clone(v));
    },
    putLatest: async (p, v) => {
      values.set(p, clone(v));
    },
  };
  const make = (date: string, prior: string | null): KospiShadowSession => ({
    date,
    previousSessionDate: prior,
    sourceHash: source,
    configHash,
    codeVersion: code,
    sourceCollectedAt: "2026-10-28T00:00:00Z",
    confirmedClose: true,
    benchmarkClose: 100,
    gate: { date, status: "NEUTRAL", issues: [] },
    rows: symbols.map((symbol, i) => {
      let score = 7;
      if (["SYNTH_HELD", "SYNTH_EXIT"].includes(symbol) && date >= "2026-10-21") score = 8;
      if (symbol === "SYNTH_EXIT" && date >= "2026-10-23") score = 9.5;
      if (symbol.startsWith("SYNTH_PENDING") && date >= "2026-10-22") score = 8;
      if (symbol === "SYNTH_AWAIT" && date >= "2026-10-23") score = 8;
      if (symbol === "SYNTH_NEW" && date >= "2026-10-26") score = 8;
      return {
        symbol,
        name: symbol,
        sector: symbol,
        date,
        open: date === "2026-10-26" && symbol === "SYNTH_EXIT" ? 0 : 100,
        close: 100,
        volume: date === "2026-10-26" && symbol === "SYNTH_EXIT" ? 0 : 10000,
        score,
        priority: i + 1,
        rsAccel: 1,
        commonHistory: true,
        onsetEligible: true,
        priceObserved: true,
      };
    }),
  });
  let prior: string | null = null;
  for (const date of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) {
    await persistKospiShadow(store, owner, make(date, prior), config);
    prior = date;
  }
  const registry = values.get(shadowObjectPath(owner, "registry.json")) as KospiShadowRegistry;
  const originalView = values.get(shadowObjectPath(owner, "latest.json")) as KospiShadowView;
  const completed = values.get(
    shadowObjectPath(owner, "sessions/2026-10-23.json"),
  ) as KospiShadowSnapshot;
  const predecessor = values.get(
    shadowObjectPath(owner, "sessions/2026-10-22.json"),
  ) as KospiShadowSnapshot;
  const authority = {
    owner,
    predecessorDate: "2026-10-23",
    targetDates: ["2026-10-26", "2026-10-27"],
    baselineSourceHash: await hash("baseline"),
    adjustedBasisHash: await hash("adjusted"),
    sourceManifestHash: await hash("source-manifest"),
    captureManifestHash: await hash("capture"),
    baselineCollectedAt: "2026-10-28T00:00:00Z",
    adjustedCapturedAt: "2026-10-28T01:00:00Z",
    computedAt: "2026-10-28T02:00:00Z",
    codeVersion: code,
    runtimeCodeHash: runtime.codeHash,
  };
  const baselineSession = {
    ...make("2026-10-23", "2026-10-22"),
    sourceHash: authority.baselineSourceHash,
  };
  const adjustedSession = {
    ...make("2026-10-23", "2026-10-22"),
    sourceHash: authority.adjustedBasisHash,
    sourceCollectedAt: authority.adjustedCapturedAt,
  };
  baselineSession.rows.find((r) => r.symbol === "SYNTH_UNUSED")!.priority! += 0.01;
  adjustedSession.rows.find((r) => r.symbol === "SYNTH_UNUSED")!.priority! += 0.03;
  const capture = async <T>(suffix: string, payload: T) => ({
    path: kospiShadowRevisionPath(owner, suffix),
    hash: await hashSeriesValue(payload),
    payload: clone(payload),
  });
  const completedHash = await hashSeriesValue(completed);
  const targetSessions = authority.targetDates.map((date, i) => ({
    ...make(date, i === 0 ? authority.predecessorDate : authority.targetDates[i - 1]!),
    sourceHash: authority.adjustedBasisHash,
    sourceCollectedAt: authority.adjustedCapturedAt,
    lateRecovery: {
      version: "kospi-final-retrospective-v1",
      historicalAvailabilityClaim: false,
      retrospective: true,
      sourceDataAsOf: authority.targetDates[1],
      sourceCollectedAt: authority.baselineCollectedAt,
      captureObservedAt: authority.adjustedCapturedAt,
      computedAt: authority.computedAt,
      sourceManifestHash: authority.sourceManifestHash,
      captureManifestHash: authority.captureManifestHash,
      adjustedBasisHash: authority.adjustedBasisHash,
      runtimeCodeHash: authority.runtimeCodeHash,
      predecessorDate: authority.predecessorDate,
      predecessorHash: completedHash,
    },
  }));
  return {
    authority,
    registry: await capture("registry.json", registry),
    completed: await capture("sessions/2026-10-23.json", completed),
    predecessor: await capture("sessions/2026-10-22.json", predecessor),
    originalView: await capture("latest.json", originalView),
    baselineSession,
    adjustedSession,
    targetSessions,
  };
}
test("three actual in-memory persist streams converge; nonempty holdings, awaiting, pending allocation and deferred exit branches", async () => {
  const x = await fixture(),
    before = canonicalSeriesJson(x),
    p = await proveKospiPriorityContinuation(x);
  assert.equal(p.status, "PROVEN_PRIORITY_ONLY_CONTINUATION");
  assert.equal(p.operationalApproval, false);
  assert.equal(p.checks.adjustedStrict, false);
  assert.equal(p.checks.baselinePriorityRestoredStrict, true);
  assert.equal(p.checks.adjustedPriorityRestoredStrict, true);
  const s = x.completed.payload.state;
  assert.equal(Object.keys(s.positions).length, 2);
  assert.equal(s.pendingEntries.length, 2);
  assert.equal(s.awaiting.length, 1);
  assert.equal(Object.keys(s.pendingExits).length, 1);
  const [day1, day2] = p.continuations.original.snapshots;
  assert(day1 && day2);
  assert(day1.state.positions["SYNTH_EXIT"]);
  assert(day1.state.pendingExits["SYNTH_EXIT"]);
  assert(day1.trades.some((t) => t.symbol === "SYNTH_PENDING_A" && t.side === "BUY"));
  assert(day1.trades.some((t) => t.symbol === "SYNTH_PENDING_B" && t.side === "BUY"));
  assert(day1.state.pendingEntries.some((c) => c.symbol === "SYNTH_AWAIT"));
  assert(day2.trades.some((t) => t.symbol === "SYNTH_EXIT" && t.side === "SELL"));
  assert(day2.trades.some((t) => t.symbol === "SYNTH_AWAIT" && t.side === "BUY"));
  assert(day2.state.pendingEntries.some((c) => c.symbol === "SYNTH_NEW"));
  assert.deepEqual(p.continuations.original.snapshots, p.continuations.adjusted.snapshots);
  assert.deepEqual(p.continuations.original.projections, p.continuations.baseline.projections);
  assert.equal(canonicalSeriesJson(x), before);
  assert.deepEqual(await proveKospiPriorityContinuation(JSON.parse(JSON.stringify(x))), p);
});
for (const [name, mutate] of [
  [
    "current pending candidate priority",
    (x: any) => {
      x.adjustedSession.rows.find((r: any) => r.symbol === "SYNTH_PENDING_A").priority += 1;
    },
  ],
  [
    "price",
    (x: any) => {
      x.adjustedSession.rows[0].close += 1;
    },
  ],
  [
    "score",
    (x: any) => {
      x.adjustedSession.rows[0].score += 1;
    },
  ],
  [
    "current eligibility",
    (x: any) => {
      x.adjustedSession.rows[0].onsetEligible = false;
    },
  ],
  [
    "added row",
    (x: any) => {
      x.adjustedSession.rows.push({
        ...x.adjustedSession.rows[0],
        symbol: "SYNTH_EXTRA",
      });
    },
  ],
] as const)
  test("semantic divergence blocks: " + name, async () => {
    const x = await fixture();
    mutate(x);
    const p = await proveKospiPriorityContinuation(x);
    assert.equal(p.status, "BLOCKED_PRIORITY_ONLY_CONTINUATION");
    assert.equal(p.operationalApproval, false);
    assert(p.replays.adjusted.payload);
    assert.equal(p.continuations.original.snapshots.length, 0);
  });
for (const [name, mutate] of [
  [
    "captured hash",
    (x: any) => {
      x.completed.hash = "sha256:" + "f".repeat(64);
    },
  ],
  [
    "captured owner path",
    (x: any) => {
      x.originalView.path = x.originalView.path.replace("00000001/", "00000002/");
    },
  ],
  [
    "runtime",
    (x: any) => {
      x.authority.runtimeCodeHash = "sha256:" + "f".repeat(64);
    },
  ],
  [
    "target order",
    (x: any) => {
      x.targetSessions.reverse();
    },
  ],
  [
    "target source",
    (x: any) => {
      x.targetSessions[0].sourceHash = "sha256:" + "f".repeat(64);
    },
  ],
  [
    "target clock",
    (x: any) => {
      x.targetSessions[0].sourceCollectedAt = "2026-10-28T01:00:01Z";
    },
  ],
  [
    "target predecessor",
    (x: any) => {
      x.targetSessions[1].previousSessionDate = "2026-10-23";
    },
  ],
  [
    "late recovery predecessor hash",
    (x: any) => {
      x.targetSessions[1].lateRecovery.predecessorHash = "sha256:" + "f".repeat(64);
    },
  ],
  [
    "late recovery capture hash",
    (x: any) => {
      x.targetSessions[0].lateRecovery.captureManifestHash = "sha256:" + "f".repeat(64);
    },
  ],
  [
    "late recovery extra field",
    (x: any) => {
      x.targetSessions[0].lateRecovery.extra = true;
    },
  ],
  [
    "late recovery missing",
    (x: any) => {
      delete x.targetSessions[0].lateRecovery;
    },
  ],
  [
    "pre-observation computation",
    (x: any) => {
      x.authority.computedAt = "2026-10-27T00:00:00Z";
    },
  ],
] as const)
  test("integrity fails closed: " + name, async () => {
    const x = await fixture();
    mutate(x);
    await assert.rejects(proveKospiPriorityContinuation(x));
  });
test("future row ordering and current priority are included in exact body hashes and are not normalized away", async () => {
  const x = await fixture(),
    p = await proveKospiPriorityContinuation(x);
  const changed = clone(x);
  changed.targetSessions[0]!.rows.reverse();
  changed.targetSessions[0]!.rows.find((r) => r.symbol === "SYNTH_AWAIT")!.priority = 99;
  const q = await proveKospiPriorityContinuation(changed);
  assert.equal(q.status, "PROVEN_PRIORITY_ONLY_CONTINUATION");
  assert.notEqual(q.inputHash, p.inputHash);
  assert.notEqual(q.inputSessionHashes.targets[0], p.inputSessionHashes.targets[0]);
  assert.notEqual(
    q.continuations.original.snapshotHashes[0],
    p.continuations.original.snapshotHashes[0],
  );
  assert.equal(
    q.continuations.original.snapshots[0]!.state.pendingEntries.find(
      (c) => c.symbol === "SYNTH_AWAIT",
    )!.priority,
    99,
  );
});
test("strict already-equal boundary does not claim the alternative admission", async () => {
  const x = await fixture();
  x.adjustedSession.rows.find((r) => r.symbol === "SYNTH_UNUSED")!.priority =
    x.completed.payload.state.previousRows["SYNTH_UNUSED"]!.priority;
  const p = await proveKospiPriorityContinuation(x);
  assert.equal(p.checks.adjustedStrict, true);
  assert.equal(p.status, "BLOCKED_PRIORITY_ONLY_CONTINUATION");
});
for (const [name, mutate] of [
  [
    "cash",
    (x: any) => {
      x.completed.payload.state.cashKrw += 1;
    },
  ],
  [
    "fees",
    (x: any) => {
      x.completed.payload.state.totalFeesKrw += 1;
    },
  ],
  [
    "position quantity",
    (x: any) => {
      x.completed.payload.state.positions.SYNTH_HELD.shares += 1;
    },
  ],
  [
    "saved pending priority",
    (x: any) => {
      x.completed.payload.state.pendingEntries[0].priority += 1;
    },
  ],
  [
    "saved awaiting score",
    (x: any) => {
      x.completed.payload.state.awaiting[0].originScore += 1;
    },
  ],
  [
    "daily profit",
    (x: any) => {
      x.completed.payload.daily.cumulativeReturn += 0.01;
    },
  ],
  [
    "trade fee",
    (x: any) => {
      x.completed.payload.trades[0].feeKrw += 1;
    },
  ],
] as const)
  test("self-rehashed historical economic tamper cannot pass: " + name, async () => {
    const x = await fixture();
    mutate(x);
    x.completed.hash = await hashSeriesValue(x.completed.payload);
    x.originalView.payload.latest = clone(x.completed.payload);
    x.originalView.payload.history[x.originalView.payload.history.length - 1] = clone(
      x.completed.payload.daily,
    );
    x.originalView.hash = await hashSeriesValue(x.originalView.payload);
    for (const s of x.targetSessions) (s as any).lateRecovery.predecessorHash = x.completed.hash;
    const p = await proveKospiPriorityContinuation(x);
    assert.equal(p.status, "BLOCKED_PRIORITY_ONLY_CONTINUATION");
    assert.equal(p.checks.originalReplayEqual, false);
    assert.equal(p.continuations.original.snapshots.length, 0);
  });
test("target lateRecovery bytes survive JSON and any post-proof metadata edit changes or rejects the proof", async () => {
  const x = await fixture(),
    p = await proveKospiPriorityContinuation(x),
    roundtrip = JSON.parse(JSON.stringify(x));
  assert.deepEqual(await proveKospiPriorityContinuation(roundtrip), p);
  roundtrip.targetSessions[1].lateRecovery.computedAt = "2026-10-28T02:00:01Z";
  await assert.rejects(proveKospiPriorityContinuation(roundtrip));
});

for (const scope of ["baseline", "adjusted", "target"] as const)
  for (const malformed of ["missing", "string", "nan", "infinity"] as const)
    test(`actual priority validity is checked before restoration: ${scope}/${malformed}`, async () => {
      const x = await fixture();
      const session =
        scope === "baseline"
          ? x.baselineSession
          : scope === "adjusted"
            ? x.adjustedSession
            : x.targetSessions[0]!;
      const row = session.rows.find((r) => r.symbol === "SYNTH_UNUSED")! as unknown as Record<
        string,
        unknown
      >;
      if (malformed === "missing") delete row["priority"];
      else
        row["priority"] =
          malformed === "string" ? "not-a-number" : malformed === "nan" ? NaN : Infinity;
      await assert.rejects(() => proveKospiPriorityContinuation(x));
    });

for (const scope of ["baseline", "adjusted", "target"] as const)
  test(`valid explicit null priority remains admissible: ${scope}`, async () => {
    const x = await fixture();
    const session =
      scope === "baseline"
        ? x.baselineSession
        : scope === "adjusted"
          ? x.adjustedSession
          : x.targetSessions[0]!;
    session.rows.find((r) => r.symbol === "SYNTH_UNUSED")!.priority = null;
    assert.equal(
      (await proveKospiPriorityContinuation(x)).status,
      "PROVEN_PRIORITY_ONLY_CONTINUATION",
    );
  });
