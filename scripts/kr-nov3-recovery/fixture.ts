/* eslint-disable @typescript-eslint/no-explicit-any */
/** Genuine frozen engine fixture; no production data, IO or credentials. */
import { KINDS } from "./core";
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
export async function nov3Fixture() {
  const data: MemoryData = {
    series: new Map(),
    sessions: new Map(),
    prepared: new Map(),
    archives: new Map(),
  };
  const store = plainStore(data),
    dates: string[] = [];
  for (
    let date: string | null = "2026-10-12";
    date && date <= "2026-11-03";
    date = nextKrRegularSession(date)
  )
    dates.push(date);
  for (const kind of KINDS)
    await store.insertSeries(
      await freezeRestartSeries({
        kind: kind as any,
        frozenAt: "2026-10-09T00:00:00Z",
        codeHash: H(),
        sourceHash: H("b"),
      }),
    );
  const make = (date: string) => {
    const p = publication(date);
    const instrument = { ...p.dataset.instruments[1]!, symbol: "018000", name: "Synthetic Unison" };
    p.dataset.instruments.push(instrument);
    p.dataset.bars["018000"] = clone(p.dataset.bars["000002"]!);
    p.dataset.observedBars = clone(p.dataset.bars);
    p.analysis.rows.push({ ...p.analysis.rows[1]!, instrument });
    p.dataset.tradeDates = ["2026-10-08", ...dates.filter((d) => d <= date)];
    p.dataset.kospiGateDates = [...p.dataset.tradeDates];
    p.universeEvidence.asOfDate = dates[dates.indexOf(date) - 1] ?? "2026-10-08";
    for (const row of p.analysis.rows)
      if (row.etfStrategy) row.etfStrategy.previousDate = p.universeEvidence.asOfDate;
    for (const i of p.dataset.instruments)
      Object.assign(i, { indexMemberships: [], listedDate: "2000-01-01" });
    return p;
  };
  for (const date of dates.slice(0, -1)) await recordOctoberPublication(store, make(date));
  const p = make("2026-11-03");
  for (const [symbol, bars] of Object.entries(p.dataset.bars)) {
    const bar = clone(bars[0]!);
    bars.splice(
      0,
      bars.length,
      ...p.dataset.tradeDates.map((tradeDate) => ({ ...bar, tradeDate })),
    );
    if (symbol === "018000")
      for (const row of bars) {
        for (const k of ["open", "high", "low", "close"] as const) row[k] *= 5;
        if (row.tradeDate >= "2026-10-12" && row.tradeDate <= "2026-10-14") {
          row.volume = Math.floor(row.volume / 5);
          row.tradingValue = row.close * row.volume;
        }
      }
  }
  p.dataset.observedBars = clone(p.dataset.bars);
  for (const index of p.dataset.indexSeries) {
    const bar = clone(index.bars[0]!);
    index.bars = p.dataset.tradeDates.map((tradeDate) => ({ ...bar, tradeDate }));
  }
  const firstReceipt: any = {
    version: "kr-source-vintage-review-v1",
    reviewId: "reviewed-kr-vintage-v1",
    reviews: ["2026-10-12", "2026-10-13"].map((date) => ({
      id: "reviewed-kr-vintage-v1",
      symbol: "UNRELATED1",
      date,
      notBefore: "2026-10-14",
      archivedHash: H("a"),
      incomingHash: H("b"),
      evidenceUrl: "https://dart.fss.or.kr/synthetic",
    })),
  };
  const first: any = {
    receipt: firstReceipt,
    registry: {
      version: "kr-source-vintage-approval-v1",
      reviewId: "reviewed-kr-vintage-v1",
      status: "APPROVED",
      receiptHash: await hashSeriesValue(firstReceipt),
      policy: KR_SOURCE_VINTAGE_POLICY,
    },
  };
  const receipt: any = {
    version: "kr-source-vintage-review-v2",
    reviewId: "reviewed-kr-vintage-v2",
    parentReceiptHash: await hashSeriesValue(firstReceipt),
    reviews: [
      ...firstReceipt.reviews,
      {
        id: "reviewed-kr-vintage-v2",
        symbol: "UNRELATED2",
        date: "2026-10-14",
        notBefore: "2026-10-27",
        archivedHash: H("a"),
        incomingHash: H("b"),
        evidenceUrl: "https://dart.fss.or.kr/synthetic",
      },
    ],
  };
  const sourceVintageApproval: any = {
    receipt,
    registry: {
      version: "kr-source-vintage-approval-v2",
      reviewId: "reviewed-kr-vintage-v2",
      status: "APPROVED",
      receiptHash: await hashSeriesValue(receipt),
      parentRegistryHash: await hashSeriesValue(first.registry),
      policy: KR_SOURCE_VINTAGE_POLICY,
    },
    predecessor: first,
  };
  const c: FinalCaptureV1 = {
    version: "kr-final-retrospective-capture-v1",
    owner: OWNER,
    codeCommit: "a".repeat(40),
    runtimeHashes: { october: H(), kospi: H("b") },
    capturedAt: "2026-11-04T01:00:00Z",
    computedAt: "2026-11-04T01:01:00Z",
    sourceManifest: { synthetic: true },
    captureManifest: {
      synthetic: true,
      sourceObjects: [
        { id: OWNER, storedHash: H("e"), path: "synthetic", generation: { synthetic: true } },
      ],
      unisonRawEvidence: {
        sourceId: OWNER,
        sourceHash: H("e"),
        rows: ["2026-10-12", "2026-10-13", "2026-10-14"].map((date) => ({
          date,
          symbol: "018000",
          shortSellingVolume: 0,
          tradingValueSource: "CLOSE_X_VOLUME_PROXY",
          investorValueSource: "TOSS_NET_VOLUME_X_CLOSE_PROXY",
        })),
      },
    },
    preservationBaseline: { synthetic: true },
    finalPublication: { hash: H("c"), activatedAt: "2026-11-04T00:39:00Z", asOfDate: "2026-11-03" },
    dataset: p.dataset,
    config: p.config,
    sourceVintageApproval,
    predecessors: await Promise.all(
      KINDS.map(async (kind) => {
        const series = data.series.get("adopted-shadow-2026-10-12-v1:" + kind)!;
        const run = data.sessions.get(sessionKey(series.bookId, "2026-11-02"))!;
        return { series, run, payloadHash: await hashSeriesValue(run) };
      }),
    ),
    archives: await Promise.all(
      [...data.archives.values()].map(async (payload) => ({
        payload,
        hash: await hashSeriesValue(payload),
      })),
    ),
    legacyObjects: {},
  };
  return { capture: c, data };
}
