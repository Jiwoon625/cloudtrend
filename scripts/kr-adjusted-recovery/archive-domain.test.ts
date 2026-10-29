/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from "vitest";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { recoveryFixture } from "./recovery-model-plan-fixture";
import {
  verifyArchivePrefixBodies,
  verifyArchiveDomainModels,
  nonTargetDatasetIdentity,
  classifyPreExistingObservation,
  verifyArchiveObservationInventory,
  OBSERVATION_ONLY,
} from "./archive-domain";
let models: any[], archives: any[], prefixes: any[], pair: any;
const target = "999999",
  other = "888888";
const bar = (date: string, close: number) => ({
  tradeDate: date,
  open: close,
  high: close,
  low: close,
  close,
  volume: 0,
});
beforeAll(async () => {
  const f = await recoveryFixture();
  models = await Promise.all(
    f.predecessors.map(async ({ series, run }) => ({
      series,
      run,
      pin: {
        seriesId: series.bookId,
        sessionDate: run.receipt.date,
        stateHash: run.stateHash,
        payloadHash: await hashSeriesValue(run),
      },
    })),
  );
  archives = await Promise.all(
    [...f.original.archives.values()].map(async (payload) => {
      const hash = await hashSeriesValue(payload);
      return {
        payload,
        reference: {
          date: payload.date,
          sourceHash: hash,
          payloadHash: hash,
          sourceId: `october-input:KR:${payload.date}:${hash.slice(7)}`,
          sourceRevision: "1",
        },
      };
    }),
  );
  prefixes = await verifyArchivePrefixBodies(models, archives);
  const old = bar("2026-10-06", 100),
    incoming = bar("2026-10-06", 50),
    hash = "sha256:" + "e".repeat(64);
  pair = {
    symbol: other,
    date: old.tradeDate,
    archived: old,
    incoming,
    archivedHash: await hashSeriesValue(old),
    incomingHash: await hashSeriesValue(incoming),
    archiveHash: hash,
    archiveSourceId: `october-input:KR:${old.tradeDate}:${hash.slice(7)}`,
    fields: ["close", "high", "low", "open"],
  };
}, 30000);
describe("unapproved pre-existing observation domain", () => {
  it("verifies genuine five-book heads and every archived regular-session prefix", async () => {
    expect(prefixes.length).toBe(30);
    expect(new Set(prefixes.map((p) => p.date)).size).toBe(10);
    expect(
      await verifyArchiveDomainModels(
        models,
        models.map((m) => m.pin),
        archives.map((a) => a.reference),
      ),
    ).toEqual(prefixes);
  });
  it.each(["missing", "gap", "hash", "contract", "head"])(
    "rejects %s prefix authority",
    async (kind) => {
      const m = structuredClone(models),
        a = structuredClone(archives);
      const k = m.find((x) => x.series.policy.kind === "KR_MIXED");
      if (kind === "missing") delete k.run.frozenInputArchive;
      if (kind === "gap") k.run.frozenInputArchive.days.splice(1, 1);
      if (kind === "hash") a[0].payload.inputs.bars = {};
      if (kind === "contract") k.series.accountingStartDate = "2026-10-06";
      if (kind === "head") k.run.result.summary = { synthetic: true };
      await expect(verifyArchivePrefixBodies(m, a)).rejects.toThrow();
    },
  );
  it("does not treat a same-date different-hash reference as unreferenced", async () => {
    await expect(
      classifyPreExistingObservation(pair, pair.incoming, models, [
        { date: pair.date, hash: "other", sourceId: "other" },
      ]),
    ).rejects.toThrow();
    await expect(
      classifyPreExistingObservation(pair, pair.incoming, models, [
        { date: "2026-10-12", hash: pair.archiveHash, sourceId: "other" },
      ]),
    ).rejects.toThrow();
    await expect(
      classifyPreExistingObservation(pair, pair.incoming, models, [
        { date: "2026-10-12", hash: "other", sourceId: pair.archiveSourceId },
      ]),
    ).rejects.toThrow();
  });
  it("records existing prestart differences without new review authority or input mutation", async () => {
    const before = structuredClone({ pair, models, prefixes });
    const v = await classifyPreExistingObservation(pair, pair.incoming, models, prefixes);
    expect(v.classification).toBe(OBSERVATION_ONLY);
    expect(v.operationalApproval).toBe(false);
    expect(v.baselineIncomingHash).toBe(pair.incomingHash);
    expect({ pair, models, prefixes }).toEqual(before);
    expect(v).not.toHaveProperty("id");
    expect(v).not.toHaveProperty("notBefore");
  });
  it.each(["in-period", "missing", "introduced", "other-start"])(
    "rejects %s observation classification",
    async (kind) => {
      const p = structuredClone(pair),
        m = structuredClone(models);
      let baseline = structuredClone(pair.incoming);
      if (kind === "in-period") p.date = "2026-10-14";
      if (kind === "missing") baseline = null;
      if (kind === "introduced") baseline.close++;
      if (kind === "other-start") m[0].series.accountingStartDate = "2026-10-02";
      await expect(classifyPreExistingObservation(p, baseline, m, prefixes)).rejects.toThrow();
    },
  );
  it("excludes only target bars while preserving all non-target rolling inputs and context", async () => {
    const base = {
      bars: { [target]: [bar("2026-10-06", 100)], [other]: [pair.incoming] },
      observedBars: { [target]: [bar("2026-10-06", 100)], [other]: [pair.incoming] },
      instruments: [{ symbol: target }, { symbol: other }],
      indexSeries: [{ close: 123 }],
      context: { value: 1 },
    };
    const next = structuredClone(base);
    next.bars[target][0].close = 50;
    next.observedBars[target][0].close = 50;
    const identity = await nonTargetDatasetIdentity(base, next, target);
    expect(identity.baselineNonTargetHash).toBe(identity.candidateNonTargetHash);
    expect(identity.baselineDatasetHash).not.toBe(identity.candidateDatasetHash);
    for (const mutate of [
      (x: any) => {
        x.bars[other][0].close++;
      },
      (x: any) => {
        x.observedBars[other] = [];
      },
      (x: any) => {
        x.instruments[0].name = "changed";
      },
      (x: any) => {
        x.indexSeries[0].close++;
      },
      (x: any) => {
        x.context.value++;
      },
    ]) {
      const wrong = structuredClone(next);
      mutate(wrong);
      await expect(nonTargetDatasetIdentity(base, wrong, target)).rejects.toThrow();
    }
  });
  async function receipt() {
    const observation = await classifyPreExistingObservation(pair, pair.incoming, models, prefixes);
    const refs = [
      ...archives.map((a) => a.reference),
      { sourceId: pair.archiveSourceId, date: pair.date, sourceHash: pair.archiveHash },
    ];
    return {
      scope: { symbol: target },
      modelPins: models.map((m) => m.pin),
      archiveReferences: refs,
      candidate: {
        datasetHash: "sha256:" + "a".repeat(64),
        overlay: { baseDatasetHash: "sha256:" + "b".repeat(64) },
      },
      archivePairs: [],
      retainedPairs: [],
      vintageV1: { receipt: { reviews: [] } },
      vintageReviewProposal: { reviews: [] },
      historicalCoverage: { missingOtherRows: [] },
      archiveObservationInventory: {
        version: "kr-preexisting-archive-observation-inventory-v1",
        classificationPolicy: OBSERVATION_ONLY,
        operationalApproval: false,
        targetSymbol: target,
        models,
        executionPrefixReferences: prefixes,
        datasetIdentity: {
          excludedTargetSymbol: target,
          candidateDatasetHash: "sha256:" + "a".repeat(64),
          baselineDatasetHash: "sha256:" + "b".repeat(64),
          baselineNonTargetHash: "sha256:" + "c".repeat(64),
          candidateNonTargetHash: "sha256:" + "c".repeat(64),
        },
        preExistingUnreferenced: [observation],
        coverageComplete: true,
        scannedArchives: refs.map((r) => ({
          sourceId: r.sourceId,
          total: 1,
          unchanged: r.sourceId === pair.archiveSourceId ? 0 : 1,
          targetChanged: 0,
          v1Retained: 0,
          preExistingUnreferenced: r.sourceId === pair.archiveSourceId ? 1 : 0,
          missing: 0,
        })),
      },
    };
  }
  it("verifier binds every inventory category and excludes diagnostic pairs from authority", async () => {
    const p = await receipt();
    await expect(verifyArchiveObservationInventory(p)).resolves.toBeUndefined();
    const promoted = structuredClone(p);
    promoted.vintageReviewProposal.reviews.push({ symbol: other, date: pair.date } as never);
    await expect(verifyArchiveObservationInventory(promoted)).rejects.toThrow();
    const omitted = structuredClone(p);
    omitted.archiveObservationInventory.preExistingUnreferenced = [];
    await expect(verifyArchiveObservationInventory(omitted)).rejects.toThrow();
    const wrong = structuredClone(p);
    wrong.archiveObservationInventory.models[0].pin.payloadHash = "sha256:" + "d".repeat(64);
    await expect(verifyArchiveObservationInventory(wrong)).rejects.toThrow();
    const wrongBaseline = structuredClone(p);
    wrongBaseline.candidate.overlay.baseDatasetHash = "sha256:" + "d".repeat(64);
    await expect(verifyArchiveObservationInventory(wrongBaseline)).rejects.toThrow();
  });
  it("retains explicit pre-existing missing observation without claiming equal unseen prices", async () => {
    const p: any = await receipt(),
      scan = p.archiveObservationInventory.scannedArchives[0];
    scan.unchanged = 0;
    scan.missing = 1;
    p.historicalCoverage.missingOtherRows.push({
      symbol: "777777",
      date: p.archiveReferences[0].date,
      archiveSourceId: scan.sourceId,
      classification: "PRE_EXISTING_ABSENCE_NOT_APPROVED",
      baselineAndCandidateAbsent: true,
      operationalApproval: false,
    });
    p.archiveObservationInventory.coverageComplete = false;
    await expect(verifyArchiveObservationInventory(p)).resolves.toBeUndefined();
    p.historicalCoverage.missingOtherRows[0].baselineAndCandidateAbsent = false;
    await expect(verifyArchiveObservationInventory(p)).rejects.toThrow();
  });
});
