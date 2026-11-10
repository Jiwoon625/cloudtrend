import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chartSavedUniverse } from "../src/lib/chartSavedUniverse";
import { runCurrentScreening } from "../src/lib/currentScreening";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { etfInstrumentChartSeries } from "../src/lib/engine/etfInstrumentChart";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { etfPartialEvidence } from "../src/lib/etfPartialEvidence";
import { restoreChartContext } from "../src/lib/instrumentChartStore.server";
import { assertEtfChartMatchesCard } from "../src/lib/instrumentChartContract";
import { deterministicAnalysis, stableCacheJson } from "../src/lib/screeningCacheContract";
import { addEtfChartPeers, createEtfChartFixture } from "./fixtures/etf-chart-fixture";

function input() {
  const raw = createEtfChartFixture(190);
  addEtfChartPeers(raw);
  raw.instruments.slice(1).forEach((peer, index) => {
    raw.bars[peer.symbol] = raw.bars[peer.symbol]!.map((bar, day) => ({
      ...bar,
      etfUnderlyingIndexClose:
        100 * Math.exp(day * 0.00015 * (index + 1) + 0.06 * Math.sin(day / (index + 3))),
    }));
  });
  const stale = raw.instruments.at(-1)!.symbol;
  raw.bars[stale] = raw.bars[stale]!.slice(0, -1);
  return { raw, stale };
}

describe("restored chart universe", () => {
  it("restores the exact saved members before ETF peer scoring, without changing raw inputs", () => {
    const { raw, stale } = input();
    const before = JSON.stringify(raw);
    const { analysis } = runCurrentScreening(raw, DEFAULT_SCORING_CONFIG);
    const digest = createHash("sha256")
      .update(stableCacheJson(deterministicAnalysis(analysis)))
      .digest("hex");
    const ctx = restoreChartContext(raw, analysis, DEFAULT_SCORING_CONFIG, digest);
    expect(ctx.dataset.instruments.some((instrument) => instrument.symbol === stale)).toBe(false);
    expect(Object.keys(ctx.dataset.bars)).not.toContain(stale);
    expect(ctx.dataset.instruments.map((instrument) => instrument.symbol).sort()).toEqual(
      analysis.rows.map((row) => row.instrument.symbol).sort(),
    );
    const row = analysis.rows.find((item) => item.instrument.symbol === "360750")!;
    const chart = etfInstrumentChartSeries(ctx.dataset, "360750");
    expect(chart.chart.at(-1)!.m0Score).toBeCloseTo(
      etfPartialEvidence(row, analysis.asOfDate).score!,
      8,
    );
    expect(() => assertEtfChartMatchesCard(chart, analysis, "360750")).not.toThrow();
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("preserves legacy saved membership instead of applying today's exclusion policy", () => {
    const { raw, stale } = input();
    const { analysis } = runFullMarketAnalysis(raw, DEFAULT_SCORING_CONFIG);
    const restored = chartSavedUniverse(raw, analysis);
    expect(restored.instruments.some((instrument) => instrument.symbol === stale)).toBe(true);
    expect(restored.bars[stale]).toBe(raw.bars[stale]);
  });

  it("rejects mismatched dates, absent members, duplicate members and changed instrument types", () => {
    const { raw } = input();
    const { analysis } = runCurrentScreening(raw, DEFAULT_SCORING_CONFIG);
    expect(() => chartSavedUniverse({ ...raw, asOfDate: "2000-01-01" }, analysis)).toThrow();
    expect(() => chartSavedUniverse({ ...raw, instruments: [] }, analysis)).toThrow();
    expect(() =>
      chartSavedUniverse(raw, { ...analysis, rows: [...analysis.rows, analysis.rows[0]!] }),
    ).toThrow();
    expect(() =>
      chartSavedUniverse(
        {
          ...raw,
          instruments: raw.instruments.map((instrument) => ({
            ...instrument,
            instrumentType: "STOCK" as const,
          })),
        },
        analysis,
      ),
    ).toThrow();
  });
});
