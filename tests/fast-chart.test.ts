import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { deterministicAnalysis, stableCacheJson } from "../src/lib/screeningCacheContract";
import { expect, test, vi } from "vitest";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { compactChartSeries } from "../src/lib/engine/instrumentChart";
import {
  chartPath,
  cardTechnicalScore,
  assertChartMatchesCard,
} from "../src/lib/instrumentChartContract";
import {
  restoreChartContext,
  scoredChart,
  priceChart,
  prepareChartBucket,
  publishRecentPrices,
  warmRecentCharts,
  type ChartContext,
} from "../src/lib/instrumentChartStore.server";
const identity = { inputFingerprint: "a".repeat(64), resultDigest: "b".repeat(64) };
function context(): ChartContext {
  return {
    ...runFullMarketAnalysis(getMockDataset(), DEFAULT_SCORING_CONFIG),
    config: DEFAULT_SCORING_CONFIG,
  };
}
test("all latest stock and ETF chart points equal the live card; recent/all histories overlap identically", () => {
  const ctx = context();
  for (const row of ctx.analysis.rows) {
    const chart = scoredChart(ctx, row.instrument.symbol, "120");
    expect(chart.chart.at(-1)?.historicalTechnicalPoints).toBeCloseTo(
      cardTechnicalScore(row) ?? 0,
      8,
    );
    expect(chart.chart).toEqual(
      compactChartSeries(ctx.dataset, row.instrument.symbol, "all", ctx.config).slice(-120),
    );
  }
});
test("null and non-null mismatches fail closed, never overwrite a point to match a card", () => {
  const ctx = context(),
    row = ctx.analysis.rows.find((r) => r.instrument.instrumentType === "STOCK")!;
  expect(() =>
    assertChartMatchesCard(
      [{ tradeDate: ctx.analysis.asOfDate, historicalTechnicalPoints: 123 }],
      ctx.analysis,
      row.instrument.symbol,
    ),
  ).toThrow("카드와 차트");
  row.operatingScore10 = null;
  expect(() =>
    assertChartMatchesCard(
      [{ tradeDate: ctx.analysis.asOfDate, historicalTechnicalPoints: 0 }],
      ctx.analysis,
      row.instrument.symbol,
    ),
  ).toThrow();
  expect(() =>
    assertChartMatchesCard(
      [{ tradeDate: ctx.analysis.asOfDate, historicalTechnicalPoints: null }],
      ctx.analysis,
      row.instrument.symbol,
    ),
  ).not.toThrow();
});
test("versioned cache isolates data, score configuration fingerprints, ranges and price/score phases", () => {
  const base = chartPath(identity, "005930", "120", "scored");
  expect(
    chartPath({ ...identity, inputFingerprint: "c".repeat(64) }, "005930", "120", "scored"),
  ).not.toBe(base);
  expect(
    chartPath({ ...identity, resultDigest: "d".repeat(64) }, "005930", "120", "scored"),
  ).not.toBe(base);
  expect(chartPath(identity, "005930", "all", "scored")).not.toBe(base);
  expect(chartPath(identity, "005930", "120", "prices")).not.toBe(base);
  expect(() => chartPath(identity, "../owner", "120", "prices")).toThrow();
});
function storage() {
  const files = new Map<string, Uint8Array>();
  const upload = vi.fn(
    async (path: string, bytes: Uint8Array, options: { contentType: string }) => {
      // Mirror the production bucket MIME allowlist.
      if (options.contentType !== "application/octet-stream")
        return { error: { message: "mime type is not supported" } };
      files.set(path, bytes);
      return { error: null };
    },
  );
  const download = vi.fn(async (path: string) =>
    files.has(path)
      ? { data: new Blob([files.get(path)! as BlobPart]), error: null }
      : { data: null, error: { statusCode: "404", message: "Object not found" } },
  );
  const client = { storage: { from: () => ({ upload, download }) } } as unknown as Parameters<
    typeof publishRecentPrices
  >[0];
  return { client, files, upload, download };
}
test("prices are independently usable; warmup is resumable and reuses same revision; all history is demand-only", async () => {
  const ctx = context(),
    s = storage();
  await publishRecentPrices(
    s.client,
    "owner",
    identity.inputFingerprint,
    identity.resultDigest,
    ctx,
  );
  expect(
    [...s.files.keys()].every(
      (p) => p.endsWith("-prices.json.gz") || p.endsWith("/prices-ready.json.gz"),
    ),
  ).toBe(true);
  expect(
    priceChart(ctx, ctx.analysis.rows[0]!.instrument.symbol, "120").chart[0],
  ).not.toHaveProperty("historicalTechnicalPoints");
  await warmRecentCharts(s.client, "owner", identity, ctx);
  const count = s.upload.mock.calls.length;
  await warmRecentCharts(s.client, "owner", identity, ctx);
  expect(s.upload).toHaveBeenCalledTimes(count);
  expect([...s.files.keys()].some((p) => p.includes("-all"))).toBe(false);
  const symbol = ctx.analysis.rows[0]!.instrument.symbol;
  await prepareChartBucket(s.client, "owner", identity, ctx, symbol, "all", "scored");
  expect([...s.files.keys()].some((p) => p.includes(symbol + "-all-scored"))).toBe(true);
});

