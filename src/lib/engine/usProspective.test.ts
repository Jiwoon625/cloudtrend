import { describe, expect, it } from "vitest";
import { runUsProspectiveAnalysis, type UsProspectiveInputRow } from "./usProspective";
import { stepUsProspectivePortfolio, US_PROSPECTIVE_STRATEGIES } from "./usProspectivePortfolio";

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
      const analysis = runUsProspectiveAnalysis(
        rows.map((r) => ({ ...r, date: `2026-09-${28 + day}` })),
        state,
      );
      state = analysis.state;
      target = analysis.rows.find((r) => r.symbol === "S00")?.b3BetaExit ?? false;
    }
    expect(target).toBe(true);
  });
});

const [a0, a2, b3] = US_PROSPECTIVE_STRATEGIES;
function signals(date: string, count = 4) {
  const analysis = runUsProspectiveAnalysis(
    Array.from({ length: count }, (_, i) => ({ ...row(`T${i}`, i), date })),
  );
  analysis.rows.forEach((r) => {
    r.a0Entry = true;
    r.a2Entry = true;
    r.b3Entry = true;
    r.a0Exit = false;
    r.a2Exit = false;
    r.b3Exit = false;
    r.a0BetaExit = false;
    r.betaWeakStreak = 0;
    r.coreRank = 0.9;
    r.adv20Usd = 500_000;
    r.open = 100;
    r.close = 100;
  });
  return analysis;
}
describe("A0 Anchor and execution invariants", () => {
  it("adds beta exit to A0 on day three while preserving A2", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`S${i}`, i));
    rows[0]!.ret120 = 100;
    rows[0]!.ret252 = 100;
    let state = {};
    for (let day = 0; day < 3; day++) {
      const result = runUsProspectiveAnalysis(
        rows.map((r) => ({ ...r, date: `2026-09-${28 + day}` })),
        state,
      );
      const target = result.rows.find((r) => r.symbol === "S0")!;
      expect(target.a0Exit).toBe(day === 2);
      expect(target.b3BetaExit).toBe(day === 2);
      expect(target.a2Exit).toBe(false);
      state = result.state;
    }
  });
  it("resets at exact beta rank .60 and on missing beta", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`S${i}`, i));
    const p = { betaWeakStreak: { S3: 2, S0: 2 } };
    rows[0]!.beta60Spy = null;
    const exact = runUsProspectiveAnalysis(
      Array.from({ length: 6 }, (_, i) => row(`S${i}`, i)),
      p,
    ).rows.find((r) => r.symbol === "S3")!;
    expect(exact.betaRank).toBe(0.6);
    expect(exact.betaWeakStreak).toBe(0);
    expect(
      runUsProspectiveAnalysis(rows, p).rows.find((r) => r.symbol === "S0")!.betaWeakStreak,
    ).toBe(0);
  });
  it("keeps X70 and X50 exits with strict thresholds", () => {
    const r = runUsProspectiveAnalysis(Array.from({ length: 11 }, (_, i) => row(`S${i}`, i))).rows;
    expect(r.find((x) => x.symbol === "S7")!.a0Exit).toBe(false);
    expect(r.find((x) => x.symbol === "S6")!.a0Exit).toBe(true);
    expect(r.find((x) => x.symbol === "S5")!.b3BaseExit).toBe(false);
    expect(r.find((x) => x.symbol === "S4")!.b3BaseExit).toBe(true);
  });
  it.each([
    [a0!, 20],
    [a2!, 2],
    [b3!, 3],
  ])("enforces strategy position and sector reservations", (config, limit) => {
    const first = stepUsProspectivePortfolio(config, signals("2026-09-28", 25), null, null);
    expect(Object.keys(first.state.pendingTargets)).toHaveLength(limit);
    const second = stepUsProspectivePortfolio(
      config,
      signals("2026-09-29", 25),
      first.state,
      first.nav,
    );
    expect(second.positionsCount).toBe(limit);
    expect(
      new Set([...Object.keys(second.state.positions), ...Object.keys(second.state.pendingTargets)])
        .size,
    ).toBe(limit);
  });
  it("uses next open, preceding ADV and carries partial orders without future close leakage", () => {
    const first = stepUsProspectivePortfolio(a0!, signals("2026-09-28", 1), null, null);
    expect(first.positionsCount).toBe(0);
    const next = signals("2026-09-29", 1);
    next.rows[0]!.open = 125;
    next.rows[0]!.close = 200;
    next.rows[0]!.adv20Usd = 1e9;
    const second = stepUsProspectivePortfolio(a0!, next, first.state, first.nav);
    expect(second.state.positions["T0"]!.shares).toBe(40);
    expect(second.trades.find((t) => t.executionDate)!.modelPrice).toBe(125);
    expect(second.feesUsd).toBe(12.5);
    expect(second.state.pendingTargets["T0"]).toBeDefined();
    expect(stepUsProspectivePortfolio(a0!, next, first.state, first.nav)).toEqual(second);
    expect(() => stepUsProspectivePortfolio(a0!, next, second.state, second.nav)).toThrow(
      /later trading date/,
    );
  });
  it("rebalances at the first quarterly open, using the previous close", () => {
    const first = stepUsProspectivePortfolio(a0!, signals("2026-09-29", 2), null, null);
    const sep = stepUsProspectivePortfolio(a0!, signals("2026-09-30", 2), first.state, first.nav);
    sep.state.pendingTargets = {};
    sep.state.positions["T0"]!.shares = 300;
    sep.state.positions["T1"]!.shares = 100;
    sep.state.cash = 60000;
    sep.state.adv20BySymbol = { T0: 1e9, T1: 1e9 };
    const oct = signals("2026-10-01", 2);
    oct.rows.forEach((r) => {
      r.a0Entry = false;
    });
    const result = stepUsProspectivePortfolio(a0!, oct, sep.state, 100000);
    expect(
      result.trades.some(
        (t) =>
          t.executionDate === "2026-10-01" &&
          t.signalDate === "2026-09-30" &&
          t.reason === "QUARTER_EQUAL_WEIGHT",
      ),
    ).toBe(true);
    expect(result.state.lastQuarterRebalance).toBe("2026Q4");
  });
  it("keeps Anchor sell intent after recovery until the residual fills", () => {
    const first = stepUsProspectivePortfolio(a0!, signals("2026-09-28", 1), null, null);
    const second = stepUsProspectivePortfolio(
      a0!,
      signals("2026-09-29", 1),
      first.state,
      first.nav,
    );
    second.state.positions["T0"]!.shares = 200;
    second.state.pendingTargets = {};
    const weak = signals("2026-09-30", 1);
    weak.rows[0]!.a0Exit = true;
    weak.rows[0]!.a0Entry = false;
    weak.rows[0]!.betaWeakStreak = 3;
    weak.rows[0]!.a0BetaExit = true;
    const exit = stepUsProspectivePortfolio(a0!, weak, second.state, second.nav);
    expect(exit.state.pendingExits["T0"]!.reason).toBe("A0_BETA_ANCHOR_3D");
    const recovered = signals("2026-10-01", 1);
    const partial = stepUsProspectivePortfolio(a0!, recovered, exit.state, exit.nav);
    expect(partial.state.positions["T0"]!.shares).toBe(150);
    expect(partial.state.pendingExits["T0"]).toBeDefined();
    expect(partial.state.pendingTargets["T0"]).toBeUndefined();
  });
  it("does not let SPY enter the equity ranking universe", () => {
    const result = runUsProspectiveAnalysis([row("A", 1), row("B", 2), row("SPY", 100)]);
    expect(result.rows.find((r) => r.symbol === "B")!.coreRank).toBe(1);
    expect(result.rows.find((r) => r.symbol === "SPY")!.coreRank).toBeNull();
    expect(result.rows.find((r) => r.symbol === "SPY")!.primarySignal).toBe("NONE");
  });
  it("rejects same-date rank-state reuse and duplicate symbols", () => {
    const rows = [row("A", 1), row("B", 2)];
    const first = runUsProspectiveAnalysis(rows);
    expect(() => runUsProspectiveAnalysis(rows, first.state)).toThrow(/later trading date/);
    expect(() => runUsProspectiveAnalysis([...rows, rows[0]!])).toThrow(/unique symbols/);
  });
});
