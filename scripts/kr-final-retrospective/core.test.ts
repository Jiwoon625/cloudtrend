/* eslint-disable @typescript-eslint/no-explicit-any */
/** Synthetic genuine adopted-engine coverage. Legacy is mocked ONLY at orchestration boundary;
 * real legacy engine and uncertain-write coverage remains in kospi-apply-selftest.ts. */
import { beforeAll, expect, it, vi } from "vitest";
vi.mock("../kospi-final-retrospective-preparation", () => ({
  prepareKospiFinalRetrospective: vi.fn(async () => ({
    status: "PREPARED_FOR_INDEPENDENT_REVIEW",
    plan: { writeSet: [] },
    syntheticLegacyOnly: true,
  })),
}));
vi.mock("../kospi-final-retrospective-apply", () => ({
  kospiRetrospectiveApprovalCandidate: (hash: string) => ({
    syntheticLegacyOnly: true,
    preparationHash: hash,
  }),
  applyPreparedKospiRetrospective: vi.fn(async () => ({
    status: "SYNTHETIC_LEGACY_ORCHESTRATION_ONLY",
  })),
}));
import { prepareKospiFinalRetrospective } from "../kospi-final-retrospective-preparation";
import { KOSPI_SHADOW_NAMESPACE } from "../../src/lib/kospiShadowStore";
import { KOSPI_SHADOW_CORRECTION_REVISION_ID } from "../../src/lib/kospiShadowSeries";
import { prepareFinalRetrospective, KINDS, DATES, type FinalPlan } from "./core";
import { applyFinalRetrospective, finalApprovalCandidate, type FinalApplyInput } from "./apply";
import type { ModelJournalRun } from "../../src/lib/ledger/modelJournal";
import type { FinalCaptureV1 } from "./contracts";
import { encodeFinalCapture, hydrateFinalCapture } from "./capture-codec";
import {
  recoveryFixture,
  publication,
  plainStore,
  H,
  OWNER,
  clone,
  sessionKey,
  type MemoryData,
} from "../kr-adjusted-recovery/recovery-model-plan-fixture";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { KR_SOURCE_VINTAGE_POLICY } from "../../src/lib/ledger/krSourceVintage";
import { applyPreparedKospiRetrospective } from "../kospi-final-retrospective-apply";
const correctionApprovalPath = `${OWNER}/${KOSPI_SHADOW_NAMESPACE}/correction-approvals/${KOSPI_SHADOW_CORRECTION_REVISION_ID}.json`;
const syntheticCorrectionApproval = {
  syntheticLegacyOnly: true,
  role: "ORIGINAL_CORRECTION_APPROVAL",
};
let capture: FinalCaptureV1, plan: FinalPlan, baseline: MemoryData;
beforeAll(async () => {
  const f = await recoveryFixture();
  baseline = f.complete;
  const p = publication("2026-10-29");
  for (const i of p.dataset.instruments)
    Object.assign(i, { indexMemberships: [], listedDate: "2000-01-01" });
  const dates = [...p.dataset.tradeDates, ...DATES];
  p.dataset.tradeDates = dates;
  p.dataset.kospiGateDates = dates;
  for (const bars of Object.values(p.dataset.bars)) {
    const bar = clone(bars[0]!);
    bars.splice(0, bars.length, ...dates.map((tradeDate) => ({ ...bar, tradeDate })));
  }
  p.dataset.observedBars = clone(p.dataset.bars);
  for (const index of p.dataset.indexSeries) {
    const bar = clone(index.bars[0]!);
    index.bars = dates.map((tradeDate) => ({ ...bar, tradeDate }));
  }
  const receipt = {
    version: "kr-source-vintage-review-v1",
    reviewId: "reviewed-kr-vintage-v1",
    reviews: ["2026-10-12", "2026-10-13"].map((date) => ({
      id: "reviewed-kr-vintage-v1",
      symbol: "UNRELATED",
      date,
      notBefore: "2026-10-14",
      archivedHash: H("a"),
      incomingHash: H("b"),
      evidenceUrl: "https://dart.fss.or.kr/synthetic",
    })),
  };
  capture = {
    version: "kr-final-retrospective-capture-v1",
    owner: OWNER,
    codeCommit: "a".repeat(40),
    runtimeHashes: { october: H(), kospi: H("b") },
    capturedAt: "2026-10-30T01:00:00Z",
    computedAt: "2026-10-30T01:01:00Z",
    sourceManifest: { synthetic: true },
    captureManifest: { synthetic: true },
    preservationBaseline: { synthetic: true },
    finalPublication: { hash: H("c"), activatedAt: "2026-10-30T00:39:00Z", asOfDate: "2026-10-29" },
    dataset: p.dataset,
    config: p.config,
    sourceVintageApproval: {
      receipt,
      registry: {
        version: "kr-source-vintage-approval-v1",
        reviewId: "reviewed-kr-vintage-v1",
        status: "APPROVED",
        receiptHash: await hashSeriesValue(receipt),
        policy: KR_SOURCE_VINTAGE_POLICY,
      },
    } as any,
    predecessors: await Promise.all(
      KINDS.map(async (kind) => {
        const series = baseline.series.get("adopted-shadow-2026-10-12-v1:" + kind)!;
        const run = baseline.sessions.get(sessionKey(series.bookId, "2026-10-27"))!;
        return { series, run, payloadHash: await hashSeriesValue(run) };
      }),
    ),
    archives: await Promise.all(
      [...baseline.archives.values()].map(async (payload) => ({
        payload,
        hash: await hashSeriesValue(payload),
      })),
    ),
    legacyObjects: {
      [correctionApprovalPath]: {
        payload: syntheticCorrectionApproval,
        hash: await hashSeriesValue(syntheticCorrectionApproval),
      },
    },
  };
  plan = await prepareFinalRetrospective(capture);
}, 60000);
async function harness(selectedPlan: FinalPlan = plan) {
  const data = clone(baseline),
    store = plainStore(data),
    approval = await finalApprovalCandidate(selectedPlan);
  const writes: string[] = [];
  let checks = 0,
    appends = 0;
  let fault: { at: number; mode: "BEFORE" | "AFTER" | "READBACK" } | undefined;
  let readFault: string | undefined;
  const wrap = {
    ...store,
    append: async (...args: Parameters<typeof store.append>) => {
      appends++;
      writes.push("append");
      const trigger = fault?.at === appends;
      if (trigger && fault?.mode === "BEFORE") throw new Error("SYNTHETIC_BEFORE");
      const value = await store.append(...args);
      if (trigger && fault?.mode === "AFTER") throw new Error("SYNTHETIC_AFTER");
      if (trigger && fault?.mode === "READBACK")
        readFault = sessionKey(args[0].bookId, args[1].receipt.date);
      return value;
    },
    readSession: async <T extends ModelJournalRun>(id: string, date: string) => {
      if (readFault === sessionKey(id, date)) {
        readFault = undefined;
        throw new Error("SYNTHETIC_READBACK");
      }
      return store.readSession<T>(id, date);
    },
    putKrInput: async (...a: Parameters<typeof store.putKrInput>) => {
      writes.push("archive");
      return store.putKrInput(...a);
    },
    prepare: async (...a: Parameters<typeof store.prepare>) => {
      writes.push("prepared");
      return store.prepare(...a);
    },
  };
  const input: FinalApplyInput = {
    phase: "APPLY",
    plan: clone(selectedPlan),
    approval,
    authoritativePlanHash: await hashSeriesValue(selectedPlan),
    authoritativeApprovalHash: await hashSeriesValue(approval),
    admittedCodeCommit: capture.codeCommit,
    admittedRuntimeHashes: capture.runtimeHashes,
    owner: OWNER,
    store: wrap,
    legacyStore: {
      read: async (path: string) => clone(capture.legacyObjects[path]?.payload ?? null),
    } as any,
    assertFresh: async () => {
      checks++;
      for (const [key, row] of baseline.sessions) expect(data.sessions.get(key)).toEqual(row);
    },
    assertExclusiveWriter: async () => {},
    putProvenance: async () => {
      writes.push("provenance");
    },
  };
  return {
    data,
    input,
    writes,
    setFault: (f: typeof fault) => {
      fault = f;
    },
    checks: () => checks,
    appends: () => appends,
  };
}
it("real adopted engine plans ten28/29 sessions with honest clocks and no prefix mutation", () => {
  expect(plan.newAdoptedSessions).toHaveLength(10);
  expect(plan.newArchives.map((x) => x.date)).toEqual(DATES);
  expect(plan.retrospectiveAuthorityCandidate.receipt.historicalAvailabilityClaim).toBe(false);
  expect(plan.retrospectiveAuthorityCandidate.receipt.captureFinishedAt).toBe(capture.capturedAt);
  expect(plan.newAdoptedSessions.every((x) => DATES.includes(x.receipt.date))).toBe(true);
  expect(baseline.sessions.size).toBe(60);
});
it("VALIDATE writes nothing", async () => {
  const h = await harness();
  h.input.phase = "VALIDATE";
  expect((await applyFinalRetrospective(h.input)).status).toBe("VALIDATED");
  expect(h.writes).toEqual([]);
});
it("APPLY+exact retry add exactly ten genuine engine records; original60 preserved", async () => {
  const h = await harness();
  expect((await applyFinalRetrospective(h.input)).status).toBe("APPLIED");
  expect(h.data.sessions.size).toBe(70);
  expect(h.appends()).toBe(10);
  const after = clone(h.data.sessions);
  await applyFinalRetrospective(h.input);
  expect(h.data.sessions).toEqual(after);
  expect(h.appends()).toBe(10);
  expect(h.checks()).toBeGreaterThan(10);
  expect(applyPreparedKospiRetrospective).toHaveBeenCalled();
});
for (const mode of ["BEFORE", "AFTER", "READBACK"] as const)
  for (const at of [1, 5, 6, 10])
    it(`${mode} append${at}: no blind duplicate; exact prefix resumes`, async () => {
      const h = await harness();
      h.setFault({ at, mode });
      if (mode === "AFTER") await applyFinalRetrospective(h.input);
      else await expect(applyFinalRetrospective(h.input)).rejects.toThrow("SYNTHETIC_");
      const preserved = clone(h.data.sessions);
      h.setFault(undefined);
      await applyFinalRetrospective(h.input);
      expect(h.data.sessions.size).toBe(70);
      for (const [k, v] of preserved) expect(h.data.sessions.get(k)).toEqual(v);
    });
