import { createImmutableArchiveFixture } from "./immutable-archive-fixture";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import { largeScreeningSnapshot } from "./screening-snapshot-storage-fixture";
import { serializeScreeningSnapshot } from "../src/lib/screeningSnapshotStorage";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  parse: vi.fn(),
  cache: vi.fn(),
  prices: vi.fn(),
  warm: vi.fn(),
  trusted: vi.fn(),
  reused: vi.fn(),
  portfolioRefresh: vi.fn(),
  complete: vi.fn(),
  shadow: vi.fn(),
}));
vi.mock("../src/lib/shadowReplay.server", () => ({ replayKrShadow: mocks.shadow }));
vi.mock("../src/lib/screeningPublication.server", () => ({
  completeScreeningPublication: mocks.complete,
}));
vi.mock("../src/lib/portfolioLedgers.server", () => ({
  refreshPortfolioAfterScreening: mocks.portfolioRefresh,
}));
vi.mock("../scripts/source-registry-store", () => ({ loadAnalysisSourceInputs: mocks.load }));
vi.mock("../src/lib/engine/manualDataset", () => ({ parseManualMarketData: mocks.parse }));
vi.mock("../scripts/web-screening-cache-store", () => ({ persistWebScreeningCaches: mocks.cache }));
vi.mock("../src/lib/instrumentChartStore.server", () => ({
  publishRecentPrices: mocks.prices,
  warmRecentCharts: mocks.warm,
}));
vi.mock("../scripts/analysis-run-store", async (original) => ({
  ...(await original<typeof import("../scripts/analysis-run-store")>()),
  trustedSupabaseClient: mocks.trusted,
  codeVersion: () => "code",
  findReusableRun: mocks.reused,
}));
import { runScreening } from "../scripts/run-screening";
let dir: string;
let inputs: Array<{
  text: string;
  validation: { canonicalCsv: string; rows: unknown[]; stats: { maxDate: string } };
  [key: string]: unknown;
}>;
let uploaded: Map<string, string>;
let upserts: Array<{ table: string; record: unknown; options: unknown }>;
let previousStored: unknown = null;
interface MockQuery {
  maybeSingle(): Promise<{ data: { snapshot: unknown } | null; error: null }>;
  upsert(record: unknown, options: unknown): Promise<{ error: null }>;
  select(): MockQuery;
  eq(): MockQuery;
  lt(): MockQuery;
  order(): MockQuery;
  limit(): MockQuery;
}
beforeEach(async () => {
  vi.resetAllMocks();
  dir = await mkdtemp(path.join(tmpdir(), "screening-cli-"));
  uploaded = new Map();
  upserts = [];
  previousStored = null;
  const storage = {
    upload: async (key: string, body: string | AsyncIterable<{ toString(): string }>) => {
      let text = "";
      if (typeof body === "string") text = body;
      else for await (const chunk of body) text += chunk.toString();
      uploaded.set(key, text);
      return { error: null };
    },
  };
  const archive = createImmutableArchiveFixture();
  mocks.trusted.mockReturnValue({
    storage: { from: () => storage },
    from: (table: string) => {
      if (table === "screening_run_archive") return archive();
      let previousQuery = false;
      const query: MockQuery = {
        maybeSingle: async () => ({
          data:
            table === "screening_history" && previousQuery && previousStored
              ? { snapshot: previousStored }
              : null,
          error: null,
        }),
        upsert: async (record: unknown, options: unknown) => {
          upserts.push({ table, record, options });
          return { error: null };
        },
        select: () => query,
        eq: () => query,
        lt: () => {
          previousQuery = true;
          return query;
        },
        order: () => query,
        limit: () => query,
      };
      return query;
    },
  });
  inputs = [
    {
      id: "legacy:kr",
      text: "source",
      fileName: "source.csv",
      savedAt: "2026-09-30T00:00:00Z",
      bytes: 6,
      fileHash: "file",
      dataHash: "data",
      schemaHash: "schema",
      sourceRecord: null,
      validation: {
        canonicalCsv: "source",
        rows: [{ test: true }],
        stats: { maxDate: getMockDataset().asOfDate },
      },
    },
  ];
  mocks.shadow.mockResolvedValue({ deferred: null });
  mocks.portfolioRefresh.mockResolvedValue({
    status: "REUSED",
    asOfDate: "2026-09-30",
    calculatedAt: "2026-09-30T00:00:00Z",
  });
  mocks.load.mockResolvedValue(inputs);
  mocks.parse.mockReturnValue({ dataset: getMockDataset(), stats: { rows: 1 } });
  mocks.cache.mockResolvedValue({
    publicationId: "synthetic-publication",
    inputFingerprint: "fingerprint",
    resultDigest: "digest",
    roundTripVerified: true,
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true });
});
const args = () => [
  "--supabase-user-id",
  "11111111-1111-1111-1111-111111111111",
  "--output",
  dir,
  "--upload",
  "--force",
];
test("CLI restores compact previous history before summary and cache publication", async () => {
  const previous = largeScreeningSnapshot();
  previous.date = previous.asOfDate = getMockDataset().tradeDates.at(-2)!;
  previousStored = JSON.parse(JSON.stringify(serializeScreeningSnapshot(previous)));
  await runScreening(args());
  expect(mocks.cache.mock.calls[0]![0].previous).toEqual(previous);
  expect(mocks.cache.mock.calls[0]![0].previous.entries).toHaveLength(1785);
});
for (const phase of ["prices", "warm"] as const) {
  test(`${phase} failure is isolated after history/cache/run publication; bundle contract and source release remain intact`, async () => {
    mocks[phase].mockRejectedValue(new Error("chart failure"));
    await expect(runScreening(args())).resolves.toBeUndefined();
    expect(mocks.load).toHaveBeenCalledWith(expect.anything(), expect.any(String), "screening", {
      compact: true,
    });
    const history = upserts.find((v) => v.table === "screening_history")! as {
      options: unknown;
      record: { snapshot: { date: string }; date: string };
    };
    expect(history.options).toEqual({ onConflict: "user_id,date" });
    expect(history.record.snapshot.date).toBe(history.record.date);
    const run = upserts.find((v) => v.table === "analysis_runs")!
      .record as import("../src/lib/analysisRunBundle").AnalysisRunSummaryRecord;
    expect(run.status).toBe("COMPLETED");
    expect(mocks.cache).toHaveBeenCalledTimes(1);
    expect(mocks.portfolioRefresh).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "11111111-1111-1111-1111-111111111111",
    );
    expect(mocks.shadow.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.portfolioRefresh.mock.invocationCallOrder[0]!,
    );
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.complete.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.portfolioRefresh.mock.invocationCallOrder[0]!,
    );
    const bundle = JSON.parse(uploaded.get(run.result_path)!);
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.summary).toEqual(run.summary);
    expect(bundle.result.rows.length).toBe(run.summary.counts.total);
    expect(bundle.data.sources[0].bytes).toBe(6);
    expect(Object.keys(bundle)).toEqual([
      "schemaVersion",
      "run",
      "data",
      "config",
      "summary",
      "result",
    ]);
    const latest = JSON.parse(
      uploaded.get("11111111-1111-1111-1111-111111111111/results/screening/latest.json")!,
    );
    expect(latest.resultPath).toBe(run.result_path);
    expect(latest.summary).toEqual(bundle.summary);
    expect(inputs[0].text).toBe("");
    expect(inputs[0].validation.rows).toEqual([]);
    expect(inputs[0].validation.canonicalCsv).toBe("");
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("스크리닝 결과는 저장됨"),
    );
  });
}
test("cache publish failure is fatal and prevents a completed run and chart warming", async () => {
  mocks.cache.mockRejectedValue(new Error("cache failed"));
  await expect(runScreening(args())).rejects.toThrow("cache failed");
  expect(upserts.some((v) => v.table === "analysis_runs")).toBe(false);
  expect(mocks.prices).not.toHaveBeenCalled();
});
test("completed identical run is reused without analysis, publishing or warming", async () => {
  mocks.reused.mockResolvedValue({ id: "existing" });
  await runScreening(args().filter((v) => v !== "--force"));
  expect(mocks.parse).not.toHaveBeenCalled();
  expect(mocks.cache).not.toHaveBeenCalled();
  expect(mocks.prices).not.toHaveBeenCalled();
  expect(upserts).toEqual([]);
});

test("a legacy completed run with no as_of_date reuses a verified pre-start source date without model reads", async () => {
  mocks.reused.mockResolvedValue({ id: "old-existing", as_of_date: null });
  await runScreening(args().filter((value) => value !== "--force"));
  expect(mocks.parse).not.toHaveBeenCalled();
  expect(upserts).toEqual([]);
});

test("an ACTUAL-book refresh failure does not block MODEL replay or expose private error details", async () => {
  mocks.portfolioRefresh.mockRejectedValue(new Error("private account journal integrity"));
  await expect(runScreening(args())).resolves.toBeUndefined();
  expect(mocks.shadow).toHaveBeenCalledTimes(1);
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(upserts.some((value) => value.table === "analysis_runs")).toBe(true);
  const logs = vi
    .mocked(process.stdout.write)
    .mock.calls.map((call) => String(call[0]))
    .join("\n");
  expect(logs).toContain('"status":"FAILED"');
  expect(logs).not.toContain("private account");
});
