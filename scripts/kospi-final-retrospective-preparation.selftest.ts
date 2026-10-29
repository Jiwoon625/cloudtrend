import runtime from "../src/lib/kospiShadowPublicationRuntime.generated.json";
import assert from "node:assert/strict";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { buildKospiShadowSession } from "../src/lib/engine/kospiShadowDataset";
import { KOSPI_SHADOW_POLICY, type KospiShadowSnapshot } from "../src/lib/engine/kospiShadow";
import {
  persistKospiShadow,
  shadowObjectPath,
  type ShadowObjectStore,
} from "../src/lib/kospiShadowStore";
import {
  initializeKospiShadowRevision,
  openKospiShadowRevisionStore,
  KOSPI_SHADOW_CORRECTION_REVISION_ID,
} from "../src/lib/kospiShadowSeries";
import { hashSeriesValue } from "../src/lib/ledger/modelSeries";
import {
  prepareKospiFinalRetrospective,
  compareKospiSessions,
  type KospiFinalPreparationInput,
} from "./kospi-final-retrospective-preparation";

const uid = "00000000-0000-0000-0000-000000000001";
const recent = [
  "2026-10-02",
  "2026-10-06",
  "2026-10-07",
  "2026-10-08",
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
  "2026-10-16",
  "2026-10-19",
  "2026-10-20",
  "2026-10-21",
  "2026-10-22",
  "2026-10-23",
  "2026-10-26",
  "2026-10-27",
];
const raw = structuredClone(getMockDataset());
const dateMap = new Map(raw.tradeDates.slice(-recent.length).map((d, i) => [d, recent[i]!]));
const mapDate = (d: string) => dateMap.get(d) ?? d;
raw.asOfDate = recent.at(-1)!;
raw.tradeDates = raw.tradeDates.map(mapDate);
raw.isLive = true; // Entirely synthetic fixture; never delivered to any operational runner.
for (const bars of Object.values(raw.bars))
  for (const b of bars) b.tradeDate = mapDate(b.tradeDate);
for (const s of raw.indexSeries) for (const b of s.bars) b.tradeDate = mapDate(b.tradeDate);
for (const o of raw.vkospiObservations ?? []) o.date = mapDate(o.date);
const config = { policy: KOSPI_SHADOW_POLICY, scoring: DEFAULT_SCORING_CONFIG };
const configHash = await hashSeriesValue(config);
const h = (tag: string) => hashSeriesValue({ synthetic: tag });
const data = new Map<string, unknown>();
let externalWrites = 0;
const store: ShadowObjectStore = {
  read: async <T>(p: string) => structuredClone(data.get(p) ?? null) as T | null,
  latestSessionDate: async (p) =>
    [...data.keys()]
      .filter((k) => k.startsWith(p + "/"))
      .map((k) => k.slice(p.length + 1))
      .filter((k) => /^\d{4}-\d{2}-\d{2}\.json$/.test(k))
      .sort()
      .at(-1)
      ?.slice(0, -5) ?? null,
  putImmutable: async (p, v) => {
    if (data.has(p)) throw new Error("fixture collision");
    data.set(p, structuredClone(v));
    externalWrites++;
  },
  putLatest: async (p, v) => {
    data.set(p, structuredClone(v));
    externalWrites++;
  },
};
const sourceHash = await h("original");
const make = (date: string) =>
  buildKospiShadowSession(
    raw,
    DEFAULT_SCORING_CONFIG,
    {
      sourceHash,
      configHash,
      codeVersion: "a".repeat(40),
      sourceCollectedAt: "2026-10-28T00:00:00Z",
      now: "2026-10-28T01:00:00Z",
    },
    date,
  );
for (const date of recent.slice(0, 7)) await persistKospiShadow(store, uid, make(date), config);
const prior = await store.read<KospiShadowSnapshot>(
  shadowObjectPath(uid, "sessions/2026-10-13.json"),
);
const original = await store.read<KospiShadowSnapshot>(
  shadowObjectPath(uid, "sessions/2026-10-14.json"),
);
const corrected = make("2026-10-14");
await initializeKospiShadowRevision(store, uid, corrected, config, {
  revisionId: KOSPI_SHADOW_CORRECTION_REVISION_ID,
  predecessorDate: "2026-10-13",
  correctionDate: "2026-10-14",
  expectedPredecessorHash: await hashSeriesValue(prior),
  expectedOriginalTargetHash: await hashSeriesValue(original),
  expectedCorrectedSourceHash: corrected.sourceHash,
  computedAt: "2026-10-28T01:00:00Z",
});
const revision = await openKospiShadowRevisionStore(store, uid);
for (const date of recent.slice(7, 14)) await persistKospiShadow(revision, uid, make(date), config);
const objects = Object.fromEntries(
  await Promise.all(
    [...data].map(async ([p, payload]) => [
      p,
      {
        hash: await hashSeriesValue(payload),
        payload: structuredClone(payload),
      },
    ]),
  ),
);
const authority = {
  owner: uid,
  predecessorDate: "2026-10-23",
  targetDates: ["2026-10-26", "2026-10-27"],
  baselineSourceHash: sourceHash,
  adjustedBasisHash: await h("adjusted"),
  sourceManifestHash: await h("manifest"),
  captureManifestHash: await h("capture"),
  baselineCollectedAt: "2026-10-28T00:00:00Z",
  adjustedCapturedAt: "2026-10-28T01:00:00Z",
  computedAt: "2026-10-28T02:00:00Z",
  codeVersion: "a".repeat(40),
  runtimeCodeHash: runtime.codeHash,
};
const input: KospiFinalPreparationInput = {
  baselineDataset: raw,
  adjustedDataset: structuredClone(raw),
  scoringConfig: DEFAULT_SCORING_CONFIG,
  authority,
  objects,
};
const before = JSON.stringify(input),
  writesBefore = externalWrites;
