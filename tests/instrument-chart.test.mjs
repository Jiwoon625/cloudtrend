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
const ds = {
  indexSeries: [],
  bars: { TEST: bars },
  instruments: [{ symbol: "TEST", instrumentType: "STOCK" }],
};
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

const { getMockDataset } = await import("../src/lib/engine/mockProvider.ts");
const { runFullMarketAnalysis } = await import("../src/lib/engine/fullMarketAnalysis.ts");
const { historicalInstrumentScore } =
  await import("../src/lib/engine/historicalInstrumentScore.ts");
const { historicalTechnicalScore } = await import("../src/lib/engine/scoring.ts");
const { computeIndicators } = await import("../src/lib/engine/indicators.ts");
const truncate = (ds, date) => ({
  ...ds,
  asOfDate: date,
  bars: Object.fromEntries(
    Object.entries(ds.bars).map(([symbol, bars]) => [
      symbol,
      bars.filter((bar) => bar.tradeDate <= date),
    ]),
  ),
  indexSeries: ds.indexSeries.map((series) => ({
    ...series,
    bars: series.bars.filter((bar) => bar.tradeDate <= date),
  })),
});

test("dated chart scores match production screening including stock/ETF PL and no lookahead", () => {
  const raw = getMockDataset();
  const { dataset } = runFullMarketAnalysis(raw);
  const benchmark = dataset.indexSeries.find((series) => series.indexCode === "KOSPI");
  let awarded = 0;
  const markets = new Set();
  const sources = new Set();
  for (const position of [251, 275, benchmark.bars.length - 1]) {
    const date = benchmark.bars[position].tradeDate;
    const { analysis } = runFullMarketAnalysis(truncate(raw, date));
    for (const row of analysis.rows.filter((row) => row.instrument.instrumentType === "STOCK")) {
      const symbol = row.instrument.symbol;
      const index = dataset.bars[symbol].findIndex((bar) => bar.tradeDate === date);
      const chartScore = historicalInstrumentScore(dataset, symbol, index, DEFAULT_SCORING_CONFIG);
      assert.equal(chartScore.points, row.operatingScore10, `${symbol} ${date}: chart/card parity`);
      markets.add(row.instrument.market);
      sources.add(row.sectorPriceLeadershipSource);
      const slot = row.vf.rows.find((rule) => rule.group === "V8 Sector").points;
      if (slot === 0.5 && chartScore.points !== null) {
        const oldScore = historicalTechnicalScore(computeIndicators(dataset.bars[symbol], index));
        assert.equal(chartScore.points - oldScore.points, 0.5);
        awarded++;
      }
    }
  }
  assert.ok(awarded > 0, "fixture exercises the omitted 0.5-point slot");
  assert.ok(markets.has("KOSPI") && markets.has("KOSDAQ"));
  console.log(
    `Production parity verified; ${awarded} non-null rows recovered the missing sector half-point.`,
  );
});

test("historical policy uses stock PL fallback without sector ETFs and aligns stock date gaps", () => {
  const raw = getMockDataset();
  const target = raw.instruments.find(
    (item) => item.instrumentType === "STOCK" && item.market === "KOSPI",
  );
  const modified = {
    ...raw,
    instruments: raw.instruments.filter((item) => item.instrumentType !== "ETF"),
    bars: {
      ...raw.bars,
      [target.symbol]: raw.bars[target.symbol].filter((_, index) => index !== 270),
    },
  };
  const { dataset, analysis } = runFullMarketAnalysis(modified);
  const row = analysis.rows.find((item) => item.instrument.symbol === target.symbol);
  const bars = dataset.bars[target.symbol];
  const score = historicalInstrumentScore(
    dataset,
    target.symbol,
    bars.length - 1,
    DEFAULT_SCORING_CONFIG,
  );
  assert.equal(score.points, row.operatingScore10);
  const recent = compactChartSeries(dataset, target.symbol);
  const all = compactChartSeries(dataset, target.symbol, "all");
  assert.deepEqual(recent, all.slice(-120));
  assert.deepEqual(chartScoreHistory(recent), scoreHistory(dataset, target.symbol, 60));
});
