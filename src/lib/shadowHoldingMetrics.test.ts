import { describe, expect, it } from "vitest";
import { shadowHoldingMetrics } from "./shadowHoldingMetrics";
const fill = (side: string, quantity: string, price: string, fee = "1") => ({
  symbol: "S",
  side,
  quantity,
  price,
  fee,
});
describe("Shadow display average cost and cumulative realized PnL", () => {
  it("shows purchase price, fee-inclusive unrealized PnL and zero before any sale", () => {
    expect(
      shadowHoldingMetrics([fill("BUY", "10", "100")], {
        symbol: "S",
        quantity: "10",
        price: "110",
      }),
    ).toEqual({ entryPrice: "100", unrealizedPnl: "99", realizedPnl: "0" });
  });
  it("retains proportional entry fees after partial sells and combines additional buys", () => {
    const result = shadowHoldingMetrics(
      [
        fill("BUY", "10", "100", "10"),
        fill("SELL", "4", "120", "4"),
        fill("REBALANCE_BUY", "4", "100", "4"),
      ],
      { symbol: "S", quantity: "10", price: "110" },
    );
    expect(result).toEqual({ entryPrice: "100", unrealizedPnl: "90", realizedPnl: "72" });
  });
  it("preserves realized PnL from an earlier round trip after re-entry", () => {
    expect(
      shadowHoldingMetrics(
        [fill("BUY", "10", "100"), fill("SELL", "10", "110"), fill("BUY", "2", "90")],
        { symbol: "S", quantity: "2", price: "100" },
      ),
    ).toEqual({ entryPrice: "90", unrealizedPnl: "19", realizedPnl: "98" });
  });
  it("keeps cost and realized PnL when a mark is missing", () => {
    expect(
      shadowHoldingMetrics([fill("BUY", "2", "0.1", "0.01")], {
        symbol: "S",
        quantity: "2",
        price: null,
      }),
    ).toEqual({ entryPrice: "0.1", unrealizedPnl: null, realizedPnl: "0" });
  });
  it("does not fabricate zero for truncated or inconsistent fill history", () => {
    for (const fills of [[], [fill("SELL", "1", "10")], [fill("BUY", "1", "10")]])
      expect(shadowHoldingMetrics(fills, { symbol: "S", quantity: "2", price: "100" })).toEqual({
        entryPrice: null,
        unrealizedPnl: null,
        realizedPnl: null,
      });
  });
});
