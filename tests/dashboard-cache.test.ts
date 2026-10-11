import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { environmentManager, focusManager, QueryClient, QueryObserver } from "@tanstack/query-core";
import { beforeEach, expect, test, vi } from "vitest";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import { runAnalysis } from "../src/lib/engine/pipeline";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import {
  buildDashboardSummary,
  deterministicAnalysis,
  SCREENING_CACHE_VERSION,
  stableCacheJson,
} from "../src/lib/screeningCacheContract";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  compute: vi.fn(),
  raw: vi.fn(),
  sources: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/lib/cloud", () => ({
  ownerPath: async (path: string) => `owner/${path}`,
  CLOUD_DATA_BUCKET: "cloudtrend-data",
  supabase: { storage: { from: () => ({ info: mocks.info }) } },
  readObject: mocks.read,
  writeObject: mocks.write,
  readBinaryObject: vi.fn(),
  writeBinaryObject: vi.fn(),
}));
vi.mock("@/lib/manualDataStore", () => ({
  ensureManualDataset: mocks.raw,
  getManualDataMeta: () => null,
}));
vi.mock("@/lib/localAnalysis", () => ({ computeLocalAnalysis: mocks.compute }));
vi.mock("@/lib/scoringConfigStore", () => ({
  getActiveScoringConfig: () => DEFAULT_SCORING_CONFIG,
}));
vi.mock("@/lib/sourceRegistry", () => ({ listRegisteredSources: mocks.sources }));
vi.mock("@/lib/screeningHistory", () => ({
  buildSnapshot: vi.fn(),
  hydrateSnapshots: vi.fn(),
  saveSnapshot: vi.fn(),
}));
import { readDashboardCache } from "../src/lib/screeningCache";
const hash = (value: unknown) => createHash("sha256").update(stableCacheJson(value)).digest("hex");
const analysis = runAnalysis(getMockDataset());
const inputFingerprint = hash({
  version: SCREENING_CACHE_VERSION,
  strategyConfig: DEFAULT_SCORING_CONFIG,
  sources: [],
  legacyFallback: { dataHash: null, schemaHash: null, savedAt: null, chars: null },
});
const screening = {
  version: SCREENING_CACHE_VERSION,
  createdAt: analysis.calculatedAt,
  inputFingerprint,
  resultDigest: hash(deterministicAnalysis(analysis)),
  payload: { analysis },
};
const expected = buildDashboardSummary(
  analysis,
  inputFingerprint,
  screening.resultDigest,
  screening.createdAt,
);

