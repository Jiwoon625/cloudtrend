import { describe, expect, it } from "vitest";
import type { NewActualPosition, NewActualTrade } from "./newActualPortfolio";
import { reconstructActualPriceCycle } from "./actualHoldingPriceLots";

function trade(
  id: string,
  date: string,
  side: "BUY" | "SELL",
  quantity: number,
  gross: number,
  fee: number,
  order: number,
): NewActualTrade {
  return {
    execution: {
      id,
      date,
      side,
      symbol: "ETF1",
      market: "ETF",
      name: "Synthetic ETF",
      order,
    },
    allocation: { executionId: id, quantity, gross, fee, brokerReference: id },
    realizedPnl: null,
  } as NewActualTrade;
}
function position(quantity: string, cost: string): NewActualPosition {
  return { symbol: "ETF1", market: "ETF", quantity, cost } as NewActualPosition;
}
describe("actual price-exit acquisition lots", () => {
  it("preserves each entry price and exact fee-inclusive cost across two buys", () => {
    const result = reconstructActualPriceCycle(position("20", "2103.15"), [
      trade("b1", "2026-10-12", "BUY", 10, 1000, 1.5, 0),
      trade("b2", "2026-10-14", "BUY", 10, 1100, 1.65, 1),
    ]);
    expect(result.cycle.id).toBe("b1");
    expect(result.lots).toMatchObject([
      { id: "b1", entryPrice: "100", quantity: "10", costBasis: "1001.5" },
      { id: "b2", entryPrice: "110", quantity: "10", costBasis: "1101.65" },
    ]);
  });
  it("allocates partial-sale cost proportionally, matching the official pooled cost exactly", () => {
    const result = reconstructActualPriceCycle(position("15", "1577.3625"), [
      trade("b1", "2026-10-12", "BUY", 10, 1000, 1.5, 0),
      trade("b2", "2026-10-14", "BUY", 10, 1100, 1.65, 1),
      trade("s1", "2026-10-15", "SELL", 5, 550, 0.825, 2),
    ]);
    expect(result.lots.map((lot) => lot.quantity)).toEqual(["7.5", "7.5"]);
    expect(result.lots.map((lot) => lot.costBasis)).toEqual(["751.125", "826.2375"]);
    expect(result.cycle.id).toBe("b1");
  });
  it("starts a fresh evidence cycle only after full liquidation", () => {
    const result = reconstructActualPriceCycle(position("2", "201"), [
      trade("b1", "2026-10-12", "BUY", 10, 1000, 1.5, 0),
      trade("s1", "2026-10-13", "SELL", 10, 900, 1.35, 1),
      trade("b2", "2026-10-14", "BUY", 2, 200, 1, 2),
    ]);
    expect(result.cycle.id).toBe("b2");
    expect(result.lots).toHaveLength(1);
  });
  it("refuses duplicate fills or a cost mismatch instead of guessing the basis", () => {
    const buys = [trade("b1", "2026-10-12", "BUY", 10, 1000, 1.5, 0)];
    expect(() => reconstructActualPriceCycle(position("10", "1001.4"), buys)).toThrow(/differs/);
    expect(() =>
      reconstructActualPriceCycle(position("20", "2003"), [...buys, ...buys]),
    ).toThrow(/Duplicate/);
  });
});
