import { describe, expect, it } from "vitest";
import { octoberShadowTax } from "./octoberShadowTax";
import { hashSeriesValue, type AdoptedUsRun } from "./modelSeries";
import { fixtureSeries, usRun } from "../../../tests/october-shadow-fixtures";
const asOf = "2026-10-12";
async function input() {
  const series = await fixtureSeries();
  return {
    series,
    runs: [(await usRun(series)) as AdoptedUsRun],
    historyComplete: true,
    asOf,
    preTaxNavUsd: 73551.04,
  };
}
describe("October independent counterfactual US tax", () => {
  it("does not turn registry initialization into zero tax or a real-session NAV", async () => {
    const i = await input();
    const result = await octoberShadowTax({ ...i, runs: [], preTaxNavUsd: null });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.currentYearTaxKrw).toBeNull();
    expect(result.afterTaxNavUsd).toBeNull();
  });
  it("proves zero from complete sale-free history without fabricating FX", async () => {
    const result = await octoberShadowTax(await input());
    expect(result.status).toBe("ESTIMATE");
    expect(result.currentYearTaxKrw).toBe(0);
    expect(result.afterTaxNavUsd).toBe(73551.04);
    expect(result.valuationFx).toBeNull();
    expect(result.scopeLabel).toContain("가상 납세자");
  });
  it("uses distinct pools for every new US book", async () => {
    for (const kind of ["US_A0", "US_A2", "US_B3"] as const) {
      const series = await fixtureSeries(kind);
      const result = await octoberShadowTax({
        series,
        runs: [(await usRun(series)) as AdoptedUsRun],
        historyComplete: true,
        asOf,
        preTaxNavUsd: 73551.04,
      });
      expect(result.status).toBe("ESTIMATE");
      expect(result.scopeLabel).not.toContain("실제 소유자");
    }
  });
  it("rejects incomplete, missing-first, skipped-session and tampered history", async () => {
    const i = await input();
    expect((await octoberShadowTax({ ...i, historyComplete: false })).currentYearTaxKrw).toBeNull();
    const next = (await usRun(
      i.series,
      "2026-10-13",
      i.runs[0] as Awaited<ReturnType<typeof usRun>>,
    )) as AdoptedUsRun;
    expect((await octoberShadowTax({ ...i, runs: [next], asOf: "2026-10-13" })).status).toBe(
      "UNAVAILABLE",
    );
    const skip = (await usRun(
      i.series,
      "2026-10-14",
      i.runs[0] as Awaited<ReturnType<typeof usRun>>,
    )) as AdoptedUsRun;
    expect(
      (await octoberShadowTax({ ...i, runs: [...i.runs, skip], asOf: "2026-10-14" })).status,
    ).toBe("UNAVAILABLE");
    i.runs[0]!.result.cash = 0;
    expect((await octoberShadowTax(i)).status).toBe("UNAVAILABLE");
  });
  it("fails closed after a sale instead of substituting initial FX", async () => {
    const i = await input(),
      run = i.runs[0]!;
    run.result.trades = ["BUY", "SELL"].map((side, n) => ({
      tradeKey: `t${n}`,
      strategyId: "A0_QUARTER_PRIMARY",
      signalDate: asOf,
      executionDate: asOf,
      symbol: "TEST",
      name: "Test",
      sector: "IT",
      side: side as "BUY" | "SELL",
      reason: "test",
      status: "EXECUTED",
      modelPrice: 100,
      modelShares: 1,
      modelNotional: 100,
      feeUsd: 0.15,
      coreRank: null,
      detail: {},
    }));
    const { stateHash: _, ...body } = run;
    run.stateHash = await hashSeriesValue(body);
    const result = await octoberShadowTax(i);
    expect(result.currentYearTaxKrw).toBeNull();
    expect(result.afterTaxNavUsd).toBeNull();
    expect(result.missingFields.join()).toContain("결제환율");
  });
  it("does not call missing trades a sale-free complete ledger", async () => {
    const i = await input(),
      run = i.runs[0]!;
    run.result.state.positions["TEST"] = {
      symbol: "TEST",
      name: "Test",
      sector: null,
      shares: 1,
      lastPrice: 100,
      entryDate: asOf,
      entryCoreRank: null,
    };
    const { stateHash: _, ...body } = run;
    run.stateHash = await hashSeriesValue(body);
    expect((await octoberShadowTax(i)).status).toBe("UNAVAILABLE");
  });
});