test("dashboard universe summary is stock-only and exposes skipped stock checks", () => {
  const stockRows = analysis.rows.filter((row) => row.instrument.instrumentType === "STOCK");
  expect(expected.counts.total).toBe(stockRows.length);
  expect(expected.counts.disqualified).toBe(
    stockRows.filter((row) => !row.hardFilterPassed).length,
  );

  const expectedFailures = new Map<string, number>();
  const expectedSkipped = new Map<string, number>();
  for (const row of stockRows) {
    if (!row.hardFilterPassed)
      for (const reason of row.failedRules)
        expectedFailures.set(reason, (expectedFailures.get(reason) ?? 0) + 1);
    for (const reason of row.skippedRules)
      expectedSkipped.set(reason, (expectedSkipped.get(reason) ?? 0) + 1);
  }
  expect(new Map(expected.failReasons)).toEqual(expectedFailures);
  expect(new Map(expected.skippedReasons)).toEqual(expectedSkipped);
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.write.mockResolvedValue(undefined);
  mocks.sources.mockResolvedValue([]);
});
function setup(summary: unknown, shared: unknown = screening) {
  mocks.read.mockImplementation(async (path: string) =>
    path.includes("/dashboard/") ? summary : shared,
  );
}
test.each([null, { ...expected, version: "old" }, { ...expected, inputFingerprint: "old" }])(
  "recovers unavailable summary from validated screening without recalculation: %j",
  async (summary) => {
    setup(summary);
    expect(await readDashboardCache()).toEqual(expected);
    expect(mocks.write).toHaveBeenCalledWith("owner/cache/dashboard/latest.json", expected);
    expect(mocks.compute).not.toHaveBeenCalled();
    expect(mocks.raw).not.toHaveBeenCalled();
  },
);
test("valid summary retains the small-cache fast path", async () => {
  setup(expected);
  expect(await readDashboardCache()).toEqual(expected);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.write).not.toHaveBeenCalled();
});
test.each([
  { ...screening, version: "old" },
  { ...screening, inputFingerprint: "old" },
  { ...screening, resultDigest: "corrupt" },
  null,
])("never recovers from invalid screening: %j", async (shared) => {
  setup(null, shared);
  expect(await readDashboardCache()).toBeNull();
  expect(mocks.write).not.toHaveBeenCalled();
});
test("a pending or failed repair upload does not prevent rendering", async () => {
  setup(null);
  mocks.write.mockImplementation(() => new Promise(() => {}));
  expect(await readDashboardCache()).toEqual(expected);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.write.mockRejectedValue(new Error("offline"));
  expect(await readDashboardCache()).toEqual(expected);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

import {
  dashboardCacheReadInterval,
  dashboardCacheReadQueryOptions,
  dashboardCacheEmptyPresentation,
  readDashboardSourceAvailability,
} from "../src/lib/dashboardCachePresentation";

test("null cache reads back off, with no polling for loading, errors or an available result", () => {
  const state = { data: null, status: "success", dataUpdateCount: 1 };
  expect(
    [1, 2, 3, 4, 100].map((dataUpdateCount) =>
      dashboardCacheReadInterval({ ...state, dataUpdateCount }),
    ),
  ).toEqual([15_000, 30_000, 60_000, 120_000, 120_000]);
  expect(dashboardCacheReadInterval({ ...state, data: {} })).toBe(false);
  expect(dashboardCacheReadInterval({ ...state, status: "error" })).toBe(false);
  expect(dashboardCacheReadInterval({ ...state, data: undefined, status: "pending" })).toBe(false);
});

test("actual read-only query polls only visible missing results, backs off and stops when recovered", async () => {
  vi.useFakeTimers();
  const server = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
  focusManager.setFocused(true);
  const client = new QueryClient();
  const options = dashboardCacheReadQueryOptions(["dashboard-readonly-test"]);
  let unsubscribe = () => {};
  try {
    setup(null, null);
    expect(options.queryFn).toBe(readDashboardCache);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(await client.fetchQuery(options)).toBeNull();
    const observer = new QueryObserver(client, options);
    unsubscribe = observer.subscribe(() => {});
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.read).toHaveBeenCalledTimes(4);
    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(mocks.read).toHaveBeenCalledTimes(4);
    setup(expected);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await client.getQueryCache().find({ queryKey: options.queryKey })!.promise;
    expect(observer.getCurrentResult().data).toEqual(expected);
    const reads = mocks.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mocks.read).toHaveBeenCalledTimes(reads);
    expect(mocks.compute).not.toHaveBeenCalled();
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    client.clear();
    focusManager.setFocused(undefined);
    environmentManager.setIsServer(() => server);
    vi.useRealTimers();
  }
});

test("concurrent read-only observers share one pending read without calculations", async () => {
  const client = new QueryClient();
  const options = dashboardCacheReadQueryOptions(["dashboard-coalesced-test"]);
  let release!: (value: unknown) => void;
  mocks.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const a = new QueryObserver(client, options);
  const b = new QueryObserver(client, options);
  const offA = a.subscribe(() => {});
  const offB = b.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    const first = client.fetchQuery(options);
    const second = client.fetchQuery(options);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    release(expected);
    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.compute).not.toHaveBeenCalled();
    expect(mocks.raw).not.toHaveBeenCalled();
  } finally {
    offA();
    offB();
    client.clear();
  }
});

