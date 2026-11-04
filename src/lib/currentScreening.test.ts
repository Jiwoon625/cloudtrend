import { describe, expect, it } from "vitest";
import { currentScreeningDataset } from "./currentScreening";
import type { MarketDataset } from "./engine/dataset";
const bar = (tradeDate: string, close = 100) => ({
  tradeDate,
  close,
  open: close,
  high: close,
  low: close,
  volume: 10,
  tradingValue: close * 10,
  marketCap: null,
  foreignNetBuyValue: null,
  institutionNetBuyValue: null,
});
function fixture() {
  return {
    asOfDate: "2026-11-04",
    notes: [],
    instruments: [
      { symbol: "GOOD", name: "정상" },
      { symbol: "OLD", name: "과거" },
    ],
    bars: { GOOD: [bar("2026-11-03"), bar("2026-11-04")], OLD: [bar("2026-11-03")] },
  } as unknown as MarketDataset;
}
describe("daily price eligibility", () => {
  it("excludes historical-only symbols without mutating historical input", () => {
    const raw = fixture();
    const result = currentScreeningDataset(raw);
    expect(result.instruments.map((i) => i.symbol)).toEqual(["GOOD"]);
    expect(Object.keys(result.bars)).toEqual(["GOOD"]);
    expect(result.notes.join()).toContain("OLD 과거");
    expect(result.notes.join()).toContain("2026-11-03");
    expect(raw.instruments).toHaveLength(2);
    expect(raw.bars["OLD"]).toHaveLength(1);
    expect(raw.notes).toEqual([]);
  });
  it("retains a previously tradable symbol for its historical session", () => {
    const raw = fixture();
    raw.asOfDate = "2026-11-03";
    expect(currentScreeningDataset(raw).instruments).toHaveLength(2);
  });
  it("does not accept a synthesized positive bar over an observed zero close", () => {
    const raw = fixture();
    raw.observedBars = { GOOD: [bar("2026-11-04", 0)] };
    expect(() => currentScreeningDataset(raw)).toThrow("기준 거래일");
  });
  it("includes a symbol again once a valid target price arrives", () => {
    const raw = fixture();
    raw.bars["OLD"]!.push(bar("2026-11-04"));
    expect(currentScreeningDataset(raw).instruments).toHaveLength(2);
  });
  it("does not accept future-only prices or empty universes", () => {
    const raw = fixture();
    raw.bars["GOOD"] = [bar("2026-11-05")];
    expect(() => currentScreeningDataset(raw)).toThrow();
  });
});
