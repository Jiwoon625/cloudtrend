import { describe, expect, it } from "vitest";

import type { PreparedVfFeatureSeries, VfFeatureId } from "./v8VfFeatureValidation";
import {
  V8_VF_FEATURE_IDS,
  buildV8VfFeatureValidationFromSeries,
  neweyWestMean,
} from "./v8VfFeatureValidation";
import type { DailyPrice, IndexSeries } from "./types";

function bar(day: number, base = 100): DailyPrice {
  const open = base + day;
  return {
    tradeDate: `2026-01-${String(day + 1).padStart(2, "0")}`,
    open,
    high: open + 2,
    low: open - 1,
    close: open + 1,
    volume: 1_000_000,
    tradingValue: 100_000_000,
    marketCap: 1_000_000_000_000,
    foreignNetBuyValue: 100_000_000,
    institutionNetBuyValue: 0,
  };
}

function stateRecord(values: number[]): Record<VfFeatureId, Int8Array> {
  return Object.fromEntries(
    V8_VF_FEATURE_IDS.map((feature) => [feature, Int8Array.from(values)]),
  ) as Record<VfFeatureId, Int8Array>;
}

describe("V8 Vf feature validation", () => {
  it("counts state and onset separately without treating null-to-true as onset", () => {
    const bars = Array.from({ length: 8 }, (_, i) => bar(i));
    const states = [0, 1, 1, 0, 1, 0, 0, 0];
    const series: PreparedVfFeatureSeries[] = [
      {
        symbol: "000001",
        name: "TEST",
        market: "KOSPI",
        bars,
        states: stateRecord(states),
      },
    ];
    const indexSeries: IndexSeries[] = [
      { indexCode: "KOSPI", indexName: "KOSPI", bars: bars.map((b) => ({ ...b })) },
      { indexCode: "KOSDAQ", indexName: "KOSDAQ", bars: bars.map((b) => ({ ...b })) },
    ];
    const result = buildV8VfFeatureValidationFromSeries(series, indexSeries, {
      horizons: [2],
      warmupDays: 0,
    });
    expect(result).not.toBeNull();
    const rows = result!.rows.filter(
      (row) =>
        row.scope === "SPLIT" &&
        row.split === "ALL" &&
        row.market === "ALL" &&
        row.feature === "ICH_ABOVE_CLOUD" &&
        row.horizon === 2,
    );
    expect(rows.find((row) => row.signalKind === "STATE")?.signalCount).toBe(3);
    expect(rows.find((row) => row.signalKind === "ONSET")?.signalCount).toBe(2);
    expect(rows.find((row) => row.signalKind === "STATE")?.controlCount).toBe(3);
  });

  it("uses a finite Newey-West estimate for a non-degenerate daily edge series", () => {
    const result = neweyWestMean([0.2, 0.4, -0.1, 0.5, 0.3, 0.1], 2);
    expect(result.count).toBe(6);
    expect(result.mean).toBeCloseTo(0.2333333333, 8);
    expect(result.standardError).not.toBeNull();
    expect(result.t).not.toBeNull();
    expect(result.ciLow).not.toBeNull();
    expect(result.ciHigh).not.toBeNull();
  });
});
