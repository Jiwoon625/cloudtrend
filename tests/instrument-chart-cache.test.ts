import type { AnalysisPayload } from "../src/lib/market.functions";
import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  raw: vi.fn(),
  build: vi.fn(),
  sources: vi.fn(),
}));
vi.mock("@/lib/cloud", () => ({
  ownerPath: async (path: string) => `owner/${path}`,
  readBinaryObject: mocks.read,
  writeBinaryObject: mocks.write,
  readObject: vi.fn(),
  writeObject: vi.fn(),
}));
vi.mock("@/lib/manualDataStore", () => ({
  ensureManualDataText: mocks.raw,
  ensureManualDataset: vi.fn(),
  getManualDataMeta: () => null,
}));
vi.mock("@/lib/engine/instrumentChart", () => ({ buildCompactChart: mocks.build }));
vi.mock("@/lib/engine/instrumentDetailDataset", () => ({
  buildInstrumentDetailDataset: () => ({}),
}));
vi.mock("@/lib/scoringConfigStore", () => ({ getActiveScoringConfig: () => ({}) }));
vi.mock("@/lib/localAnalysis", () => ({ computeLocalAnalysis: vi.fn() }));
vi.mock("@/lib/engine/pipeline", () => ({ chartSeries: vi.fn(), scoreHistory: vi.fn() }));
vi.mock("@/lib/screeningHistory", () => ({
  buildSnapshot: vi.fn(),
  hydrateSnapshots: vi.fn(),
  saveSnapshot: vi.fn(),
}));
vi.mock("@/lib/sourceRegistry", () => ({ listRegisteredSources: mocks.sources }));
vi.mock("@/lib/screeningCacheContract", () => ({
  buildDashboardSummary: vi.fn(),
  DASHBOARD_CACHE_VERSION: "d",
  SCREENING_CACHE_VERSION: "s",
  INSTRUMENT_CACHE_VERSION: "i",
  deterministicAnalysis: (value: unknown) => value,
  stableCacheJson: JSON.stringify,
}));
const { getCachedInstrumentChart } = await import("../src/lib/screeningCache");
const payload = { analysis: { asOfDate: "2026-09-21", rows: [] } } as unknown as AnalysisPayload;
const data = { chart: [{ tradeDate: "2026-09-21" }], history: [] };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue(null);
  mocks.raw.mockResolvedValue("source csv");
  mocks.build.mockResolvedValue(data);
  mocks.sources.mockResolvedValue([]);
});
test("chart returns before a pending cache upload completes", async () => {
  mocks.write.mockImplementation(() => new Promise(() => {}));
  expect(await getCachedInstrumentChart("TEST", "120", payload)).toEqual(data);
  await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
  expect(mocks.read).toHaveBeenCalledWith("owner/cache/instruments/TEST.compact-120.json.gz");
});
test("valid compressed cache avoids source loading, range and input changes invalidate it", async () => {
  await getCachedInstrumentChart("TEST", "120", payload);
  await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
  mocks.read.mockResolvedValue(mocks.write.mock.calls[0]![1]);
  mocks.raw.mockClear();
  mocks.build.mockClear();
  expect(await getCachedInstrumentChart("TEST", "120", payload)).toEqual(data);
  expect(mocks.raw).not.toHaveBeenCalled();
  await getCachedInstrumentChart("TEST", "all", payload);
  expect(mocks.build).toHaveBeenCalledOnce();
  mocks.build.mockClear();
  mocks.sources.mockResolvedValue([{ id: "changed", data_hash: "new" }]);
  await getCachedInstrumentChart("TEST", "120", payload);
  expect(mocks.build).toHaveBeenCalledOnce();
});
test("upload failure does not reject a successfully computed chart", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.write.mockRejectedValue(new Error("offline"));
  expect(await getCachedInstrumentChart("TEST", "120", payload)).toEqual(data);
  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  warn.mockRestore();
});
