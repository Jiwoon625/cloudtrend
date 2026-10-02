import { describe, expect, it } from "vitest";
import {
  buildUsModelTaxProjection,
  type UsModelTaxSource,
  type UsModelTaxTiming,
} from "./usModelTaxProjection";
import { modelUsTaxOverlay } from "../usTaxOverlay";
import type { UsPortfolioSnapshotRecord } from "../usProspectiveCloud";
import { modelTaxFixture as source } from "../../../tests/fixtures/usModelTaxSource";
const timing: UsModelTaxTiming = {
  byTradeKey: {
    "buy-1": {
      settlementDate: "2026-09-30",
      krwPerUsd: 1300,
      fxSource: "dated official acquisition rate",
      settlementSource: "verified model convention",
      instrumentTaxKind: "FOREIGN_DIRECT_STOCK",
    },
    "sell-1": {
      settlementDate: "2026-09-30",
      krwPerUsd: 1400,
      fxSource: "dated official sale rate",
      settlementSource: "verified model convention",
      instrumentTaxKind: "FOREIGN_DIRECT_STOCK",
    },
  },
  valuationFx: null,
};
describe("complete model journal tax adapter", () => {
  it("derives genuine zero tax from a verified buy-only history without inventing FX", async () => {
    const input = source(),
      before = JSON.stringify(input);
    const r = await buildUsModelTaxProjection(input);
    expect(r.missingFields).toEqual([]);
    expect(r.taxEvidence!.evidence.sales).toEqual([]);
    const latest = input.snapshots.at(-1)!;
    const display = modelUsTaxOverlay({
      ...latest,
      state: { ...latest.state, taxEvidence: r.taxEvidence, taxSource: r.taxSource },
    } as unknown as UsPortfolioSnapshotRecord);
    expect(display.currentYearTaxKrw).toBe(0);
    expect(display.afterTaxNavUsd).toBe(latest.nav_usd);
    expect(display.assumptions.join(" ")).toContain("FIFO");
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([
    (s: UsModelTaxSource) => {
      s.snapshots.shift();
      s.completed.shift();
      s.sourceProofs.shift();
    },
    (s: UsModelTaxSource) => {
      s.registry.config = {};
    },
    (s: UsModelTaxSource) => {
      s.snapshots[0]!.state.positions = { ABC: { shares: 1, lastPrice: 1 } };
    },
    (s: UsModelTaxSource) => {
      s.completed.pop();
    },
    (s: UsModelTaxSource) => {
      s.sourceProofs[2]!.previousSessionDate = "2026-09-25";
    },
    (s: UsModelTaxSource) => {
      s.sourceProofs[1]!.dataHash = "wrong";
    },
    (s: UsModelTaxSource) => {
      s.trades = [];
    },
    (s: UsModelTaxSource) => {
      s.trades.push(structuredClone(s.trades[0]!));
    },
    (s: UsModelTaxSource) => {
      s.snapshots[2]!.cash_usd += 10;
    },
  ])("does not assert completeness for missing/faulty source %#", async (alter) => {
    const s = source();
    alter(s);
    const r = await buildUsModelTaxProjection(s);
    expect(r.taxEvidence).toBeNull();
    expect(r.missingFields.length).toBeGreaterThan(0);
  });
  it("requires sourced settlement/FX when a sell exists", async () => {
    const r = await buildUsModelTaxProjection(source(true));
    expect(r.taxEvidence).toBeNull();
    expect(r.missingFields.join(" ")).toContain("결제일·결제환율");
  });
  it("allocates FIFO gross basis without deducting the composite cost as a legal expense", async () => {
    const r = await buildUsModelTaxProjection(source(true), timing);
    expect(r.missingFields).toEqual([]);
    const sale = r.taxEvidence!.evidence.sales[0]!;
    expect(sale.grossProceedsUsd).toBe(480);
    expect(sale.acquisitionLots[0]!.grossCostUsd).toBe(400);
    expect(sale.eligibleDisposalExpenseKrw).toBe(0);
    expect(sale.acquisitionLots[0]!.eligibleAcquisitionExpenseKrw).toBe(0);
    expect(sale.basisMethod).toBe("FIFO_MODEL");
  });
  it("changes source provenance when the journal or timing source changes", async () => {
    const s = source(true);
    const a = await buildUsModelTaxProjection(s, timing);
    const changed = structuredClone(timing);
    changed.byTradeKey["buy-1"]!.fxSource = "corrected evidence";
    const b = await buildUsModelTaxProjection(s, changed);
    expect(a.taxSource?.ledgerDigest).not.toBe(b.taxSource?.ledgerDigest);
  });
  it.each([
    (t: UsModelTaxTiming) => {
      t.byTradeKey["sell-1"]!.settlementSource = "";
    },
    (t: UsModelTaxTiming) => {
      t.byTradeKey["sell-1"]!.settlementDate = "2026-01-01";
    },
    (t: UsModelTaxTiming) => {
      t.byTradeKey["sell-1"]!.settlementDate = "9999-99-99";
      t.byTradeKey["sell-1"]!.krwPerUsd = null;
    },
    (t: UsModelTaxTiming) => {
      t.byTradeKey["buy-1"]!.krwPerUsd = -5;
    },
    (t: UsModelTaxTiming) => {
      t.byTradeKey["buy-1"]!.fxSource = "";
    },
    (t: UsModelTaxTiming) => {
      t.byTradeKey["sell-1"]!.settlementDate = "2026-10-01";
    },
  ])("rejects malformed, unsourced, pre-trade or future-known FX timing %#", async (change) => {
    const t = structuredClone(timing);
    change(t);
    const r = await buildUsModelTaxProjection(source(true), t);
    expect(r.taxEvidence).toBeNull();
    expect(r.missingFields.length).toBeGreaterThan(0);
  });
  it("permits a verified cash-only bootstrap before freeze but rejects pre-freeze fills", async () => {
    const s = source();
    s.registry.frozen_at = "2026-09-29T00:00:00+09:00";
    expect((await buildUsModelTaxProjection(s)).taxEvidence).not.toBeNull();
    s.registry.frozen_at = "2026-09-30T00:00:00+09:00";
    expect((await buildUsModelTaxProjection(s)).taxEvidence).toBeNull();
  });
  it("produces a nonzero annual model estimate only with sourced settled FIFO inputs", async () => {
    const s = source(true),
      t = structuredClone(timing);
    const fill = s.trades[1]!;
    fill.model_price = 1200;
    fill.model_notional = 4800;
    fill.fee_usd = 12;
    const last = s.snapshots[2]!;
    last.cash_usd = last.state.cash = 103785.5;
    last.fees_usd = 12;
    last.state.positions["ABC"]!.lastPrice = 1200;
    last.nav_usd = 110985.5;
    t.valuationFx = { date: s.sourceDate, krwPerUsd: 1400, source: "dated valuation fixture" };
    const projected = await buildUsModelTaxProjection(s, t);
    const display = modelUsTaxOverlay({
      ...last,
      state: { ...last.state, taxEvidence: projected.taxEvidence, taxSource: projected.taxSource },
    } as unknown as UsPortfolioSnapshotRecord);
    expect(display.currentYearRealizedKrw).toBe(6200000);
    expect(display.currentYearTaxKrw).toBe(814000);
    expect(display.afterTaxNavUsd).toBe(110404.07);
    expect(last.nav_usd).toBe(110985.5);
  });
});
