import { describe, expect, it } from "vitest";
import { runUsProspectiveAnalysis, type UsProspectiveInputRow } from "./usProspective";

function row(symbol: string, x: number): UsProspectiveInputRow {
  return {
    date: "2026-09-28",
    symbol,
    name: symbol,
    market: "NASDAQ",
    sector: "IT_HW",
    securityType: "STOCK",
    status: "ACTIVE",
    currency: "USD",
    open: 100 + x,
    high: 101 + x,
    low: 99 + x,
    close: 100 + x,
    volume: 1_000_000,
    dollarVolume: 100_000_000,
    sharesOutstanding: 100_000_000,
    marketCap: 10_000_000_000,
    ret120: x,
    ret252: x,
    beta60Spy: x,
    ichimokuTkGap: x,
    relvol1_20: x,
    adv20Usd: 10_000_000 + x * 1000,
    amihud20: 1 / (x + 100),
    active20: true,
    tossTradable: true,
    isCommonShare: true,
    fxUsdKrw: 1400,
  };
}

describe("US prospective frozen rule", () => {
  it("bootstraps ranks without a false entry, then emits E80 only on a real crossing", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`S${String(i).padStart(2, "0")}`, i));
    const first = runUsProspectiveAnalysis(rows, {});
    expect(first.rows.some((r) => r.a0Entry)).toBe(false);

    const nextRows = rows.map((r) => ({ ...r, date: "2026-09-29" }));
    const target = nextRows.find((r) => r.symbol === "S10")!;
    target.ret120 = 100;
    target.ret252 = 100;
    target.beta60Spy = 100;
    target.ichimokuTkGap = 100;
    const second = runUsProspectiveAnalysis(nextRows, first.state);
    expect(second.rows.find((r) => r.symbol === "S10")?.a0Entry).toBe(true);
  });

  it("counts the B3 beta weakness streak and exits on day three", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`S${String(i).padStart(2, "0")}`, i));
    rows[0]!.ret120 = 100;
    rows[0]!.ret252 = 100;
    let state = { coreRanks: {}, betaWeakStreak: {} };
    let target = false;
    for (let day = 0; day < 3; day++) {
      const analysis = runUsProspectiveAnalysis(rows, state);
      state = analysis.state;
      target = analysis.rows.find((r) => r.symbol === "S00")?.b3BetaExit ?? false;
    }
    expect(target).toBe(true);
  });
});
