/** Synthetic-only: npx vite-node --config vitest.charts.config.ts --script scripts/profile-etf-instrument-charts.ts */
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import {
  createEtfChartFixture,
  addEtfChartPeers,
  addEtfChartDomesticSector,
  ETF_CHART_TEST_SYMBOL,
} from "../tests/fixtures/etf-chart-fixture";
import { calculateEtfStrategies } from "../src/lib/engine/etfStrategy";
import { instrumentChartPoint } from "../src/lib/engine/instrumentChart";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import { prepareChartBucket, type ChartContext } from "../src/lib/instrumentChartStore.server";
import type { ChartKind } from "../src/lib/instrumentChartContract";

const dataset = createEtfChartFixture(1250);
addEtfChartPeers(dataset);
const domestic = addEtfChartDomesticSector(dataset, 240);
for (const instrument of dataset.instruments) {
  if (instrument.instrumentType !== "STOCK") continue;
  dataset.bars[instrument.symbol] = dataset.bars[instrument.symbol]!.map((bar) => ({
    ...bar,
    foreignNetBuyValue: 0,
  }));
}
const strategies = calculateEtfStrategies(dataset);
const stockSymbol = "STOCK0";
const ctx: ChartContext = {
  dataset,
  config: DEFAULT_SCORING_CONFIG,
  analysis: {
    asOfDate: dataset.asOfDate,
    rows: dataset.instruments.map((instrument) => ({
      instrument,
      snapshot: {
        tradeDate: dataset.asOfDate,
        close: dataset.bars[instrument.symbol]!.at(-1)!.close,
      },
      etfStrategy: strategies.get(instrument.symbol),
      operatingScore10:
        instrument.instrumentType === "STOCK"
          ? instrumentChartPoint(dataset, instrument.symbol, 1249, DEFAULT_SCORING_CONFIG)
              .historicalTechnicalPoints
          : null,
    })),
  } as unknown as AnalysisResult,
};
console.log(
  JSON.stringify({
    fixture:
      "synthetic-only; local compute + in-memory compressed storage; not production/network latency",
    sessions: 1250,
    stocks: 240,
    etfs: strategies.size,
  }),
);
const identity = { inputFingerprint: "a".repeat(64), resultDigest: "b".repeat(64) };
const files = new Map<string, Uint8Array>();
let reads = 0,
  writes = 0;
const client = {
  storage: {
    from: () => ({
      download: async (path: string) => {
        reads++;
        return files.has(path)
          ? { data: new Blob([files.get(path)! as BlobPart]), error: null }
          : { data: null, error: { statusCode: "404", message: "Object not found" } };
      },
      upload: async (path: string, bytes: Uint8Array) => {
        writes++;
        files.set(path, bytes);
        return { error: null };
      },
    }),
  },
} as unknown as Parameters<typeof prepareChartBucket>[0];
async function profile(label: string, symbol: string, range: "120" | "all", kind: ChartKind) {
  const beforeReads = reads,
    beforeWrites = writes,
    beforeBytes = [...files.values()].reduce((n, value) => n + value.byteLength, 0);
  const start = performance.now();
  const result = await prepareChartBucket(client, "synthetic", identity, ctx, symbol, range, kind);
  console.log(
    JSON.stringify({
      label,
      symbol,
      range,
      kind,
      ms: Math.round((performance.now() - start) * 100) / 100,
      points: result.chart.length,
      storageReads: reads - beforeReads,
      storageWrites: writes - beforeWrites,
      singleResultGzipBytes: gzipSync(JSON.stringify(result)).byteLength,
      addedCacheBytes:
        [...files.values()].reduce((n, value) => n + value.byteLength, 0) - beforeBytes,
    }),
  );
}
// Compare unchanged stock and ETF paths using the same dataset and in-memory storage.
await profile("shared-stock-prices-recent-cold", stockSymbol, "120", "prices");
await profile("shared-stock-prices-recent-warm", stockSymbol, "120", "prices");
await profile("shared-stock-scored-recent-cold", stockSymbol, "120", "scored");
await profile("shared-stock-scored-recent-warm", stockSymbol, "120", "scored");
for (const [label, symbol] of [
  ["etf-regional", ETF_CHART_TEST_SYMBOL],
  ["etf-domestic-sector", domestic],
]) {
  await profile(`${label}-prices-recent-cold`, symbol!, "120", "etf-prices");
  await profile(`${label}-prices-recent-warm`, symbol!, "120", "etf-prices");
  await profile(`${label}-recent-cold`, symbol!, "120", "etf");
  await profile(`${label}-recent-warm`, symbol!, "120", "etf");
  await profile(`${label}-all-cold`, symbol!, "all", "etf");
  await profile(`${label}-all-warm`, symbol!, "all", "etf");
}
await profile("shared-stock-scored-all-cold", stockSymbol, "all", "scored");
await profile("shared-stock-scored-all-warm", stockSymbol, "all", "scored");
