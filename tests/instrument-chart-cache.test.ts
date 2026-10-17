import type { AnalysisPayload } from "../src/lib/marketPayload";
import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  raw: vi.fn(),
  server: vi.fn(),
  sources: vi.fn(),
  owner: vi.fn(),
  proxyLoaded: vi.fn(),
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
vi.mock("@/lib/sourceRegistry", () => ({
  listRegisteredSources: mocks.sources,
  listActiveScreeningSourceFingerprints: mocks.sources,
}));
vi.mock("@/lib/localAnalysis", () => ({ computeLocalAnalysis: vi.fn() }));
vi.mock("@/lib/screeningHistory", () => ({
  buildSnapshot: vi.fn(),
  hydrateSnapshots: vi.fn(),
  saveSnapshot: vi.fn(),
}));
vi.mock("@/lib/instrumentCharts.functions", () => {
  mocks.proxyLoaded();
  return { getInstrumentChartServer: mocks.server };
});
const { getCachedInstrumentChart, getCachedInstrumentPrices } =
  await import("../src/lib/screeningCache");
const proxyLoadedWithCacheModule = mocks.proxyLoaded.mock.calls.length;
const callsBeforeChartRequest = mocks.server.mock.calls.length;
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

test("the same payload rechecks active sources on later calls but coalesces simultaneous phases", async () => {
  const input = payload();
  mocks.read.mockResolvedValue(await compressed({ TEST: scored }));
  await Promise.all([
    getCachedInstrumentChart("TEST", "120", input),
    getCachedInstrumentPrices("TEST", "120", input),
  ]);
  expect(mocks.sources).toHaveBeenCalledOnce();
  const firstPath = mocks.read.mock.calls[0]![0];
  mocks.sources.mockResolvedValue([{ id: "new", data_hash: "new" }]);
  await getCachedInstrumentChart("TEST", "120", input);
  expect(mocks.sources).toHaveBeenCalledTimes(2);
  expect(mocks.read.mock.calls.at(-1)![0]).not.toBe(firstPath);
});

test("owner changes during a chart read fail closed; later owners receive their own path", async () => {
  const input = payload();
  mocks.read.mockImplementationOnce(async () => {
    mocks.owner.mockResolvedValue("different-owner");
    return compressed({ TEST: scored });
  });
  await expect(getCachedInstrumentChart("TEST", "120", input)).rejects.toThrow("계정이 변경");
  await getCachedInstrumentChart("TEST", "120", input);
  expect(mocks.read.mock.calls.at(-1)![0]).toMatch(/^different-owner\//);
});

test("settings changes during a read cannot label old points with a new configuration", async () => {
  mocks.read.mockImplementationOnce(async () => {
    mocks.config.value = { changed: true };
    return compressed({ TEST: scored });
  });
  await expect(getCachedInstrumentChart("TEST", "120", payload())).rejects.toThrow(
    "점수 설정이 변경",
  );
  expect(mocks.server).not.toHaveBeenCalled();
});

test("the RPC proxy is ready before opt-in without fetching or computing a chart", () => {
  expect(proxyLoadedWithCacheModule).toBe(1);
  expect(callsBeforeChartRequest).toBe(0);
});

test("a full-history cache miss uses the resident proxy after old release chunks disappear", async () => {
  const lateImport = vi.fn(() => {
    throw new TypeError(
      "Failed to fetch dynamically imported module: https://example.test/assets/old-release/instrumentCharts.functions-old.js",
    );
  });
  // Simulate a deployment retiring the old lazy-import target after opening the page.
  // Static imports keep their loaded binding; a later dynamic import would fail.
  vi.doMock("@/lib/instrumentCharts.functions", lateImport);
  try {
    expect(await getCachedInstrumentPrices("TEST", "all", payload())).toEqual(scored);
    expect(await getCachedInstrumentChart("TEST", "all", payload())).toEqual(scored);
    expect(lateImport).not.toHaveBeenCalled();
    expect(
      mocks.server.mock.calls.map(([request]) => [request.data.range, request.data.kind]),
    ).toEqual([
      ["all", "prices"],
      ["all", "scored"],
    ]);
    expect(mocks.raw).not.toHaveBeenCalled();
  } finally {
    vi.doMock("@/lib/instrumentCharts.functions", () => ({
      getInstrumentChartServer: mocks.server,
    }));
  }
});

test.each([
  new Error("스크리닝 결과 조회 실패: private chart API unavailable"),
  new TypeError("Failed to fetch"),
])(
  "real API and offline failures remain errors with one attempt and explicit retry: %s",
  async (error) => {
    mocks.server.mockRejectedValueOnce(error);
    await expect(getCachedInstrumentPrices("TEST", "all", payload())).rejects.toBe(error);
    expect(mocks.server).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.raw).not.toHaveBeenCalled();
    // Only a new user retry invokes the RPC again, with the same requested range.
    expect(await getCachedInstrumentPrices("TEST", "all", payload())).toEqual(scored);
    expect(mocks.server).toHaveBeenCalledTimes(2);
    expect(mocks.server.mock.calls.every(([request]) => request.data.range === "all")).toBe(true);
  },
);

