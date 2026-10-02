import { describe, expect, it } from "vitest";
import { FULL_CAPABILITIES, type MarketDataset } from "./dataset";
import { evaluateKospiMarketGateAtDate, buildDatedVolatilityObservations } from "./kospiMarketGate";
import { realizedVolatilitySeries } from "./kospiVolatility";
import { getMockDataset } from "./mockProvider";
import { parseManualMarketData } from "./manualDataset";
import type { DailyPrice, Instrument } from "./types";

function tradingDates(count = 100): string[] {
  const dates: string[] = [];
  const current = new Date("2026-05-08T00:00:00Z");
  while (dates.length < count) {
    const date = current.toISOString().slice(0, 10);
    if (current.getUTCDay() !== 0 && current.getUTCDay() !== 6 && date !== "2026-05-05")
      dates.push(date);
    current.setUTCDate(current.getUTCDate() - 1);
  }
  return dates.reverse();
}

function makeBars(dates: string[], trend = 1, flow: number | null = 1): DailyPrice[] {
  return dates.map((tradeDate, index) => {
    const close = 300 + trend * index;
    return {
      tradeDate,
      close,
      open: close,
      high: close + 2,
      low: close - 2,
      volume: 1,
      tradingValue: close,
      marketCap: null,
      foreignNetBuyValue: flow,
      institutionNetBuyValue: null,
    };
  });
}

function dataset(trend = 1, volatility = 20, flow: number | null = 1): MarketDataset {
  const tradeDates = tradingDates();
  return {
    provider: "TEST_DATED",
    version: "test",
    asOfDate: tradeDates.at(-1)!,
    isLive: true,
    capabilities: { ...FULL_CAPABILITIES },
    notes: [],
    sectors: [],
    tradeDates,
    instruments: [],
    bars: {},
    financials: {},
    etfFacts: {},
    indexSeries: [
      { indexCode: "KOSPI", indexName: "KOSPI", bars: makeBars(tradeDates, trend, flow) },
    ],
    vkospiSeries: tradeDates.map(() => volatility),
    vkospiObservations: tradeDates.map((date) => ({ date, value: volatility, source: "VKOSPI" })),
  };
}

function gate(ds: MarketDataset) {
  return evaluateKospiMarketGateAtDate(ds, ds.asOfDate);
}

