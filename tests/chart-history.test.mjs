// Run with Node 24+: node --test tests/chart-history.test.mjs
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Resolve the project's extensionless TypeScript imports for Node's native TS runner.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL) {
      const url = new URL(specifier + ".ts", context.parentURL);
      if (existsSync(url)) return nextResolve(url.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { computeIndicators } = await import("../src/lib/engine/indicators.ts");
const { chartSeries } = await import("../src/lib/engine/pipeline.ts");
const { historicalTechnicalScore, vfStockScore, DEFAULT_SCORING_CONFIG } =
  await import("../src/lib/engine/scoring.ts");

const bars = Array.from({ length: 1250 }, (_, i) => ({
  tradeDate: new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
  open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i,
  volume: 1000, tradingValue: 100000, marketCap: 1e12,
  foreignNetBuyValue: 1000000, institutionNetBuyValue: null,
}));
const dataset = (prices, instrumentType = "STOCK") => ({
  bars: { TEST: prices },
  instruments: [{ symbol: "TEST", instrumentType }],
});
const allPassing = () => {
  const snap = computeIndicators(bars, 299);
  return {
    ...snap,
    bollinger: { ...snap.bollinger, bbBreakout: true, headFakeWarning: false },
    volumeRatio20: 200,
    closeLocationValue: 0.9,
  };
};

test("full chart covers all 1,250 supplied dates, including warm-up", () => {
  const chart = chartSeries(dataset(bars), "TEST");
  assert.equal(chart.length, bars.length);
  assert.equal(chart[0].tradeDate, bars[0].tradeDate);
  assert.equal(chart[0].historicalTechnicalPoints, null);
  assert.equal(chart.at(-1).tradeDate, bars.at(-1).tradeDate);
  for (const point of chart) {
    assert.ok(point.historicalTechnicalPoints === null ||
      (point.historicalTechnicalPoints >= 0 && point.historicalTechnicalPoints <= 9.5));
  }
});

test("full score includes the 52-week feature and requires complete data", () => {
  const snap = allPassing();
  assert.equal(vfStockScore(snap).points, 9.5);
  assert.equal(historicalTechnicalScore(snap).points, 9.5);
  assert.equal(historicalTechnicalScore(snap).rawMaxPoints, 9.5);
  assert.equal(historicalTechnicalScore({ ...snap, distanceFrom52wHigh: null }).points, null);
  assert.equal(historicalTechnicalScore({ ...snap, distanceFrom52wHigh: -50 }).points, 7);
});

test("foreign flow contributes two points; missing flow never rescales the score", () => {
  const snap = allPassing();
  const missing = historicalTechnicalScore({ ...snap, foreignNet20d: null });
  const negative = historicalTechnicalScore({ ...snap, foreignNet20d: -1 });
  assert.equal(missing.points, null);
  assert.equal(missing.availableMaxPoints, 7.5);
  assert.equal(missing.missingRules.length, 1);
  assert.equal(negative.points, 7.5);
  assert.equal(negative.availableMaxPoints, 9.5);
});

test("historical values are identical when later prices and flows are absent", () => {
  const complete = chartSeries(dataset(bars.slice(0, 320)), "TEST");
  for (const end of [0, 18, 19, 20, 25, 77, 118, 119, 250, 251, 299]) {
    const prefix = chartSeries(dataset(bars.slice(0, end + 1)), "TEST");
    assert.deepEqual(complete[end], prefix.at(-1));
    const raw = vfStockScore(computeIndicators(bars, end));
    const score = complete[end].historicalTechnical;
    assert.equal(score.rawPoints, raw.points);
    assert.equal(score.rawMaxPoints, 9.5);
  }
});

test("selected chart window uses preceding history and honors active settings", () => {
  const cfg = {
    ...DEFAULT_SCORING_CONFIG,
    technical: { ...DEFAULT_SCORING_CONFIG.technical, volumeStrongRatio: 50 },
  };
  const full = chartSeries(dataset(bars.slice(0, 150)), "TEST", Infinity, cfg);
  const tail = chartSeries(dataset(bars.slice(0, 150)), "TEST", 10, cfg);
  assert.deepEqual(tail, full.slice(-10));
  assert.equal(tail.at(-1).historicalTechnicalPoints,
    historicalTechnicalScore(computeIndicators(bars, 149), cfg).points);
});

test("empty symbols stay empty; ETFs use the same full score overlay", () => {
  assert.deepEqual(chartSeries(dataset([]), "TEST"), []);
  assert.deepEqual(chartSeries(dataset(bars), "MISSING"), []);
  const etf = chartSeries(dataset(bars.slice(0, 300), "ETF"), "TEST");
  assert.ok(etf.slice(0, 251).every((p) => p.historicalTechnicalPoints === null));
  assert.equal(etf[251].historicalTechnicalPoints, vfStockScore(computeIndicators(bars, 251)).points);
});
