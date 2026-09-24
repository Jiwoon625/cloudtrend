import type { AnalysisPayload } from "../src/lib/market.functions";
import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  raw: vi.fn(),
  server: vi.fn(),
  sources: vi.fn(),
  owner: vi.fn(),
  config: { value: {} },
}));
vi.mock("@/lib/cloud", () => ({
  ownerPath: async (p: string) => `owner/${p}`,
  userId: mocks.owner,
  readBinaryObject: mocks.read,
  writeBinaryObject: vi.fn(),
  readObject: vi.fn(),
  writeObject: vi.fn(),
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test-session-token-long-enough" } },
      }),
    },
  },
}));
vi.mock("@/lib/manualDataStore", () => ({
  ensureManualDataset: mocks.raw,
  getManualDataMeta: () => null,
}));
vi.mock("@/lib/scoringConfigStore", () => ({ getActiveScoringConfig: () => mocks.config.value }));
vi.mock("@/lib/sourceRegistry", () => ({ listRegisteredSources: mocks.sources }));
vi.mock("@/lib/localAnalysis", () => ({ computeLocalAnalysis: vi.fn() }));
vi.mock("@/lib/screeningHistory", () => ({
  buildSnapshot: vi.fn(),
  hydrateSnapshots: vi.fn(),
  saveSnapshot: vi.fn(),
}));
vi.mock("@/lib/instrumentCharts.functions", () => ({ getInstrumentChartServer: mocks.server }));
const { getCachedInstrumentChart, getCachedInstrumentPrices } =
  await import("../src/lib/screeningCache");
function payload(time = "2026-09-24T00:36:00Z") {
  return {
    analysis: {
      asOfDate: "2026-09-23",
      calculatedAt: time,
      rows: [{ instrument: { symbol: "TEST", instrumentType: "STOCK" }, operatingScore10: 8 }],
    },
  } as unknown as AnalysisPayload;
}
const scored = {
  chart: [
    {
      tradeDate: "2026-09-23",
      close: 100,
      volume: 10,
      historicalTechnicalPoints: 8,
      historicalTechnical: {
        points: 8,
        rawPoints: 8,
        rawMaxPoints: 10,
        availableMaxPoints: 10,
        missingRules: [],
      },
    },
  ],
  history: [],
};
async function compressed(value: unknown) {
  const stream = new Blob([JSON.stringify(value)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.owner.mockResolvedValue("owner");
  mocks.sources.mockResolvedValue([]);
  mocks.read.mockResolvedValue(null);
  mocks.server.mockResolvedValue(scored);
  mocks.config.value = {};
});
test("a cache miss uses authenticated server computation and never browser source loading", async () => {
  expect(await getCachedInstrumentChart("TEST", "120", payload())).toEqual(scored);
  expect(mocks.server).toHaveBeenCalledOnce();
  expect(mocks.raw).not.toHaveBeenCalled();
  expect(mocks.server.mock.calls[0]![0].data.range).toBe("120");
});
test("same inputs across rescreenings reuse a cache; source/config/range revisions separate paths", async () => {
  mocks.read.mockResolvedValue(await compressed({ TEST: scored }));
  await getCachedInstrumentChart("TEST", "120", payload());
  const path = mocks.read.mock.calls.at(-1)![0];
  await getCachedInstrumentChart("TEST", "120", payload("2026-09-24T01:36:00Z"));
  expect(mocks.read.mock.calls.at(-1)![0]).toBe(path);
  expect(mocks.server).not.toHaveBeenCalled();
  mocks.config.value = { changed: true };
  await getCachedInstrumentChart("TEST", "120", payload());
  expect(mocks.read.mock.calls.at(-1)![0]).not.toBe(path);
  mocks.config.value = {};
  await getCachedInstrumentChart("TEST", "all", payload());
  expect(mocks.read.mock.calls.at(-1)![0]).not.toBe(path);
  mocks.sources.mockResolvedValue([{ id: "new", data_hash: "new" }]);
  await getCachedInstrumentChart("TEST", "120", payload());
  expect(mocks.read.mock.calls.at(-1)![0]).not.toBe(path);
});
test("prices return without a technical score; mismatched score cache is refused", async () => {
  const prices = { chart: [{ tradeDate: "2026-09-23", close: 100, volume: 10 }], history: [] };
  mocks.read.mockResolvedValue(await compressed({ TEST: prices }));
  expect(await getCachedInstrumentPrices("TEST", "120", payload())).toEqual(prices);
  mocks.read.mockResolvedValue(
    await compressed({
      TEST: { ...scored, chart: [{ ...scored.chart[0], historicalTechnicalPoints: 7.5 }] },
    }),
  );
  await expect(getCachedInstrumentChart("TEST", "120", payload())).rejects.toThrow("카드와 차트");
  expect(mocks.raw).not.toHaveBeenCalled();
});
