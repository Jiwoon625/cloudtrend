import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL) {
      const url = new URL(specifier + ".ts", context.parentURL);
      if (existsSync(url)) return nextResolve(url.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { chartSeries, scoreHistory } = await import("../src/lib/engine/pipeline.ts");
const { compactChartSeries, chartScoreHistory, buildCompactChart } =
  await import("../src/lib/engine/instrumentChart.ts");
const { DEFAULT_SCORING_CONFIG } = await import("../src/lib/engine/scoring.ts");
const bars = Array.from({ length: 1250 }, (_, i) => ({
  tradeDate: new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
  open: 100 + i,
  high: 102 + i,
  low: 99 + i,
  close: 101 + i,
  volume: 1000,
  tradingValue: 100000,
  marketCap: 1e12,
  foreignNetBuyValue: i % 9 ? 1e6 : null,
  institutionNetBuyValue: null,
}));
const ds = { bars: { TEST: bars }, instruments: [{ symbol: "TEST", instrumentType: "STOCK" }] };
const pick = ({ tradeDate, close, volume, historicalTechnicalPoints, historicalTechnical }) => ({
  tradeDate,
  close,
  volume,
  historicalTechnicalPoints,
  historicalTechnical,
});
test("120-day view preserves full-history scores and removes only chart overlays", () => {
  const full = chartSeries(ds, "TEST");
  const recent = compactChartSeries(ds, "TEST");
  assert.equal(recent.length, 120);
  assert.deepEqual(recent, full.slice(-120).map(pick));
  assert.deepEqual(compactChartSeries(ds, "TEST", "all"), full.map(pick));
  assert.deepEqual(chartScoreHistory(recent), scoreHistory(ds, "TEST", 60));
  assert.ok(JSON.stringify(recent).length < JSON.stringify(full).length / 5);
});
test("async batches match engine values with custom config, missing inputs and warm-up", async () => {
  const config = {
    ...DEFAULT_SCORING_CONFIG,
    technical: { ...DEFAULT_SCORING_CONFIG.technical, volumeStrongRatio: 50 },
  };
  const short = { ...ds, bars: { TEST: bars.slice(0, 80) } };
  for (const data of [short, ds]) {
    const result = await buildCompactChart(data, "TEST", "120", config);
    assert.deepEqual(result.chart, chartSeries(data, "TEST", 120, config).map(pick));
    assert.deepEqual(result.history, scoreHistory(data, "TEST", 60, config));
  }
  assert.deepEqual(await buildCompactChart(ds, "MISSING", "all", config), {
    chart: [],
    history: [],
  });
});
