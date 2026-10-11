/** Synthetic-only profile: vite-node --config vitest.charts.config.ts --script scripts/profile-instrument-charts.ts */
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { getMockDataset, buildTradeDates } from "../src/lib/engine/mockProvider";
import { compactChartSeries } from "../src/lib/engine/instrumentChart";
import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import {
  prepareChartBucket,
  scoredChart,
  priceChart,
  type ChartContext,
} from "../src/lib/instrumentChartStore.server";
import { loadActiveSources, type ActiveSourceRecord } from "../src/lib/screeningSources.server";
import type { AnalysisResult } from "../src/lib/engine/pipeline";

const mock = getMockDataset(),
  dates = buildTradeDates(1250);
const bars = dates.map((tradeDate, index) => ({
  ...mock.bars[mock.instruments[0]!.symbol]![index % 300]!,
  tradeDate,
  open: 100 + index * 0.2,
  high: 102 + index * 0.2,
  low: 99 + index * 0.2,
  close: 100 + index * 0.2,
}));
const dataset = {
  ...mock,
  instruments: Array.from({ length: 240 }, (_, index) => ({
    ...mock.instruments[0]!,
    symbol: `S${index}`,
  })),
  bars: Object.fromEntries(Array.from({ length: 240 }, (_, index) => [`S${index}`, bars])),
  indexSeries: mock.indexSeries.map((series) => ({ ...series, bars })),
  asOfDate: dates.at(-1)!,
};
const elapsed = (started: number) => Math.round((performance.now() - started) * 100) / 100;
function timed<T>(name: string, run: () => T) {
  const start = performance.now();
  const result = run();
  console.log(JSON.stringify({ name, ms: elapsed(start) }));
  return result;
}
const expected = timed("stock-cold-240-symbols-1250-dates", () =>
  compactChartSeries(dataset, "S0", "all"),
);
timed("stock-warm-same-dataset", () => compactChartSeries(dataset, "S0", "all"));
timed("etf-1250-dates", () =>
  compactChartSeries(
    {
      ...dataset,
      instruments: [
        { ...mock.instruments.find((item) => item.instrumentType === "ETF")!, symbol: "E0" },
      ],
      bars: { E0: bars },
    },
    "E0",
    "all",
  ),
);
const context = (): ChartContext => ({
  dataset: { ...dataset },
  config: DEFAULT_SCORING_CONFIG,
  analysis: {
    asOfDate: dataset.asOfDate,
    rows: [
      {
        instrument: dataset.instruments[0]!,
        operatingScore10: expected.at(-1)!.historicalTechnicalPoints,
      },
    ],
  } as AnalysisResult,
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const client = {
  storage: {
    from: () => ({
      download: async () => {
        await pause(10);
        return { data: null, error: { statusCode: "404", message: "Object not found" } };
      },
      upload: async () => {
        await pause(10);
        return { error: null };
      },
    }),
  },
} as unknown as Parameters<typeof prepareChartBucket>[0];
async function original(ctx: ChartContext, kind: "prices" | "scored") {
  await pause(10);
  const value = kind === "scored" ? scoredChart(ctx, "S0", "all") : priceChart(ctx, "S0", "all");
  gzipSync(JSON.stringify({ S0: value }));
  await pause(10);
  return value;
}
for (const mode of ["before-synchronous", "after-yielding"]) {
  const ctx = context(),
    start = performance.now();
  let firstPrice = 0;
  const prepare = (kind: "prices" | "scored") =>
    mode === "before-synchronous"
      ? original(ctx, kind)
      : prepareChartBucket(
          client,
          `synthetic-${mode}`,
          { inputFingerprint: "a".repeat(64), resultDigest: "b".repeat(64) },
          ctx,
          "S0",
          "all",
          kind,
        );
  const score = prepare("scored");
  const price = prepare("prices").then((value) => {
    firstPrice = elapsed(start);
    return value;
  });
  const [result] = await Promise.all([score, price]);
  if (JSON.stringify(result.chart) !== JSON.stringify(expected))
    throw new Error("Score parity failed");
  console.log(
    JSON.stringify({
      name: mode,
      priceReadyMs: firstPrice,
      allReadyMs: elapsed(start),
      points: result.chart.length,
      storageLatencyPerCallMs: 10,
    }),
  );
}
const header =
  "symbol,name,market,type,date,open,high,low,close,volume,tradingValue,marketCap,foreignNetBuyValue";
const text =
  header +
  "\n" +
  [
    { symbol: "KOSPI", name: "synthetic-index", market: "INDEX", type: "INDEX" },
    ...dataset.instruments
      .slice(0, 60)
      .map((inst) => ({ symbol: inst.symbol, name: inst.name, market: "KOSPI", type: "STOCK" })),
  ]
    .flatMap((inst) =>
      bars.map((bar) =>
        [
          inst.symbol,
          inst.name,
          inst.market,
          inst.type,
          bar.tradeDate,
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume,
          bar.tradingValue,
          bar.marketCap,
          bar.foreignNetBuyValue,
        ].join(","),
      ),
    )
    .join("\n");
console.log(
  JSON.stringify({ name: "synthetic-source", bytes: Buffer.byteLength(text), rows: 61 * 1250 }),
);
timed("parse-source-76250-rows", () => parseManualMarketData([text]));
const body = new TextEncoder().encode("synthetic"),
  file_hash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
const sources = Array.from({ length: 6 }, (_, index) => ({
  id: String(index),
  original_filename: `synthetic-${index}.csv`,
  storage_bucket: "cloudtrend-data",
  storage_path: `synthetic/source-${index}.csv`,
  file_hash,
})) as ActiveSourceRecord[];
const query = {
  select() {
    return this;
  },
  eq() {
    return this;
  },
  order() {
    return this;
  },
  then(resolve: (value: unknown) => unknown) {
    return Promise.resolve({ data: sources, error: null }).then(resolve);
  },
};
const sourceClient = {
  from: () => query,
  storage: {
    from: () => ({
      download: async () => {
        await pause(50);
        return { data: new Blob([body]), error: null };
      },
    }),
  },
} as unknown as Parameters<typeof loadActiveSources>[0];
for (const concurrency of [1, 3]) {
  const start = performance.now();
  await loadActiveSources(sourceClient, "synthetic", concurrency);
  console.log(
    JSON.stringify({
      name: `source-download-concurrency-${concurrency}`,
      ms: elapsed(start),
      sources: 6,
      latencyPerSourceMs: 50,
    }),
  );
}