describe("strict dated KOSPI market gate", () => {
  it.each([
    [1, 20, 1, 4, "RISK_ON"],
    [1, 30, 1, 3, "NEUTRAL"],
    [1, 30, 0, 2, "NEUTRAL"],
    [-1, 20, 0, 1, "RISK_OFF"],
    [-1, 30, 0, 0, "RISK_OFF"],
  ] as const)(
    "classifies four complete flags: trend %i VKOSPI %i flow %i",
    (trend, volatility, flow, met, status) => {
      expect(gate(dataset(trend, volatility, flow))).toMatchObject({
        status,
        metCount: met,
        evaluatedCount: 4,
        incomplete: false,
        issues: [],
      });
    },
  );

  it("keeps all three positive flags UNKNOWN if one input is missing", () => {
    const ds = dataset();
    ds.vkospiObservations = [];
    expect(gate(ds)).toMatchObject({
      status: "UNKNOWN",
      metCount: 3,
      evaluatedCount: 3,
      incomplete: true,
    });
    expect(gate(ds).issues).toContain("MISSING_DATED_VOLATILITY");
  });

  it("never assigns dates to an equal-length legacy volatility array", () => {
    const ds = dataset();
    delete ds.vkospiObservations;
    expect(ds.vkospiSeries).toHaveLength(ds.tradeDates.length);
    expect(gate(ds).status).toBe("UNKNOWN");
    expect(gate(ds).issues).toContain("MISSING_DATED_VOLATILITY");
  });

  it("does not use today's regime or later observations for an earlier session", () => {
    const ds = dataset();
    const date = ds.tradeDates[85]!;
    const expected = evaluateKospiMarketGateAtDate(ds, date);
    const prefix = structuredClone(ds);
    prefix.asOfDate = date;
    prefix.tradeDates = prefix.tradeDates.filter((day) => day <= date);
    prefix.indexSeries[0]!.bars = prefix.indexSeries[0]!.bars.filter(
      (bar) => bar.tradeDate <= date,
    );
    prefix.vkospiObservations = prefix.vkospiObservations!.filter((point) => point.date <= date);
    expect(gate(prefix)).toEqual(expected);
    ds.indexSeries[0]!.bars.forEach((bar) => {
      if (bar.tradeDate > date) {
        bar.close = 1;
        bar.open = 1;
        bar.high = 2;
        bar.low = 0.5;
        bar.foreignNetBuyValue = -1e20;
      }
    });
    ds.vkospiObservations!.forEach((point) => {
      if (point.date > date) point.value = 100;
    });
    expect(gate(ds).status).toBe("RISK_OFF");
    expect(evaluateKospiMarketGateAtDate(ds, date)).toEqual(expected);
  });

  it("does not consume future-only volatility or infer a prior value", () => {
    const ds = dataset();
    const date = ds.tradeDates[85]!;
    ds.vkospiObservations = ds.vkospiObservations!.filter((point) => point.date > date);
    expect(evaluateKospiMarketGateAtDate(ds, date)).toMatchObject({
      status: "UNKNOWN",
      vkospi: null,
    });
    expect(evaluateKospiMarketGateAtDate(ds, date).issues).toContain("MISSING_VOLATILITY_DATE");
  });

  it("rejects evaluation after the dataset as-of even if future records exist", () => {
    const ds = dataset();
    const future = ds.asOfDate;
    ds.asOfDate = ds.tradeDates[85]!;
    expect(evaluateKospiMarketGateAtDate(ds, future).issues).toEqual([
      "EVALUATION_DATE_AFTER_DATASET_AS_OF",
    ]);
  });

  it("rejects stale benchmark and volatility rather than rolling them forward", () => {
    const staleBenchmark = dataset();
    staleBenchmark.indexSeries[0]!.bars.pop();
    expect(gate(staleBenchmark).issues).toContain("STALE_KOSPI_INDEX");
    const staleVolatility = dataset();
    staleVolatility.vkospiObservations!.pop();
    expect(gate(staleVolatility).issues).toContain("STALE_VOLATILITY_INPUT");
    expect(gate(staleVolatility).status).toBe("UNKNOWN");
  });

  it("requires all five genuine market flows and never falls back to individual or ETF flow", () => {
    const ds = dataset();
    ds.indexSeries[0]!.bars.at(-3)!.foreignNetBuyValue = null;
    ds.instruments = ["KOSPI", "KOSDAQ", "ETF"].map(
      (market, index) =>
        ({
          symbol: String(index),
          market,
          instrumentType: market === "ETF" ? "ETF" : "STOCK",
        }) as Instrument,
    );
    ds.instruments.forEach((instrument) => {
      ds.bars[instrument.symbol] = makeBars(ds.tradeDates, 1, 1e12);
    });
    expect(gate(ds)).toMatchObject({
      status: "UNKNOWN",
      marketForeignNet5d: null,
      foreignNet5dPositive: null,
    });
    expect(gate(ds).issues).toContain("MISSING_OR_NONFINITE_KOSPI_MARKET_FOREIGN_FLOW");
  });

  it("does not call one through four sessions a five-session flow", () => {
    const ds = dataset();
    ds.tradeDates = ds.tradeDates.slice(-4);
    ds.indexSeries[0]!.bars = ds.indexSeries[0]!.bars.slice(-4);
    expect(gate(ds).issues).toContain("INSUFFICIENT_KOSPI_FOREIGN_FLOW_SESSIONS");
    expect(gate(ds).marketForeignNet5d).toBeNull();
  });

  it("uses trading sessions across weekends and an exchange holiday", () => {
    const ds = dataset();
    expect(gate(ds)).toMatchObject({
      status: "RISK_ON",
      marketForeignNet5d: 5,
      marketForeignDates: ["2026-05-01", "2026-05-04", "2026-05-06", "2026-05-07", "2026-05-08"],
    });
    expect(evaluateKospiMarketGateAtDate(ds, "2026-05-05").issues).toContain(
      "EVALUATION_DATE_NOT_IN_KOSPI_CALENDAR",
    );
  });

  it("rejects a missing benchmark session instead of stretching the rolling windows", () => {
    const ds = dataset();
    ds.indexSeries[0]!.bars.splice(-3, 1);
    expect(gate(ds).issues).toContain("KOSPI_HISTORY_CALENDAR_MISMATCH");
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects nonfinite volatility and foreign flow %s",
    (value) => {
      const ds = dataset();
      ds.vkospiObservations!.at(-1)!.value = value;
      ds.indexSeries[0]!.bars.at(-1)!.foreignNetBuyValue = value;
      expect(gate(ds)).toMatchObject({
        status: "UNKNOWN",
        vkospiBelow30: null,
        foreignNet5dPositive: null,
      });
      expect(gate(ds).issues).toContain("MISSING_OR_NONFINITE_VOLATILITY");
      expect(gate(ds).issues).toContain("MISSING_OR_NONFINITE_KOSPI_MARKET_FOREIGN_FLOW");
    },
  );

  it("rejects nonfinite closes and a nonfinite cloud input even if max/min could hide it", () => {
    const ds = dataset();
    ds.indexSeries[0]!.bars.at(-1)!.close = NaN;
    expect(gate(ds)).toMatchObject({
      status: "UNKNOWN",
      benchmarkAboveMa60: null,
      benchmarkAboveCloud: null,
    });
    const badCloud = dataset();
    badCloud.indexSeries[0]!.bars.at(-30)!.low = Infinity;
    expect(gate(badCloud).issues).toContain("MISSING_OR_NONFINITE_KOSPI_CLOUD");
  });

  it("rejects duplicate and invalid source dates", () => {
    const duplicateBar = dataset();
    duplicateBar.indexSeries[0]!.bars.push({ ...duplicateBar.indexSeries[0]!.bars.at(-1)! });
    expect(gate(duplicateBar).issues).toContain("AMBIGUOUS_KOSPI_BAR_DATE");
    const duplicateVolatility = dataset();
    duplicateVolatility.vkospiObservations!.push({
      ...duplicateVolatility.vkospiObservations!.at(-1)!,
    });
    expect(gate(duplicateVolatility).issues).toContain("AMBIGUOUS_VOLATILITY_DATE");
    const badDate = dataset();
    badDate.indexSeries[0]!.bars[0]!.tradeDate = "2026-02-30";
    expect(gate(badDate).issues).toContain("INVALID_KOSPI_BAR_DATE");
    expect(evaluateKospiMarketGateAtDate(dataset(), "2026-02-30").issues).toEqual([
      "INVALID_EVALUATION_DATE",
    ]);
  });

  it("sorts date-labelled records without mutating input and ignores future duplicate values", () => {
    const ds = dataset();
    const expected = gate(ds);
    ds.indexSeries[0]!.bars.reverse();
    ds.tradeDates.reverse();
    const reversedDates = [...ds.tradeDates];
    expect(gate(ds)).toEqual(expected);
    expect(ds.tradeDates).toEqual(reversedDates);
    const date = "2026-05-01";
    const before = evaluateKospiMarketGateAtDate(ds, date);
    ds.indexSeries[0]!.bars.push({ ...ds.indexSeries[0]!.bars[0]! });
    ds.vkospiObservations!.push({ ...ds.vkospiObservations!.at(-1)! });
    expect(evaluateKospiMarketGateAtDate(ds, date)).toEqual(before);
  });

  it("does not accept mock volatility in a live dataset", () => {
    const ds = dataset();
    ds.vkospiObservations!.at(-1)!.source = "MOCK_VKOSPI";
    expect(gate(ds).issues).toContain("INVALID_VOLATILITY_PROVENANCE");
    expect(gate(getMockDataset()).status).not.toBe("UNKNOWN");
  });
});

describe("dated existing volatility provider", () => {
  it.each(["KOSPI_STOCK", "KOSDAQ_STOCK", "KOSDAQ_INDEX"] as const)(
    "retains missing KOSPI sessions independently observed in %s rows",
    (proof) => {
      const ds = dataset();
      const raw = ds.indexSeries[0]!.bars;
      const missingDate = raw[97]!.tradeDate;
      const fields = [
        "symbol",
        "market",
        "type",
        "date",
        "open",
        "high",
        "low",
        "close",
        "foreignNetBuyValue",
      ];
      const lines = raw
        .filter((bar) => bar.tradeDate !== missingDate)
        .map((bar) =>
          [
            "KOSPI",
            "INDEX",
            "INDEX",
            bar.tradeDate,
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.foreignNetBuyValue,
          ].join(","),
        );
      lines.push(
        [
          proof === "KOSDAQ_INDEX" ? "KOSDAQ" : "005930",
          proof === "KOSDAQ_INDEX" ? "INDEX" : proof === "KOSDAQ_STOCK" ? "KOSDAQ" : "KOSPI",
          proof === "KOSDAQ_INDEX" ? "INDEX" : "STOCK",
          missingDate,
          100,
          101,
          99,
          100,
          1,
        ].join(","),
      );
      const manual = parseManualMarketData([fields.join(","), ...lines].join("\n"), {
        allowIndexOnly: true,
      }).dataset;
      expect(manual.tradeDates).toHaveLength(99);
      expect(manual.tradeDates).not.toContain(missingDate);
      expect(manual.kospiGateDates).toEqual(ds.tradeDates);
      expect(manual.kospiGateDates).toHaveLength(100);
      expect(gate(manual).status).toBe("UNKNOWN");
      expect(gate(manual).issues).toContain("KOSPI_HISTORY_CALENDAR_MISMATCH");
    },
  );

  it("excludes ETF and US rows from the strict Korean session calendar", () => {
    const ds = dataset();
    const fields = [
      "symbol",
      "market",
      "type",
      "date",
      "open",
      "high",
      "low",
      "close",
      "foreignNetBuyValue",
    ];
    const lines = ds.indexSeries[0]!.bars.map((bar) =>
      [
        "KOSPI",
        "INDEX",
        "INDEX",
        bar.tradeDate,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.foreignNetBuyValue,
      ].join(","),
    );
    lines.push("069500,KOSPI,ETF,2026-05-11,100,101,99,100,1");
    lines.push("SPY,US,ETF,2026-05-12,100,101,99,100,1");
    lines.push("AAPL,US,STOCK,2026-05-13,100,101,99,100,1");
    const manual = parseManualMarketData([fields.join(","), ...lines].join("\n")).dataset;
    expect(manual.kospiGateDates).toEqual(ds.tradeDates);
    expect(manual.tradeDates).toEqual(ds.tradeDates);
    expect(gate(manual).status).toBe("RISK_ON");
  });

  it("keeps manual screening and raw ledger inputs UNKNOWN when KOSPI OHLC was synthesized", () => {
    const ds = dataset();
    const raw = ds.indexSeries[0]!.bars;
    raw[70]!.high = NaN;
    const fields = [
      "symbol",
      "market",
      "date",
      "open",
      "high",
      "low",
      "close",
      "foreignNetBuyValue",
    ];
    const lines = raw.map((bar) =>
      [
        "KOSPI",
        "INDEX",
        bar.tradeDate,
        bar.open,
        Number.isFinite(bar.high) ? bar.high : "",
        bar.low,
        bar.close,
        bar.foreignNetBuyValue,
      ].join(","),
    );
    lines.push(["005930", "KOSPI", ds.asOfDate, 100, 101, 99, 100, 1].join(","));
    const manual = parseManualMarketData([fields.join(","), ...lines].join("\n")).dataset;
    // Preserve legacy normalized chart/score bars, but never use synthesis as gate evidence.
    expect(Number.isFinite(manual.indexSeries[0]!.bars[70]!.high)).toBe(true);
    expect(manual.kospiPriceInputIssues?.[raw[70]!.tradeDate]).toEqual(["high"]);
    expect(gate(manual).status).toBe("UNKNOWN");
    expect(gate(manual).benchmarkAboveCloud).toBeNull();
    expect(gate(ds).status).toBe("UNKNOWN");
    expect(gate(ds).benchmarkAboveCloud).toBeNull();
  });

  it("preserves actual VKOSPI row dates rather than using KOSPI array positions", () => {
    const ds = dataset();
    const bars = ds.indexSeries[0]!.bars;
    const volatility = makeBars(ds.tradeDates.slice(1), 0).map((bar) => ({ ...bar, close: 17 }));
    const points = buildDatedVolatilityObservations(bars, [], volatility);
    expect(points[0]).toEqual({ date: volatility[0]!.tradeDate, value: 17, source: "VKOSPI" });
    expect(points).toHaveLength(99);
  });

  it("preserves the existing 70/30 realized volatility value when exact dates align", () => {
    const ds = dataset();
    const bars = ds.indexSeries[0]!.bars;
    const kosdaq = makeBars(ds.tradeDates, 2);
    const points = buildDatedVolatilityObservations(bars, kosdaq);
    expect(points.at(-1)).toEqual({
      date: ds.asOfDate,
      source: "REALIZED_VOLATILITY_KOSPI_KOSDAQ_70_30",
      value:
        0.7 * realizedVolatilitySeries(bars.map((bar) => bar.close)).at(-1)! +
        0.3 * realizedVolatilitySeries(kosdaq.map((bar) => bar.close)).at(-1)!,
    });
    expect(points[19]!.value).toBeNull();
    expect(points[20]!.date).toBe(ds.tradeDates[20]);
  });

  it("provides the existing KOSPI-only proxy with explicit source when no KOSDAQ is supplied", () => {
    const ds = dataset();
    ds.vkospiObservations = buildDatedVolatilityObservations(ds.indexSeries[0]!.bars);
    expect(gate(ds)).toMatchObject({
      status: "RISK_ON",
      volatilitySource: "REALIZED_VOLATILITY_KOSPI",
    });
  });

  it("refuses equal-length KOSDAQ histories whose dates are shifted", () => {
    const ds = dataset();
    const kosdaq = makeBars(ds.tradeDates);
    kosdaq.at(-1)!.tradeDate = "2026-05-11";
    ds.vkospiObservations = buildDatedVolatilityObservations(ds.indexSeries[0]!.bars, kosdaq);
    expect(gate(ds).status).toBe("UNKNOWN");
    expect(gate(ds).issues).toContain("VOLATILITY_PROXY_DATE_MISMATCH");
  });

  it("rejects an omitted session inside a proxy window despite a same-day last close", () => {
    const ds = dataset();
    const kosdaq = makeBars(ds.tradeDates);
    kosdaq.splice(-5, 1);
    const point = buildDatedVolatilityObservations(ds.indexSeries[0]!.bars, kosdaq).at(-1)!;
    expect(point.value).toBeNull();
    expect(point.issues).toContain("VOLATILITY_PROXY_DATE_MISMATCH");
  });

  it("does not change historical proxy observations when future bars are appended", () => {
    const ds = dataset();
    const bars = ds.indexSeries[0]!.bars;
    const kosdaq = makeBars(ds.tradeDates, 2);
    expect(buildDatedVolatilityObservations(bars, kosdaq).slice(0, 85)).toEqual(
      buildDatedVolatilityObservations(bars.slice(0, 85), kosdaq.slice(0, 85)),
    );
  });
});
