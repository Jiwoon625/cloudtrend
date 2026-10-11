import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KospiVolatilityObservation, MarketDataset } from "./engine/dataset";
import { runFullMarketAnalysis } from "./engine/fullMarketAnalysis";
import { evaluateKospiMarketGateAtDate } from "./engine/kospiMarketGate";
import { parseManualMarketData } from "./engine/manualDataset";
import { hashSeriesValue } from "./ledger/modelSeries";
import { krDailyInputArchive } from "./ledger/octoberShadowArchive";
import { buildSnapshot } from "./screeningSnapshot";
import { sliceKrDatasetForReplay } from "./shadowReplay.server";

const decisionDate = "2026-10-06";
const futureDate = "2026-10-07";

beforeEach(() => vi.useFakeTimers().setSystemTime("2026-10-15T00:00:00Z"));
afterEach(() => vi.useRealTimers());

function historicalDataset(includeVkospi = true): MarketDataset {
  const dates: string[] = [];
  for (let at = Date.parse(`${decisionDate}T00:00:00Z`); dates.length < 130; at -= 86_400_000) {
    const day = new Date(at);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
      dates.unshift(day.toISOString().slice(0, 10));
  }
  const instruments = [
    { symbol: "005930", name: "Synthetic stock", market: "KOSPI", type: "STOCK" },
    { symbol: "KOSPI", name: "Synthetic index", market: "INDEX", type: "INDEX" },
    ...(includeVkospi
      ? [{ symbol: "VKOSPI", name: "Synthetic volatility", market: "INDEX", type: "INDEX" }]
      : []),
  ];
  return parseManualMarketData(
    JSON.stringify(
      dates.flatMap((date, index) =>
        instruments.map((instrument) => {
          const close = instrument.symbol === "VKOSPI" ? 15 : 100 + index;
          return {
            ...instrument,
            date,
            open: close,
            high: close + 1,
            low: close - 1,
            close,
            volume: 100_000,
            tradingValue: 10_000_000,
            marketCap: 100_000_000_000,
            foreignNetBuyValue: 10,
            institutionNetBuyValue: 0,
          };
        }),
      ),
    ),
  ).dataset;
}

function withFutureObservation(raw: MarketDataset): MarketDataset {
  const extended = structuredClone(raw);
  extended.asOfDate = futureDate;
  extended.tradeDates.push(futureDate);
  extended.kospiGateDates?.push(futureDate);
  for (const bars of [
    ...Object.values(extended.bars),
    ...Object.values(extended.observedBars ?? {}),
    ...extended.indexSeries.map((series) => series.bars),
  ]) {
    bars.push({ ...bars.at(-1)!, tradeDate: futureDate });
  }
  extended.vkospiObservations!.push({ date: futureDate, value: 45, source: "VKOSPI" });
  extended.vkospiSeries.push(45);
  return extended;
}

