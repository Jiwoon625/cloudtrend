import { describe, expect, it } from "vitest";
import type { MarketDataset } from "./engine/dataset";
import { shadowReplayClock, sliceKrDatasetForReplay } from "./shadowReplay.server";

describe("Shadow replay clock", () => {
  it("separates actual calculation time from the frozen KR signal/decision clock", () => {
    const contemporary = shadowReplayClock(
      "KR",
      "2026-10-06",
      "2026-10-06T23:20:00Z",
    );
    expect(contemporary).toMatchObject({
      signalDate: "2026-10-06",
      modelAvailableAt: "2026-10-07T08:00:00+09:00",
      modelDecisionAt: "2026-10-07T08:10:00+09:00",
      executionAt: "2026-10-07T00:00:00Z",
      replayMode: "CONTEMPORANEOUS",
    });

    const late = shadowReplayClock("KR", "2026-10-06", "2026-10-08T00:00:00Z");
    expect(late.modelAvailableAt).toBe(contemporary.modelAvailableAt);
    expect(late.modelDecisionAt).toBe(contemporary.modelDecisionAt);
    expect(late.executionAt).toBe(contemporary.executionAt);
    expect(late.replayMode).toBe("RETROSPECTIVE");
  });

  it("uses US market event time even when the source is uploaded days later", () => {
    const clock = shadowReplayClock("US", "2026-10-05", "2026-10-08T12:00:00Z");
    expect(clock).toMatchObject({
      signalDate: "2026-10-05",
      modelAvailableAt: "2026-10-05T20:01:00Z",
      modelDecisionAt: "2026-10-05T20:02:00Z",
      executionAt: "2026-10-06T13:30:00Z",
      replayMode: "RETROSPECTIVE",
    });
  });
});

describe("KR point-in-time dataset slicing", () => {
  it("removes future rows and symbols that did not have a row on the signal date", () => {
    const raw = {
      provider: "TEST",
      version: "multi-day",
      asOfDate: "2026-10-07",
      isLive: true,
      capabilities: {},
      notes: [],
      sectors: [],
      tradeDates: ["2026-10-06", "2026-10-07"],
      kospiGateDates: ["2026-10-06", "2026-10-07"],
      instruments: [
        {
          id: "000001",
          symbol: "000001",
          name: "A",
          market: "KOSPI",
          instrumentType: "STOCK",
          sectorCode: "S",
          sectorName: "S",
        },
        {
          id: "000002",
          symbol: "000002",
          name: "B",
          market: "KOSDAQ",
          instrumentType: "STOCK",
          sectorCode: "S",
          sectorName: "S",
        },
      ],
      bars: {
        "000001": [
          { tradeDate: "2026-10-06", open: 10, high: 10, low: 10, close: 10, volume: 1 },
          { tradeDate: "2026-10-07", open: 20, high: 20, low: 20, close: 20, volume: 1 },
        ],
        "000002": [
          { tradeDate: "2026-10-07", open: 30, high: 30, low: 30, close: 30, volume: 1 },
        ],
      },
      indexSeries: [
        {
          indexCode: "KOSPI",
          bars: [
            { tradeDate: "2026-10-06", open: 100, high: 100, low: 100, close: 100, volume: 1 },
            { tradeDate: "2026-10-07", open: 101, high: 101, low: 101, close: 101, volume: 1 },
          ],
        },
      ],
      financials: {},
      etfFacts: {},
      vkospiSeries: [],
      vkospiObservations: [
        { date: "2026-10-06", value: 20, source: "TEST" },
        { date: "2026-10-07", value: 21, source: "TEST" },
      ],
      kospiPriceInputIssues: {
        "2026-10-07": ["future"],
      },
    } as unknown as MarketDataset;

    const sliced = sliceKrDatasetForReplay(raw, "2026-10-06");
    expect(sliced.asOfDate).toBe("2026-10-06");
    expect(sliced.instruments.map((instrument) => instrument.symbol)).toEqual(["000001"]);
    expect(sliced.bars["000001"]?.map((bar) => bar.tradeDate)).toEqual(["2026-10-06"]);
    expect(sliced.bars["000002"]).toBeUndefined();
    expect(sliced.indexSeries[0]?.bars.map((bar) => bar.tradeDate)).toEqual(["2026-10-06"]);
    expect(sliced.tradeDates).toEqual(["2026-10-06"]);
    expect(sliced.kospiGateDates).toEqual(["2026-10-06"]);
    expect(sliced.vkospiObservations?.map((point) => point.date)).toEqual(["2026-10-06"]);
    expect(sliced.kospiPriceInputIssues).toEqual({});
  });
});