test("a failed read remains an error and never becomes an empty/no-source result", async () => {
  const client = new QueryClient();
  try {
    mocks.read.mockRejectedValue(new Error("network unavailable"));
    const options = dashboardCacheReadQueryOptions(["dashboard-error-test"]);
    await expect(client.fetchQuery(options)).rejects.toThrow("network unavailable");
    const state = client.getQueryState(options.queryKey)!;
    expect(state.status).toBe("error");
    expect(dashboardCacheReadInterval(state)).toBe(false);
    expect(mocks.compute).not.toHaveBeenCalled();
    expect(mocks.raw).not.toHaveBeenCalled();
  } finally {
    client.clear();
  }
});

test("metadata-only lookup distinguishes registered, legacy and absent sources", async () => {
  mocks.sources.mockResolvedValueOnce([{ id: "synthetic-source" }]);
  expect(await readDashboardSourceAvailability()).toBe("REGISTERED");
  expect(mocks.info).not.toHaveBeenCalled();
  mocks.info.mockResolvedValueOnce({ data: { size: 100 }, error: null });
  expect(await readDashboardSourceAvailability()).toBe("LEGACY");
  expect(mocks.info).toHaveBeenCalledWith("owner/kr.json");
  mocks.info.mockResolvedValueOnce({ data: null, error: { statusCode: "404" } });
  expect(await readDashboardSourceAvailability()).toBe("NONE");
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.raw).not.toHaveBeenCalled();
  expect(mocks.compute).not.toHaveBeenCalled();
});

test.each([401, 403, 500])(
  "metadata error %s is not presented as no source",
  async (statusCode) => {
    const error = { statusCode: String(statusCode), message: "metadata lookup failed" };
    mocks.info.mockResolvedValue({ data: null, error });
    await expect(readDashboardSourceAvailability()).rejects.toEqual(error);
  },
);

test("route wires the read-only query and distinguishes source absence from a cache miss", () => {
  const route = readFileSync("src/routes/index.tsx", "utf8");
  expect(route).toMatch(
    /dashboardCacheReadQueryOptions\(\s*dashboardQueryOptions.queryKey,\s*sourceAvailability.isError/,
  );
  expect(route).toContain(
    "requested ? getOrBuildDashboardSummaryServerFirst : readOnlyOptions.queryFn",
  );
  expect(route).toContain("refetchInterval: requested ? false : readOnlyOptions.refetchInterval");
  expect(route).toContain(
    'enabled: cachedSummary?.status === "success" && cachedSummary.data === null',
  );
  expect(route).toContain("sourceAvailability.isError");
  expect(route).not.toContain("아직 스크리닝을 시작하지");
  expect(dashboardCacheEmptyPresentation("NONE").title).toContain("원자료가 없습니다");
  for (const source of ["REGISTERED", "LEGACY"] as const) {
    expect(dashboardCacheEmptyPresentation(source).title).toContain("저장 결과가 없습니다");
    expect(dashboardCacheEmptyPresentation(source).title).not.toContain("원자료가 없습니다");
  }
});

test("source metadata failure disables the live read-only polling observer", async () => {
  vi.useFakeTimers();
  const server = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
  focusManager.setFocused(true);
  const client = new QueryClient();
  let unsubscribe = () => {};
  try {
    setup(null, null);
    const key = ["dashboard-metadata-failed-test"];
    const options = dashboardCacheReadQueryOptions(key);
    await client.fetchQuery(options);
    const observer = new QueryObserver(client, options);
    unsubscribe = observer.subscribe(() => {});
    observer.setOptions(dashboardCacheReadQueryOptions(key, true));
    const reads = mocks.read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mocks.read).toHaveBeenCalledTimes(reads);
  } finally {
    unsubscribe();
    client.clear();
    focusManager.setFocused(undefined);
    environmentManager.setIsServer(() => server);
    vi.useRealTimers();
  }
});
