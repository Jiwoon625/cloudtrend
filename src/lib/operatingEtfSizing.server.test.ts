import { describe, expect, it } from "vitest";
import { buildOperatingEtfSizingSnapshot, datedOperatingSource } from "./operatingEtfSizing.server";
import { emptyNewActualMetadata, type NewActualExecution } from "./newActualPortfolio";
import type { NewActualDocument } from "./newActualPortfolio.server";
import type { DashboardIndex } from "./dashboardOperations";
import { prepareEtfSignalBudget, type OperatingCashAuthority } from "./operatingAllocation";
const hash = `sha256:${"a".repeat(64)}`;
function fixture() {
  const metadata = emptyNewActualMetadata();
  metadata.cashEvents.push({
    id: "fund-1",
    date: "2026-10-12",
    kind: "DEPOSIT",
    amount: 1000,
    reference: "fund-1",
  });
  const document: NewActualDocument = { executions: [], newActualPortfolio: metadata };
  function buy(
    id: string,
    date: string,
    market: "ETF" | "KOSPI",
    shares: number,
    price: number,
    symbol: string,
  ) {
    const execution: NewActualExecution = {
      id,
      date,
      market,
      shares,
      price,
      symbol,
      name: symbol,
      fee: 0,
      side: "BUY",
      order: document.executions.length,
      note: "",
      signalKey: null,
    };
    document.executions.push(execution);
    metadata.assignments[id] = {
      executionId: id,
      quantity: shares,
      gross: shares * price,
      fee: 0,
      brokerReference: id,
    };
  }
  buy("etf-d", "2026-10-12", "ETF", 5, 100, "123456");
  buy("kr-d", "2026-10-12", "KOSPI", 2, 100, "654321");
  const authority: OperatingCashAuthority = {
    version: 1,
    currency: "KRW",
    sourceRevision: 3,
    sourceFingerprint: hash,
    cashAtReview: "300",
    claims: { KR: "200", ETF: "100", US: "0", UNASSIGNED: "0" },
    spendableCash: null,
    reservations: [],
    reviewedAt: "2026-10-12T08:00:00Z",
  };
  document["operatingCashHistory"] = [
    {
      authority,
      economicSourceFingerprint: datedOperatingSource(document, "2026-10-12")
        .economicSourceFingerprint,
    },
  ];
  const index: DashboardIndex = {
    date: "2026-10-12",
    screeningCreatedAt: "2026-10-12T07:00:00Z",
    tradeDates: ["2026-10-12"],
    rows: [
      {
        market: "ETF",
        symbol: "123456",
        name: "ETF",
        sector: "",
        date: "2026-10-12",
        price: 110,
        score: 80,
        priority: 1,
        onset: false,
        exitReason: null,
      },
    ],
  };
  return { document, metadata, authority, index, buy };
}
describe("ETF completed-close actual sleeve NAV", () => {
  it("values D holdings plus D ETF cash claim, never the whole shared KRW pool", async () => {
    const f = fixture();
    const snapshot = await buildOperatingEtfSizingSnapshot({ ...f, decisionDate: "2026-10-12" });
    expect(snapshot.nav).toBe("650");
    expect(snapshot.cashClaim).toBe("100");
    expect(snapshot.holdingsValue).toBe("550");
    expect(
      prepareEtfSignalBudget({
        id: "signal",
        snapshot,
        signalDate: "2026-10-12",
        decisionDate: "2026-10-12",
        etfWeight: "0.075",
        sourceFingerprint: hash,
      }).amount,
    ).toBe("48.75");
  });
  it("excludes D+1 fills before reconstructing shares and cash", async () => {
    const f = fixture();
    f.buy("etf-next", "2026-10-13", "ETF", 1, 120, "123456");
    f.metadata.cashEvents.push({
      id: "future-funding",
      date: "2026-10-13",
      kind: "DEPOSIT",
      amount: 999,
      reference: "future-funding",
    });
    const snapshot = await buildOperatingEtfSizingSnapshot({ ...f, decisionDate: "2026-10-12" });
    expect(snapshot.nav).toBe("650");
    expect(snapshot.holdingsValue).toBe("550");
    expect(datedOperatingSource(f.document, "2026-10-12").source.executions).toHaveLength(2);
  });
  it("requires historical cash ownership even when current pool cash is known", async () => {
    const f = fixture();
    f.document["operatingCashHistory"] = [];
    f.document["operatingCashAuthority"] = f.authority;
    await expect(
      buildOperatingEtfSizingSnapshot({ ...f, decisionDate: "2026-10-12" }),
    ).rejects.toThrow(/ownership evidence/);
  });
  it("does not reuse claims after a corrected original D fill", async () => {
    const f = fixture();
    f.document.executions[0]!.price = 101;
    f.metadata.assignments["etf-d"]!.gross = 505;
    await expect(
      buildOperatingEtfSizingSnapshot({ ...f, decisionDate: "2026-10-12" }),
    ).rejects.toThrow(/ownership evidence/);
  });
  it.each(["missing", "stale", "future", "zero"] as const)(
    "holds when a required D quote is %s",
    async (kind) => {
      const f = fixture();
      if (kind === "missing") f.index.rows = [];
      if (kind === "stale") f.index.rows[0]!.date = "2026-10-08";
      if (kind === "future") f.index.rows[0]!.date = "2026-10-13";
      if (kind === "zero") f.index.rows[0]!.price = 0;
      await expect(
        buildOperatingEtfSizingSnapshot({ ...f, decisionDate: "2026-10-12" }),
      ).rejects.toThrow(/D close missing/);
    },
  );
  it("rejects current-position fallback when the latest screening is after D", async () => {
    const f = fixture();
    f.index.date = "2026-10-13";
    await expect(
      buildOperatingEtfSizingSnapshot({ ...f, decisionDate: "2026-10-12" }),
    ).rejects.toThrow(/dated completed/);
  });
  it.each(["2026-10-12T05:00:00Z", "2026-10-13T00:01:00Z"])(
    "rejects incomplete/late publication %s",
    async (createdAt) => {
      const f = fixture();
      f.index.screeningCreatedAt = createdAt;
      await expect(
        buildOperatingEtfSizingSnapshot({ ...f, decisionDate: "2026-10-12" }),
      ).rejects.toThrow(/published/);
    },
  );
  it("does not backdate a late cash-claim review", async () => {
    const f = fixture();
    f.authority.reviewedAt = "2026-10-13T00:01:00Z";
    await expect(
      buildOperatingEtfSizingSnapshot({ ...f, decisionDate: "2026-10-12" }),
    ).rejects.toThrow(/ownership evidence/);
  });
});