describe("KR replay legacy volatility point-in-time projection", () => {
  it("keeps the earlier slice, legacy gate and daily archive hash unchanged after a future append", async () => {
    const raw = historicalDataset();
    const original = structuredClone(raw);
    const before = sliceKrDatasetForReplay(raw, decisionDate);
    const after = sliceKrDatasetForReplay(withFutureObservation(raw), decisionDate);

    expect(after).toEqual(before);
    expect(raw).toEqual(original);
    expect(after.vkospiSeries.at(-1)).toBe(15);
    expect(await hashSeriesValue(after)).toBe(await hashSeriesValue(before));

    const left = runFullMarketAnalysis(before);
    const right = runFullMarketAnalysis(after);
    expect(left.analysis.marketGate).toMatchObject({
      status: "RISK_ON",
      vkospiBelow30: true,
    });
    expect(right.analysis).toEqual(left.analysis);
    const decisionAt = "2026-10-07T08:10:00+09:00";
    const leftArchive = krDailyInputArchive(
      left.dataset,
      buildSnapshot(left.analysis, decisionAt),
      decisionAt,
    );
    const rightArchive = krDailyInputArchive(
      right.dataset,
      buildSnapshot(right.analysis, decisionAt),
      decisionAt,
    );
    expect(await hashSeriesValue(rightArchive)).toBe(await hashSeriesValue(leftArchive));
  });

  it.each([true, false])(
    "preserves complete historical provider output, including late uploads (actual VKOSPI: %s)",
    (includeVkospi) => {
      const raw = historicalDataset(includeVkospi);
      const sliced = sliceKrDatasetForReplay(raw, decisionDate);
      expect(sliced.vkospiSeries).toEqual(raw.vkospiSeries);
      expect(sliced.vkospiObservations).toEqual(raw.vkospiObservations);
      expect(runFullMarketAnalysis(sliced).analysis).toEqual({
        ...runFullMarketAnalysis(raw).analysis,
        dataVersion: sliced.version,
      });
      // Upload time is deliberately absent: historical market dates define this slice.
      expect(sliced.vkospiSeries.length).toBeGreaterThan(0);
    },
  );

  it("uses observation dates instead of insertion order or an unrelated legacy array", () => {
    const raw = historicalDataset();
    raw.vkospiObservations = [
      { date: decisionDate, value: 21, source: "VKOSPI" },
      { date: futureDate, value: 45, source: "VKOSPI" },
      { date: "2026-10-02", value: 18, source: "VKOSPI" },
      { date: "2026-10-01", value: null, source: "REALIZED_VOLATILITY_KOSPI" },
      { date: "2026-09-30", value: Number.NaN, source: "VKOSPI" },
    ];
    raw.vkospiSeries = [999];
    const before = structuredClone(raw);
    const sliced = sliceKrDatasetForReplay(raw, decisionDate);
    expect(sliced.vkospiSeries).toEqual([18, 21]);
    expect(sliced.vkospiObservations).toEqual(
      raw.vkospiObservations.filter((point) => point.date <= decisionDate),
    );
    expect(raw).toEqual(before);
  });

  it.each([undefined, []])(
    "does not infer chronology for undated-only legacy arrays (observations: %s)",
    (observations) => {
      const raw = historicalDataset();
      if (observations) raw.vkospiObservations = observations;
      else delete raw.vkospiObservations;
      expect(raw.vkospiSeries).toHaveLength(raw.tradeDates.length);
      const sliced = sliceKrDatasetForReplay(raw, decisionDate);
      expect(sliced.vkospiSeries).toEqual([]);
      expect(runFullMarketAnalysis(sliced).analysis.marketGate.vkospiBelow30).toBeNull();
      expect(evaluateKospiMarketGateAtDate(sliced, decisionDate)).toMatchObject({
        status: "UNKNOWN",
        vkospi: null,
        issues: ["MISSING_DATED_VOLATILITY"],
      });
    },
  );

  it("leaves duplicate dated evidence ambiguous instead of silently deduplicating it", () => {
    const raw = historicalDataset();
    raw.vkospiObservations!.push({ date: decisionDate, value: 40, source: "VKOSPI" });
    const sliced = sliceKrDatasetForReplay(raw, decisionDate);
    expect(sliced.vkospiObservations?.filter((point) => point.date === decisionDate)).toHaveLength(
      2,
    );
    expect(sliced.vkospiSeries.slice(-2)).toEqual([15, 40]);
    expect(evaluateKospiMarketGateAtDate(sliced, decisionDate)).toMatchObject({
      status: "UNKNOWN",
      vkospi: null,
      issues: ["AMBIGUOUS_VOLATILITY_DATE"],
    });
  });

  it("retains missing provenance for the strict gate to reject without inventing a source", () => {
    const raw = historicalDataset();
    raw.vkospiObservations![raw.vkospiObservations!.length - 1] = {
      date: decisionDate,
      value: 21,
    } as KospiVolatilityObservation;
    const sliced = sliceKrDatasetForReplay(raw, decisionDate);
    expect(sliced.vkospiObservations?.at(-1)).toEqual({ date: decisionDate, value: 21 });
    expect(evaluateKospiMarketGateAtDate(sliced, decisionDate)).toMatchObject({
      status: "UNKNOWN",
      vkospi: null,
      volatilitySource: null,
      issues: ["INVALID_VOLATILITY_PROVENANCE"],
    });
  });

  it("does not treat invalid dates as chronological evidence or hide them from the strict gate", () => {
    const raw = historicalDataset();
    raw.vkospiObservations!.push(
      { date: "", value: 50, source: "VKOSPI" },
      { date: "2026-02-30", value: 60, source: "VKOSPI" },
    );
    const sliced = sliceKrDatasetForReplay(raw, decisionDate);
    expect(sliced.vkospiSeries).toEqual(raw.vkospiSeries);
    expect(sliced.vkospiObservations).toEqual(raw.vkospiObservations);
    expect(evaluateKospiMarketGateAtDate(sliced, decisionDate)).toMatchObject({
      status: "UNKNOWN",
      vkospi: null,
      issues: ["INVALID_VOLATILITY_DATE"],
    });
  });
});