function etfPayload() {
  return {
    analysis: {
      asOfDate: "2026-10-13",
      calculatedAt: "2026-10-13T09:00:00Z",
      rows: [
        {
          instrument: { symbol: "360750", instrumentType: "ETF" },
          snapshot: { tradeDate: "2026-10-13", close: 100 },
          etfStrategy: {
            version: "etf-v02-confirm1-liquidity-no-replacement",
            date: "2026-10-13",
            previousDate: "2026-10-12",
            dataStatus: "krx_batch_pending",
            score: null,
            previousScore: 88,
            technical: 90,
            priority: 0,
            health: null,
            environment: 80,
            environmentSource: "own_index_lag1",
            region: "US",
            issues: [],
          },
        },
      ],
    },
  } as unknown as AnalysisPayload;
}
function etfBundle() {
  return {
    symbol: "360750",
    asOfDate: "2026-10-13",
    version: "etf-v02-confirm1-liquidity-no-replacement",
    chart: [
      { tradeDate: "2026-10-12", close: 99, volume: 10, m0Score: 88 },
      { tradeDate: "2026-10-13", close: 100, volume: 11, m0Score: null },
    ],
    underlying: [{ tradeDate: "2026-10-12", close: 1000, ma60: 950 }],
    underlyingName: "S&P 500",
    underlyingAsOfDate: "2026-10-12",
    previousM0: { date: "2026-10-12", score: 88 },
    previousTradingDate: "2026-10-12",
    issues: [],
  };
}
test("ETF uses resident RPC and shared identity lookup; cold open only requests recent price and M0 bundles", async () => {
  const { getCachedEtfInstrumentChart, getCachedEtfInstrumentPrices } =
    await import("../src/lib/screeningCache");
  const input = etfPayload();
  mocks.server.mockImplementation(async ({ data }) =>
    data.kind === "etf"
      ? etfBundle()
      : {
          chart: [{ tradeDate: "2026-10-13", close: 100, volume: 11 }],
          history: [],
        },
  );
  const [bundle] = await Promise.all([
    getCachedEtfInstrumentChart("360750", "120", input),
    getCachedEtfInstrumentPrices("360750", "120", input),
  ]);
  expect(bundle.previousM0).toEqual({ date: "2026-10-12", score: 88 });
  expect(bundle.chart.at(-1)?.m0Score).toBeNull();
  expect(mocks.sources).toHaveBeenCalledOnce();
  expect(mocks.server).toHaveBeenCalledTimes(2);
  expect(mocks.server.mock.calls.every(([request]) => request.data.range === "120")).toBe(true);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(mocks.raw).not.toHaveBeenCalled();
});
test("warm ETF reads require no RPC, isolate technical caches, and load full history only when requested", async () => {
  const { getCachedEtfInstrumentChart } = await import("../src/lib/screeningCache");
  const input = etfPayload();
  mocks.read.mockResolvedValue(await compressed({ "360750": etfBundle() }));
  expect(await getCachedEtfInstrumentChart("360750", "120", input)).toEqual(etfBundle());
  const recentPath = mocks.read.mock.calls[0]![0];
  expect(recentPath).toContain("etf-chart-v3-operational-underlying");
  expect(recentPath).not.toContain("-all-");
  expect(mocks.server).not.toHaveBeenCalled();
  await getCachedEtfInstrumentChart("360750", "all", input);
  expect(mocks.read.mock.calls.at(-1)![0]).toContain("360750-all-etf");
  expect(mocks.read.mock.calls.at(-1)![0]).not.toBe(recentPath);
  expect(mocks.raw).not.toHaveBeenCalled();
});
test.each([
  { symbol: "481180" },
  { asOfDate: "2026-10-12" },
  { version: "old-strategy" },
  { chart: [{ tradeDate: "2026-10-13", close: 100, volume: 11, m0Score: 88 }] },
  { chart: [{ tradeDate: "2026-10-14", close: 100, volume: 11, m0Score: 88 }] },
  { previousM0: { date: "2026-10-09", score: 88 } },
])(
  "ETF caches reject wrong symbol/date/version, future values and stale prior-score labels: %o",
  async (change) => {
    const { getCachedEtfInstrumentChart } = await import("../src/lib/screeningCache");
    mocks.read.mockResolvedValue(await compressed({ "360750": { ...etfBundle(), ...change } }));
    await expect(getCachedEtfInstrumentChart("360750", "120", etfPayload())).rejects.toThrow();
  },
);