const invalidCapture: Array<[string, (c: any) => void]> = [
  ["owner", (c) => (c.owner = "foreign")],
  ["runtime", (c) => (c.runtimeHashes.october = "bad")],
  ["code", (c) => (c.codeCommit = "bad")],
  ["horizon", (c) => (c.dataset.asOfDate = "2026-10-30")],
  ["clock", (c) => (c.capturedAt = "2026-10-28T00:00:00Z")],
  ["early computation", (c) => (c.computedAt = "2026-10-29T00:00:00Z")],
  ["predecessor", (c) => (c.predecessors[0].run.receipt.date = "2026-10-26")],
  ["kind", (c) => c.predecessors.reverse()],
  ["archive hash", (c) => (c.archives[0].hash = H("f"))],
  ["predecessor hash", (c) => (c.predecessors[0].payloadHash = H("f"))],
  ["vintage", (c) => (c.sourceVintageApproval.registry.status = "UNAPPROVED")],
];
it.each(invalidCapture)("invalid capture %s fails closed", async (_, mutate) => {
  const c = clone(capture);
  mutate(c);
  await expect(prepareFinalRetrospective(c)).rejects.toThrow();
});
const invalidApply: Array<[string, (i: any) => void]> = [
  ["plan pin", (i) => (i.authoritativePlanHash = H("f"))],
  ["approval pin", (i) => (i.authoritativeApprovalHash = H("f"))],
  ["owner", (i) => (i.owner = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")],
  ["runtime", (i) => (i.admittedRuntimeHashes = { ...i.admittedRuntimeHashes, october: H("f") })],
  ["code", (i) => (i.admittedCodeCommit = "b".repeat(40))],
  ["phase", (i) => (i.phase = "UNSAFE")],
  ["scope", (i) => (i.plan.expectedNewModelSessions = 12)],
];
it.each(invalidApply)("invalid apply %s performs zero writes", async (_, mutate) => {
  const h = await harness();
  mutate(h.input);
  await expect(applyFinalRetrospective(h.input)).rejects.toThrow();
  expect(h.writes).toEqual([]);
});
it("foreign freshness drift and lost exclusive admission perform zero writes", async () => {
  for (const key of ["assertFresh", "assertExclusiveWriter"] as const) {
    const h = await harness();
    h.input[key] = async () => {
      throw new Error("SYNTHETIC_GATE");
    };
    await expect(applyFinalRetrospective(h.input)).rejects.toThrow("SYNTHETIC_GATE");
    expect(h.writes).toEqual([]);
  }
});
it("gapped and conflicting target fail before mutation", async () => {
  for (const gap of [true, false]) {
    const h = await harness();
    const r = clone(plan.newAdoptedSessions[gap ? 5 : 0]!);
    if (!gap) (r as any).foreign = true;
    h.data.sessions.set(sessionKey(r.bookId, r.receipt.date), r);
    await expect(applyFinalRetrospective(h.input)).rejects.toThrow();
    expect(h.writes).toEqual([]);
  }
});
const rehashedMutations: Array<[string, (p: any) => void]> = [
  ["extra scope", (p) => (p.expectedNewModelSessions = 12)],
  ["historical claim", (p) => (p.historicalAvailabilityClaim = true)],
  ["source mutation", (p) => (p.sourceRegistryMutation = true)],
  ["integrated mutation", (p) => (p.integratedMutation = true)],
  ["actual mutation", (p) => (p.actualMutation = true)],
  ["wrong dates", (p) => (p.preparation.scope.dates = ["2026-10-27", "2026-10-28"])],
  ["inner preparation", (p) => (p.preparation.capturedAt = "2026-10-28T00:00:00Z")],
  ["legacy receipt", (p) => (p.legacyReceipt.foreign = true)],
  ["legacy approval", (p) => (p.legacyApprovalCandidate.foreign = true)],
  ["output omission", (p) => p.newAdoptedSessions.pop()],
  ["archive order", (p) => p.newArchives.reverse()],
  ["prepared order", (p) => p.preparedPublications.reverse()],
  ["run tamper", (p) => (p.preparedPublications[0].entries[0].run.result.foreign = true)],
];
it.each(rehashedMutations)(
  "rehashed adversarial %s still fails before mutation",
  async (_, mutate) => {
    const h = await harness();
    mutate(h.input.plan);
    h.input.authoritativePlanHash = await hashSeriesValue(h.input.plan);
    h.input.approval = await finalApprovalCandidate(h.input.plan);
    h.input.authoritativeApprovalHash = await hashSeriesValue(h.input.approval);
    await expect(applyFinalRetrospective(h.input)).rejects.toThrow();
    expect(h.writes).toEqual([]);
  },
);
it("legacy rehearsal failure cannot leave adopted-model partial writes", async () => {
  const h = await harness();
  vi.mocked(applyPreparedKospiRetrospective).mockRejectedValueOnce(
    new Error("SYNTHETIC_LEGACY_FAILURE"),
  );
  await expect(applyFinalRetrospective(h.input)).rejects.toThrow("SYNTHETIC_LEGACY_FAILURE");
  expect(h.writes).toEqual([]);
  expect(h.data.sessions.size).toBe(60);
});
it("preexisting valid Oct28 other-consumer archive stays byte-exact while distinct new archive appends by hash", async () => {
  const c = clone(capture);
  // Valid archive schema, but another consumer's actual snapshot observation time.
  const existing = clone(plan.newArchives[0]!);
  existing.inputs.snapshots[0]!.savedAt = "2026-10-30T00:48:00Z";
  const oldHash = await hashSeriesValue(existing);
  c.archives.push({ payload: existing, hash: oldHash });
  const before = clone(c);
  const nextPlan = await prepareFinalRetrospective(c);
  expect(c).toEqual(before);
  expect(nextPlan.expectedNewModelSessions).toBe(10);
  expect(nextPlan.expectedNewLegacySessions).toBe(2);
  const generated = nextPlan.newArchives.find((x) => x.date === "2026-10-28")!;
  const newHash = await hashSeriesValue(generated);
  expect(newHash).not.toBe(oldHash);
  const h = await harness(nextPlan);
  const oldKey = "2026-10-28:" + oldHash;
  h.data.archives.set(oldKey, clone(existing));
  const initialCount = h.data.archives.size;
  await applyFinalRetrospective(h.input);
  expect(h.data.archives.get(oldKey)).toEqual(existing);
  expect(h.data.archives.get("2026-10-28:" + newHash)).toEqual(generated);
  expect(h.data.archives.size).toBe(initialCount + 2);
  expect(h.data.sessions.size).toBe(70);
  await applyFinalRetrospective(h.input);
  expect(h.data.archives.get(oldKey)).toEqual(existing);
  expect(h.data.archives.size).toBe(initialCount + 2);
});
it("preexisting target-date archive with mismatched payload hash fails before planning", async () => {
  const c = clone(capture);
  c.archives.push({ payload: clone(plan.newArchives[0]!), hash: H("f") });
  await expect(prepareFinalRetrospective(c)).rejects.toThrow("CAPTURED_ARCHIVE_HASH");
});
it.each(["missing october", "missing kospi", "extra key"])(
  "runtime exact-key regression: %s rejected",
  async (mode) => {
    const c = clone(capture);
    if (mode === "missing october") delete (c.runtimeHashes as any).october;
    else if (mode === "missing kospi") delete (c.runtimeHashes as any).kospi;
    else (c.runtimeHashes as any).integrated = H();
    await expect(prepareFinalRetrospective(c)).rejects.toThrow("RUNTIME");
  },
);
it("legacy preparation excludes only original correction approval; apply receipt retains approval and journal", async () => {
  const c = clone(capture);
  const journalPath = `${OWNER}/${KOSPI_SHADOW_NAMESPACE}/latest.json`;
  const journalPayload = { syntheticLegacyOnly: true, role: "MOCK_JOURNAL" };
  c.legacyObjects[journalPath] = {
    payload: journalPayload,
    hash: await hashSeriesValue(journalPayload),
  };
  const before = clone(c.legacyObjects);
  const prepared = await prepareFinalRetrospective(c);
  const call = vi.mocked(prepareKospiFinalRetrospective).mock.calls.at(-1)![0];
  expect(call.objects).toEqual({ [journalPath]: before[journalPath] });
  expect(call.objects).not.toHaveProperty(correctionApprovalPath);
  expect(prepared.legacyReceipt.kospi.capturedObjects).toEqual(
    Object.entries(before).map(([path, value]) => ({ path, ...value })),
  );
  expect(c.legacyObjects).toEqual(before);
});
it.each(["missing", "hash mismatch"])(
  "original correction approval %s fails closed",
  async (mode) => {
    const c = clone(capture);
    if (mode === "missing") delete c.legacyObjects[correctionApprovalPath];
    else c.legacyObjects[correctionApprovalPath]!.hash = H("f");
    await expect(prepareFinalRetrospective(c)).rejects.toThrow(
      mode === "missing" ? "ORIGINAL_CORRECTION_APPROVAL" : "LEGACY_CAPTURE_HASH",
    );
  },
);
it.each(["VALIDATE", "APPLY"] as const)(
  "%s rejects second target prepared conflict before all writes",
  async (phase) => {
    const h = await harness();
    const conflict = clone(plan.preparedPublications[1]!);
    conflict.sourceHash = H("f");
    h.data.prepared.set("KR:2026-10-29", conflict);
    h.input.phase = phase;
    await expect(applyFinalRetrospective(h.input)).rejects.toThrow("EXISTING_PREPARED_CONFLICT");
    expect(h.writes).toEqual([]);
    expect(h.appends()).toBe(0);
    expect(h.data.sessions.size).toBe(60);
  },
);
it("exact preexisting prepared pair is admitted and remains identical", async () => {
  const h = await harness();
  for (const pub of plan.preparedPublications) h.data.prepared.set(`KR:${pub.date}`, clone(pub));
  h.input.phase = "VALIDATE";
  expect((await applyFinalRetrospective(h.input)).status).toBe("VALIDATED");
  expect(h.writes).toEqual([]);
  h.input.phase = "APPLY";
  await applyFinalRetrospective(h.input);
  for (const pub of plan.preparedPublications)
    expect(h.data.prepared.get(`KR:${pub.date}`)).toEqual(pub);
});
it("unreferenced valid predecessor-date archive variant is ignored analytically and preserved", async () => {
  const c = clone(capture);
  const other = clone(c.archives[0]!.payload);
  other.inputs.snapshots[0]!.savedAt = "2026-10-30T00:48:00Z";
  const hash = await hashSeriesValue(other);
  c.archives.push({ payload: other, hash });
  const before = clone(c.archives);
  const next = await prepareFinalRetrospective(c);
  expect(c.archives).toEqual(before);
  expect(next.newArchives).toEqual(plan.newArchives);
  // Capture/provenance hashes legitimately differ because the full preserved
  // inventory includes another variant; generated analytical archives do not.
  expect(next.newAdoptedSessions).toHaveLength(10);
  const h = await harness(next);
  const key = `${other.date}:${hash}`;
  h.data.archives.set(key, clone(other));
  await applyFinalRetrospective(h.input);
  expect(h.data.archives.get(key)).toEqual(other);
  expect(h.data.sessions.size).toBe(70);
});
it("missing exact predecessor archive reference cannot be replaced with valid same-date variant", async () => {
  const c = clone(capture);
  const index = c.archives.findIndex((a) =>
    c.predecessors.some(
      ({ run }) =>
        "frozenInputArchive" in run &&
        run.frozenInputArchive?.days.some(
          (ref) => ref.date === a.payload.date && ref.hash === a.hash,
        ),
    ),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  const original = c.archives.splice(index, 1)[0]!;
  const variant = clone(original.payload);
  variant.inputs.snapshots[0]!.savedAt = "2026-10-30T00:48:00Z";
  c.archives.push({ payload: variant, hash: await hashSeriesValue(variant) });
  await expect(prepareFinalRetrospective(c)).rejects.toThrow("PREDECESSOR_ARCHIVE_REFERENCE");
});

it("compact capture restores exact full inputs while keeping stored and decoded identities distinct", async () => {
  const original = clone(capture);
  const compact = await encodeFinalCapture(original);
  expect(await hydrateFinalCapture(compact)).toEqual(original);
  const compactPlan = await prepareFinalRetrospective(compact);
  expect(compactPlan.captureHash).toBe(await hashSeriesValue(compact));
  expect(compactPlan.captureHash).not.toBe(await hashSeriesValue(original));
  expect(compactPlan.preparation.decodedCaptureHash).toBe(await hashSeriesValue(original));
  expect(compactPlan.preparation.basis.datasetHash).toBe(plan.preparation.basis.datasetHash);
  expect(compactPlan.preparation.preservationBaseline).toEqual(
    plan.preparation.preservationBaseline,
  );
  expect(compactPlan.newArchives).toEqual(plan.newArchives);
  expect(compactPlan.newAdoptedSessions).toHaveLength(10);
  expect(original).toEqual(capture);
  const h = await harness(compactPlan);
  h.input.phase = "VALIDATE";
  expect((await applyFinalRetrospective(h.input)).status).toBe("VALIDATED");
  expect(h.writes).toEqual([]);
});

it("fixed diagnostic stages preserve exact complete plan and never emit private values", async () => {
  const stages: string[] = [];
  const observed = await prepareFinalRetrospective(clone(capture), (stage) => stages.push(stage));
  expect(await hashSeriesValue(observed)).toBe(await hashSeriesValue(plan));
  expect(stages.slice(0, 3)).toEqual(["HYDRATE", "IDENTITY", "SOURCE_AUTHORITY"]);
  expect(stages).toContain("ANALYZE_28");
  expect(stages).toContain("ANALYZE_29");
  expect(stages).toContain("ADOPTED_28");
  expect(stages).toContain("ADOPTED_29");
  for (let i = 0; i < 5; i++) {
    expect(stages).toContain(`MODEL_READ_${i}`);
    expect(stages.filter((stage) => stage === `MODEL_APPEND_${i}`)).toHaveLength(2);
  }
  expect(stages.at(-1)).toBe("PLAN_ASSEMBLE");
  expect(stages.every((stage) => /^[A-Z][A-Z0-9_]+$/.test(stage))).toBe(true);
  expect(stages.join(" ")).not.toContain(capture.owner);
});

it("diagnostic hydration failure cannot reach later computation", async () => {
  const broken = await encodeFinalCapture(clone(capture));
  broken.decodedCaptureHash = H();
  const stages: string[] = [];
  await expect(prepareFinalRetrospective(broken, (stage) => stages.push(stage))).rejects.toThrow();
  expect(stages).toEqual(["HYDRATE"]);
});