test("incomplete live stock features remain null in both card and chart", () => {
  const raw = getMockDataset();
  const stock = raw.instruments.find((i) => i.instrumentType === "STOCK")!;
  raw.bars = {
    ...raw.bars,
    [stock.symbol]: raw.bars[stock.symbol]!.map((b) => ({ ...b, foreignNetBuyValue: null })),
  };
  const ctx = {
    ...runFullMarketAnalysis(raw, DEFAULT_SCORING_CONFIG),
    config: DEFAULT_SCORING_CONFIG,
  };
  const row = ctx.analysis.rows.find((r) => r.instrument.symbol === stock.symbol)!;
  expect(row.operatingScore10).toBeNull();
  expect(scoredChart(ctx, stock.symbol, "120").chart.at(-1)?.historicalTechnicalPoints).toBeNull();
});
test("failed cache writes return usable on-demand data but do not mark a warmup complete", async () => {
  const ctx = context(),
    s = storage(),
    symbol = ctx.analysis.rows[0]!.instrument.symbol;
  s.upload.mockResolvedValue({ error: { message: "temporary upload failure" } });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(
    (await prepareChartBucket(s.client, "owner", identity, ctx, symbol, "120", "scored", true))
      .chart.length,
  ).toBe(120);
  await expect(warmRecentCharts(s.client, "owner", identity, ctx)).rejects.toThrow();
  expect([...s.files.keys()].some((p) => p.endsWith("/scored-ready.json.gz"))).toBe(false);
  warn.mockRestore();
});

test("restored context preserves full-universe card parity without rescreening", () => {
  const raw = getMockDataset();
  const original = context();
  // Both use the same deterministic mock fixture; preserve stored result identity.
  const digest = createHash("sha256")
    .update(stableCacheJson(deterministicAnalysis(original.analysis)))
    .digest("hex");
  const restored = restoreChartContext(raw, original.analysis, original.config, digest);
  expect(restored.analysis).toBe(original.analysis);
  for (const row of original.analysis.rows)
    expect(scoredChart(restored, row.instrument.symbol, "120")).toEqual(
      scoredChart(original, row.instrument.symbol, "120"),
    );
  expect(() =>
    restoreChartContext(raw, original.analysis, original.config, "0".repeat(64)),
  ).toThrow("검증");
});

test("context reuse stays owner/revision scoped and expires after five idle minutes", async () => {
  const { primeChartContext, cachedChartContext } =
    await import("../src/lib/instrumentChartStore.server");
  const ctx = context();
  const now = vi.spyOn(Date, "now");
  now.mockReturnValue(1000);
  primeChartContext("owner-cache", identity.inputFingerprint, identity.resultDigest, ctx);
  expect(cachedChartContext("other-owner", identity)).toBeUndefined();
  expect(
    cachedChartContext("owner-cache", { ...identity, inputFingerprint: "c".repeat(64) }),
  ).toBeUndefined();
  expect(
    cachedChartContext("owner-cache", { ...identity, resultDigest: "d".repeat(64) }),
  ).toBeUndefined();
  now.mockReturnValue(241000);
  expect(cachedChartContext("owner-cache", identity)).toBe(ctx);
  now.mockReturnValue(481000);
  expect(cachedChartContext("owner-cache", identity)).toBe(ctx);
  now.mockReturnValue(782000);
  expect(cachedChartContext("owner-cache", identity)).toBeUndefined();
  now.mockRestore();
});

test("simultaneous bucket requests coalesce without returning another symbol's prices", async () => {
  const ctx = context(),
    s = storage();
  const [a, b] = ctx.analysis.rows;
  const chartContext = {
    ...ctx,
    analysis: {
      ...ctx.analysis,
      rows: [
        { ...a!, instrument: { ...a!.instrument, symbol: "AA" } },
        { ...b!, instrument: { ...b!.instrument, symbol: "CC" } },
      ],
    },
    dataset: {
      ...ctx.dataset,
      bars: {
        AA: ctx.dataset.bars[a!.instrument.symbol]!,
        CC: ctx.dataset.bars[b!.instrument.symbol]!,
      },
    },
  };
  expect(chartPath(identity, "AA", "120", "prices")).toBe(
    chartPath(identity, "CC", "120", "prices"),
  );
  // Seed the older partial-bundle edge case: both callers must recover complete data.
  s.files.set(
    `coalesced/${chartPath(identity, "AA", "120", "prices")}`,
    gzipSync(JSON.stringify({ AA: priceChart(chartContext, "AA", "120") })),
  );
  const [first, second, duplicate] = await Promise.all([
    prepareChartBucket(s.client, "coalesced", identity, chartContext, "AA", "120", "prices"),
    prepareChartBucket(s.client, "coalesced", identity, chartContext, "CC", "120", "prices"),
    prepareChartBucket(s.client, "coalesced", identity, chartContext, "AA", "120", "prices"),
  ]);
  expect(first).toEqual(priceChart(chartContext, "AA", "120"));
  expect(second).toEqual(priceChart(chartContext, "CC", "120"));
  expect(duplicate).toEqual(first);
  expect(s.upload).toHaveBeenCalledOnce();
});

test("full scored preparation yields to prices and preserves every chart/history point", async () => {
  const ctx = context(),
    s = storage(),
    symbol = ctx.analysis.rows[0]!.instrument.symbol;
  let scoreFinished = false;
  const score = prepareChartBucket(
    s.client,
    "yielding",
    identity,
    ctx,
    symbol,
    "all",
    "scored",
  ).then((value) => {
    scoreFinished = true;
    return value;
  });
  const price = await prepareChartBucket(
    s.client,
    "yielding",
    identity,
    ctx,
    symbol,
    "all",
    "prices",
  );
  expect(scoreFinished).toBe(false);
  expect(price).toEqual(priceChart(ctx, symbol, "all"));
  expect(await score).toEqual(scoredChart(ctx, symbol, "all"));
});
