import { expect, it } from "vitest";
import { projectMasterPositionContext } from "./manualMasterPosition.server";
import { newMasterRow, type MasterSnapshot } from "./manualMaster";

const master: MasterSnapshot = {
  revision: 1,
  asOf: "2026-11-28",
  savedAt: "2026-11-28T00:00:00Z",
  reviewStatus: "confirmed",
  rows: [
    {
      ...newMasterRow(),
      symbol: "0046A0",
      name: "synthetic",
      assetType: "ETF",
      quantity: "2",
      amountKrw: "200",
      averageKrw: "100",
      start: "2026-11-01",
    },
    {
      ...newMasterRow(),
      symbol: "000002",
      name: "sold",
      quantity: "0",
      lastSell: "2026-11-27",
    },
  ],
};
it("uses master holdings and sale dates without synthetic trades or actionable stops", () => {
  const ctx = projectMasterPositionContext(master, []);
  expect(ctx.heldSymbols).toEqual(["0046A0"]);
  expect(ctx.lastSellDateBySymbol).toEqual({ "000002": "2026-11-27" });
  expect(ctx.priceExits?.["0046A0"]?.reason).toBeNull();
  expect(ctx.masterRevision).toBe(1);
});
it("does not convert pending or missing master into empty holdings", () => {
  expect(() => projectMasterPositionContext(null, [])).toThrow();
  expect(() =>
    projectMasterPositionContext({ ...master, reviewStatus: "pending" }, []),
  ).toThrow();
  // The read contract does not depend on screening dates or daily confirmation.
  const ctx = projectMasterPositionContext(master, []);
  expect(ctx.masterAsOf).toBe("2026-11-28");
  expect(ctx.heldSymbols).toEqual(["0046A0"]);
});
