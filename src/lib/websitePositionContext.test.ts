import { isHeldExit } from "./statusDisplay";
import type { ScreeningRow } from "./engine/pipeline";
import type { SupabaseClient } from "@supabase/supabase-js";
const mocks = vi.hoisted(() => ({ read: vi.fn(), shadow: vi.fn() }));
vi.mock("./ledger/websiteRepository.server", () => ({ readWebsiteDocument: mocks.read }));
vi.mock("./octoberShadowSummary.server", async (original) => ({
  ...(await original<typeof import("./octoberShadowSummary.server")>()),
  loadOctoberShadowSummaryForOwner: mocks.shadow,
}));
import { describe, expect, it, vi } from "vitest";
import {
  projectWebsitePositionContext,
  loadWebsitePositionContextForOwner,
} from "./websitePositionContext.server";
import { ADOPTED_SERIES_KINDS, RESTART_SERIES_VERSION } from "./ledger/modelSeries";
import { emptyNewActualMetadata, type NewActualExecution } from "./newActualPortfolio";
import { restartBook, restartSummary } from "../../tests/website-restart-fixtures";
const now = new Date("2026-10-14T22:00:00Z");
const fill = (id: string, date: string): NewActualExecution => ({
  id,
  date,
  order: 0,
  symbol: id,
  name: id,
  market: "KOSPI",
  side: "BUY",
  shares: 2,
  price: 100,
  fee: 0,
  signalKey: null,
  note: "",
});
async function summary() {
  const s = await restartSummary();
  s.books = await Promise.all(ADOPTED_SERIES_KINDS.map((k) => restartBook(k)));
  return s;
}
describe("website holdings new series boundary", () => {
  it("reads owner-scoped sources and explicitly requests restart even before the start date", async () => {
    mocks.read.mockResolvedValue({ payload: { executions: [fill("OLD", "2026-10-09")] } });
    mocks.shadow.mockResolvedValue(await summary());
    const client = {} as SupabaseClient;
    const result = await loadWebsitePositionContextForOwner(client, "owner");
    expect(mocks.shadow).toHaveBeenCalledWith(client, "owner", RESTART_SERIES_VERSION);
    expect(mocks.read).toHaveBeenCalledWith(client, "owner", "portfolio_ledgers");
    expect(mocks.read).toHaveBeenCalledWith(client, "owner", "us_actual_portfolio_ledgers");
    expect(result.heldSymbols).toEqual([]);
    mocks.shadow.mockRejectedValueOnce(new Error("source unavailable"));
    await expect(loadWebsitePositionContextForOwner(client, "owner")).rejects.toThrow(
      "source unavailable",
    );
  });
  it("shows an empty normal pre-start state even when old journals have holdings", async () => {
    const result = projectWebsitePositionContext(
      { executions: [fill("OLD", "2026-10-09")] },
      null,
      await summary(),
      new Date("2026-10-11T12:00:00Z"),
    );
    expect(result.heldSymbols).toEqual([]);
    expect(result.actualExecutions).toEqual([]);
    expect(result.actualPools.KRW.fundingStatus).toBe("PENDING");
  });
  it("never infers new membership from a post-start fill date", async () => {
    const result = projectWebsitePositionContext(
      { executions: [fill("UNASSIGNED", "2026-10-13")] },
      null,
      await summary(),
      now,
    );
    expect(result.heldSymbols).toEqual([]);
  });
  it("includes only the explicitly allocated slice and leaves journals unchanged", async () => {
    const metadata = emptyNewActualMetadata();
    metadata.assignments["NEW"] = {
      executionId: "NEW",
      quantity: 1,
      gross: 100,
      fee: 0,
      brokerReference: "approved",
    };
    const doc = {
      executions: [fill("OLD", "2026-10-09"), fill("NEW", "2026-10-13")],
      newActualPortfolio: metadata,
    };
    const original = structuredClone(doc);
    const result = projectWebsitePositionContext(doc, null, await summary(), now);
    expect(result.heldSymbols).toEqual(["NEW"]);
    expect(result.positions[0]?.shares).toBe(1);
    expect(result.actualExecutions[0]?.shares).toBe(1);
    expect(doc).toEqual(original);
  });
  it("resets the current holding entry date after a full close and reopening", async () => {
    const executions = [
      fill("a", "2026-10-12"),
      { ...fill("b", "2026-10-13"), side: "SELL" as const },
      fill("c", "2026-10-14"),
    ].map((e) => ({ ...e, symbol: "SAME" }));
    const metadata = emptyNewActualMetadata();
    for (const e of executions)
      metadata.assignments[e.id] = {
        executionId: e.id,
        quantity: 2,
        gross: 200,
        fee: 0,
        brokerReference: e.id,
      };
    const result = projectWebsitePositionContext(
      { executions, newActualPortfolio: metadata },
      null,
      await summary(),
      now,
    );
    expect(result.positions[0]?.firstEntryDate).toBe("2026-10-14");
    expect(result.lastSellDateBySymbol["SAME"]).toBe("2026-10-13");
  });
  it("includes only validated restart holdings and rejects future or market-less mixed holdings", async () => {
    const s = await summary();
    const book = s.books.find((b) => b.kind === "KR_MIXED")!;
    book.status = "RECORDED";
    book.firstSessionDate = "2026-10-12";
    book.latestSessionDate = "2026-10-13";
    book.holdings = [
      {
        symbol: "NEW_SHADOW",
        name: "new",
        quantity: "1",
        market: "KOSDAQ",
        price: null,
        value: null,
        entryDate: "2026-10-12",
      },
    ];
    expect(projectWebsitePositionContext(null, null, s, now).positions).toEqual([
      {
        symbol: "NEW_SHADOW",
        name: "new",
        market: "KOSDAQ",
        shares: 1,
        firstEntryDate: "2026-10-12",
      },
    ]);
    delete book.holdings[0]!.market;
    expect(() => projectWebsitePositionContext(null, null, s, now)).toThrow();
    book.holdings[0]!.market = "KOSDAQ";
    book.latestSessionDate = "2026-10-16";
    expect(() => projectWebsitePositionContext(null, null, s, now)).toThrow();
  });
  it.each(["beta", "missing", "unavailable", "oldHolding"])(
    "fails closed for %s Shadow without falling back to old positions",
    async (kind) => {
      const s = await summary();
      if (kind === "beta") s.version = "adopted-shadow-2026-10-05-v1";
      if (kind === "missing") s.books.pop();
      if (kind === "unavailable") s.books[0]!.status = "UNAVAILABLE";
      if (kind === "oldHolding")
        s.books[0]!.holdings = [
          {
            symbol: "OLD",
            name: "OLD",
            quantity: "1",
            price: "1",
            value: "1",
            entryDate: "2026-10-09",
          },
        ];
      expect(() =>
        projectWebsitePositionContext({ executions: [fill("OLD", "2026-10-09")] }, null, s, now),
      ).toThrow();
    },
  );
});

