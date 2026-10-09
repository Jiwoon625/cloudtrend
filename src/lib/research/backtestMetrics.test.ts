import { describe, expect, it } from "vitest";
import { fullPeriodBacktestMetrics } from "./backtestMetrics";

describe("full-period research metrics", () => {
  const calculate = (dailyNAV: Parameters<typeof fullPeriodBacktestMetrics>[0]["dailyNAV"]) =>
    fullPeriodBacktestMetrics({ initialCapital: "100", startDate: "2020-01-02", dailyNAV });

  it("uses actual elapsed days, distinguishes cumulative return, and includes initial cash in MDD", () => {
    const result = calculate([
      { date: "2020-01-02", nav: "90" },
      { date: "2020-06-01", nav: "120" },
      { date: "2020-12-01", nav: "80" },
      { date: "2022-01-03", nav: "144" },
    ]);
    expect(result.status).toBe("COMPLETE");
    expect(result.cumulativeReturn).toBeCloseTo(0.44);
    expect(result.cagr).toBeCloseTo(1.44 ** (365.2425 / 732) - 1);
    expect(result.mdd).toBeCloseTo(-1 / 3);
    expect(result.elapsedCalendarDays).toBe(732);
  });

  it("handles flat capital and complete loss without nonfinite metrics", () => {
    expect(calculate([{ date: "2021-01-02", nav: "100" }])).toMatchObject({ cagr: 0, mdd: 0 });
    expect(calculate([{ date: "2021-01-02", nav: "0" }])).toMatchObject({ cagr: -1, mdd: -1 });
    expect(calculate([{ date: "2021-01-02", nav: "90" }]).mdd).toBeCloseTo(-0.1);
  });

  it("does not bridge missing valuation or manufacture annualized one-day results", () => {
    for (const nav of [null, NaN, Infinity, -1]) {
      expect(
        calculate([
          { date: "2020-01-02", nav },
          { date: "2021-01-02", nav: 120 },
        ]),
      ).toMatchObject({ status: "INCOMPLETE", cagr: null, mdd: null });
    }
    expect(calculate([])).toMatchObject({ status: "INCOMPLETE", cagr: null, mdd: null });
    expect(calculate([{ date: "2020-01-02", nav: 100 }])).toMatchObject({ cagr: null });
  });

  it("retains stale-mark disclosure and rejects unordered or duplicate dates", () => {
    expect(calculate([{ date: "2021-01-02", nav: "110", valuationStatus: "STALE" }])).toMatchObject(
      { status: "COMPLETE_WITH_STALE_MARKS", staleValuationCount: 1 },
    );
    expect(() =>
      calculate([
        { date: "2021-01-02", nav: 100 },
        { date: "2021-01-02", nav: 110 },
      ]),
    ).toThrow("unique, increasing");
    expect(() => calculate([{ date: "2019-12-31", nav: 100 }])).toThrow();
  });
});