const result = await prepareKospiFinalRetrospective(input);
assert.equal(result.status, "PREPARED_FOR_INDEPENDENT_REVIEW");
if (result.status !== "PREPARED_FOR_INDEPENDENT_REVIEW") throw new Error("fixture blocked");
assert.equal(result.adjustedBoundaryEquivalent, true);
assert.equal(result.baselineBoundaryEquivalent, true);
assert.equal(
  result.comparisons.every((c) => c.equalExceptTransportProvenance),
  true,
);
assert.equal(result.plan?.snapshotHashes.length, 2);
assert.equal(result.plan?.writeSet.length, 4);
assert.equal(result.plan.boundaryAdmission.mode, "STRICT_COMPLETED_EQUIVALENCE");
assert.equal(result.priorityContinuation, null);
assert.equal(result.priorityContinuationHash, null);
assert.deepEqual(result.plan.sessions, result.targetSessions);
assert.equal(
  result.targetSessions.every(
    (s) => s.lateRecovery?.predecessorHash === result.plan.predecessorHash,
  ),
  true,
);
assert.equal(result.finalProjection?.latest.source.date, "2026-10-27");
assert.equal(JSON.stringify(input), before);
assert.equal(externalWrites, writesBefore);
assert.equal(result.historicalAvailabilityClaim, false);
assert.equal(result.operationalApproval, false);
const retry = await prepareKospiFinalRetrospective(input);
if (retry.status !== "PREPARED_FOR_INDEPENDENT_REVIEW") throw new Error("retry blocked");
assert.equal(retry.planHash, result.planHash);
let tests = 2;
for (const change of [
  (x: typeof input) => {
    x.authority.targetDates = ["2026-10-27"];
  },
  (x: typeof input) => {
    x.authority.adjustedCapturedAt = "2026-10-27T00:00:00Z";
  },
  (x: typeof input) => {
    x.authority.codeVersion = "unbound";
  },
  (x: typeof input) => {
    x.authority.runtimeCodeHash = "x";
  },
  (x: typeof input) => {
    x.adjustedDataset.isLive = false;
  },
  (x: typeof input) => {
    x.adjustedDataset.asOfDate = "2026-10-28";
  },
  (x: typeof input) => {
    delete x.objects[Object.keys(x.objects)[0]!];
  },
  (x: typeof input) => {
    x.objects[Object.keys(x.objects)[0]!]!.hash = "sha256:" + "0".repeat(64);
  },
  (x: typeof input) => {
    x.objects["unexpected/private.json"] = { hash: sourceHash, payload: {} };
  },
  (x: typeof input) => {
    x.scoringConfig = {
      ...x.scoringConfig,
      configVersion: x.scoringConfig.configVersion + 1,
    };
  },
]) {
  const x = structuredClone(input);
  change(x);
  await assert.rejects(() => prepareKospiFinalRetrospective(x));
  tests++;
}
const changed = structuredClone(input);
const inst = changed.adjustedDataset.instruments.find(
  (i) => i.market === "KOSPI" && i.instrumentType === "STOCK",
)!;
changed.adjustedDataset.bars[inst.symbol]!.find((b) => b.tradeDate === "2026-10-23")!.close *= 1.1;
const blocked = await prepareKospiFinalRetrospective(changed);
assert.equal(blocked.status, "BLOCKED_ADJUSTED_PREDECESSOR_MISMATCH");
assert.equal(blocked.plan, null);
assert.equal(blocked.adjustedBoundaryEquivalent, false);
assert.equal(blocked.targetSessions.length, 2);
assert.deepEqual(
  blocked.targetSessions.map((s) => s.date),
  changed.authority.targetDates,
);
assert.equal(
  blocked.targetSessions.every((s) => s.lateRecovery?.historicalAvailabilityClaim === false),
  true,
);
assert.equal(blocked.priorityContinuation?.status, "BLOCKED_PRIORITY_ONLY_CONTINUATION");
assert.equal(await hashSeriesValue(blocked.priorityContinuation), blocked.priorityContinuationHash);
assert.deepEqual(JSON.parse(JSON.stringify(blocked)).targetSessions, blocked.targetSessions);
tests++;
const one = make("2026-10-26"),
  two = structuredClone(one);
two.rows.reverse();
assert.equal((await compareKospiSessions(one, two)).equalExceptTransportProvenance, false);
tests++;
const three = structuredClone(one);
three.rows[0]!.priority = (three.rows[0]!.priority ?? 0) + 1;
assert.equal((await compareKospiSessions(one, three)).equalExceptTransportProvenance, false);
tests++;
console.log(
  JSON.stringify({
    syntheticTests: tests,
    status: "PASS",
    externalPreparationWrites: externalWrites - writesBefore,
    operationalExecution: false,
  }),
);
