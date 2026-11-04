/* eslint-disable @typescript-eslint/no-explicit-any */
/** Genuine frozen engine fixture; no production data, IO or credentials. */
import { beforeAll, expect, it } from "vitest";
import { prepareKrNov3Recovery, prepareUnisonVintageCandidate, KINDS } from "./core";
import {
  publication,
  plainStore,
  H,
  OWNER,
  clone,
  sessionKey,
  type MemoryData,
} from "../kr-adjusted-recovery/recovery-model-plan-fixture";
import { freezeRestartSeries, hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { recordOctoberPublication } from "../../src/lib/ledger/octoberShadowPipeline";
import { nextKrRegularSession } from "../../src/lib/ledger/krShadowDecision";
import { KR_SOURCE_VINTAGE_POLICY } from "../../src/lib/ledger/krSourceVintage";
import type { FinalCaptureV1 } from "../kr-final-retrospective/contracts";
let capture: FinalCaptureV1;
import { nov3Fixture } from "./fixture";

beforeAll(async () => {
  capture = (await nov3Fixture()).capture;
}, 60000);
it("derives 16 exact Unison pairs while retaining all previous authority", async () => {
  const before = clone(capture),
    a = await prepareUnisonVintageCandidate(capture);
  expect(a.receipt.reviews).toHaveLength(19);
  expect(a.receipt.reviews.slice(0, 3)).toEqual(capture.sourceVintageApproval.receipt.reviews);
  expect(capture).toEqual(before);
});
it("prepares exactly five genuine Nov3 append-only model sessions with late-source labels", async () => {
  const before = clone(capture),
    p = await prepareKrNov3Recovery(capture);
  expect(p.newAdoptedSessions).toHaveLength(5);
  expect(p.newArchives).toHaveLength(1);
  expect(p.preparedPublications).toHaveLength(1);
  expect(p.retrospectiveAuthorityCandidate.receipt.dates.map((d) => d.date)).toEqual([
    "2026-11-03",
  ]);
  for (const run of p.newAdoptedSessions) {
    expect(run.receipt.date).toBe("2026-11-03");
    expect(run.publication.reviewedRetrospective?.historicalAvailabilityClaim).toBe(false);
  }
  expect(p.actualMutation).toBe(false);
  expect(p.integratedMutation).toBe(false);
  expect(capture).toEqual(before);
}, 60000);
it.each(["ratio", "date", "duplicate", "auxiliary", "reference", "parent"])(
  "rejects unreviewed %s before candidate authority",
  async (kind) => {
    const c = clone(capture);
    if (kind === "ratio")
      c.dataset.bars["018000"]!.find((b) => b.tradeDate === "2026-10-12")!.close++;
    if (kind === "date")
      c.dataset.bars["018000"] = c.dataset.bars["018000"]!.filter(
        (b) => b.tradeDate !== "2026-10-12",
      );
    if (kind === "duplicate")
      c.dataset.bars["018000"]!.push(
        clone(c.dataset.bars["018000"]!.find((b) => b.tradeDate === "2026-10-12")!),
      );
    if (kind === "auxiliary")
      c.dataset.bars["018000"]!.find((b) => b.tradeDate === "2026-10-12")!.marketCap = 500;
    if (kind === "reference") c.archives[0]!.hash = H("e");
    if (kind === "parent") c.sourceVintageApproval = (c.sourceVintageApproval as any).predecessor;
    await expect(prepareUnisonVintageCandidate(c)).rejects.toThrow();
  },
);
async function auxiliaryFixture() {
  const c = clone(capture),
    target = c.archives.find((a) => a.payload.date === "2026-10-12")!;
  const old = target.payload.inputs.bars["018000"]![0]!;
  Object.assign(old, {
    volume: 1001436,
    tradingValue: old.close * 1001436,
    foreignNetBuyValue: 200,
    institutionNetBuyValue: -100,
    shortSellingVolumeRate: 0.07071,
  });
  target.hash = await hashSeriesValue(target.payload);
  for (const { run } of c.predecessors)
    if ("frozenInputArchive" in run && run.frozenInputArchive)
      for (const ref of run.frozenInputArchive.days)
        if (ref.date === "2026-10-12") ref.hash = target.hash;
  const incoming = c.dataset.bars["018000"]!.find((b) => b.tradeDate === "2026-10-12")!;
  Object.assign(incoming, {
    volume: 200287,
    tradingValue: incoming.close * 200287,
    foreignNetBuyValue: 1000,
    institutionNetBuyValue: -500,
    shortSellingVolumeRate: 0.35356,
  });
  const priorRows = (c.captureManifest as any).unisonRawEvidence.rows.filter(
    (r: any) => r.date !== "2026-10-12",
  );
  c.captureManifest = {
    sourceObjects: [
      { id: OWNER, storedHash: H("e"), path: "synthetic", generation: { synthetic: true } },
    ],
    unisonRawEvidence: {
      sourceId: OWNER,
      sourceHash: H("e"),
      rows: [
        ...priorRows,
        {
          date: "2026-10-12",
          symbol: "018000",
          shortSellingVolume: 70814,
          tradingValueSource: "CLOSE_X_VOLUME_PROXY",
          investorValueSource: "TOSS_NET_VOLUME_X_CLOSE_PROXY",
        },
      ],
    },
  };
  return c;
}
it("binds the limited adjusted volume, proxy amounts and rounded short rate to raw evidence", async () => {
  const c = await auxiliaryFixture();
  expect((await prepareUnisonVintageCandidate(c)).receipt.reviews).toHaveLength(19);
});
it.each(["volume", "turnover", "flow", "rate", "numerator", "source", "label", "key"])(
  "rejects unexpected adjusted auxiliary %s",
  async (kind) => {
    const c = await auxiliaryFixture(),
      b = c.dataset.bars["018000"]!.find((b) => b.tradeDate === "2026-10-12")!,
      e = (c.captureManifest as any).unisonRawEvidence;
    if (kind === "volume") b.volume++;
    if (kind === "turnover") b.tradingValue!++;
    if (kind === "flow") b.foreignNetBuyValue!++;
    if (kind === "rate") b.shortSellingVolumeRate = 0.3536;
    if (kind === "numerator")
      e.rows.find((r: any) => r.date === "2026-10-12").shortSellingVolume = 70815;
    if (kind === "source") delete (c.captureManifest as any).unisonRawEvidence;
    if (kind === "label")
      e.rows.find((r: any) => r.date === "2026-10-12").tradingValueSource = "UNRELATED";
    if (kind === "key") (b as any).openObserved = null;
    await expect(prepareUnisonVintageCandidate(c)).rejects.toThrow();
  },
);
it.each(["code", "runtime", "live"])("rejects coerced capture %s", async (kind) => {
  const c = clone(capture) as any;
  if (kind === "code") c.codeCommit = [c.codeCommit];
  if (kind === "runtime") c.runtimeHashes.kospi = [c.runtimeHashes.kospi];
  if (kind === "live") c.dataset.isLive = "true";
  await expect(prepareKrNov3Recovery(c)).rejects.toThrow();
});

it.each(["foreign", "institution", "volume"])(
  "rejects partial auxiliary reversion %s",
  async (kind) => {
    const c = await auxiliaryFixture(),
      b = c.dataset.bars["018000"]!.find((b) => b.tradeDate === "2026-10-12")!;
    if (kind === "foreign") b.foreignNetBuyValue = 200;
    if (kind === "institution") b.institutionNetBuyValue = -100;
    if (kind === "volume") b.volume = 1001436;
    await expect(prepareUnisonVintageCandidate(c)).rejects.toThrow();
  },
);