it.each(["actual", "restart-shadow"])(
  "applies dated exit checks to validated %s-only holdings",
  async (source) => {
    const shadow = await summary();
    const metadata = emptyNewActualMetadata();
    if (source === "actual")
      metadata.assignments["NEW"] = {
        executionId: "NEW",
        quantity: 2,
        gross: 200,
        fee: 0,
        brokerReference: "approved-new",
      };
    else {
      const book = shadow.books.find((b) => b.kind === "KR_MIXED")!;
      book.status = "RECORDED";
      book.firstSessionDate = "2026-10-12";
      book.latestSessionDate = "2026-10-14";
      book.holdings = [
        {
          symbol: "NEW",
          name: "NEW",
          market: "KOSPI",
          quantity: "2",
          price: "100",
          value: "200",
          entryDate: "2026-10-13",
        },
      ];
    }
    const context = projectWebsitePositionContext(
      { executions: [fill("NEW", "2026-10-13")], newActualPortfolio: metadata },
      null,
      shadow,
      now,
    );
    expect(context.heldSymbols).toEqual(["NEW"]);
    const row = {
      instrument: { symbol: "NEW", market: "KOSPI", instrumentType: "STOCK" },
      snapshot: { tradeDate: "2026-10-13", close: 100 },
      operatingScore10: 9.5,
      previousOperatingScore10: 7,
      scoreDelta1d: 25,
      grade: "A",
    } as ScreeningRow;
    expect(isHeldExit(row, context, "2026-10-14")).toBe(false);
    row.snapshot.tradeDate = "2026-10-14";
    expect(isHeldExit(row, context, "2026-10-14")).toBe(true);
  },
);
