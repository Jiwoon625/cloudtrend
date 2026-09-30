import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { getMockDataset } from "../src/lib/engine/mockProvider";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  parse: vi.fn(),
  cache: vi.fn(),
  prices: vi.fn(),
  warm: vi.fn(),
  trusted: vi.fn(),
  reused: vi.fn(),
}));
vi.mock("../scripts/source-registry-store", () => ({ loadAnalysisSourceInputs: mocks.load }));
vi.mock("../src/lib/engine/manualDataset", () => ({ parseManualMarketData: mocks.parse }));
vi.mock("../scripts/web-screening-cache-store", () => ({ persistWebScreeningCaches: mocks.cache }));
vi.mock("../src/lib/instrumentChartStore.server", () => ({
  publishRecentPrices: mocks.prices,
  warmRecentCharts: mocks.warm,
}));
vi.mock("../scripts/analysis-run-store", async (original) => ({
  ...(await original<any>()),
  trustedSupabaseClient: mocks.trusted,
  codeVersion: () => "code",
  findReusableRun: mocks.reused,
}));
import { runScreening } from "../scripts/run-screening";
let dir: string;
let inputs: any[];
let uploaded: Map<string, string>;
let upserts: Array<{ table: string; record: any; options: any }>;
beforeEach(async () => {
  vi.resetAllMocks();
  dir = await mkdtemp(path.join(tmpdir(), "screening-cli-"));
  uploaded = new Map();
  upserts = [];
  const storage = {
    upload: async (key: string, body: any) => {
      let text = "";
      if (typeof body === "string") text = body;
      else for await (const chunk of body) text += chunk.toString();
      uploaded.set(key, text);
      return { error: null };
    },
  };
  mocks.trusted.mockReturnValue({
    storage: { from: () => storage },
    from: (table: string) => {
      const query: any = {
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: async (record: any, options: any) => {
          upserts.push({ table, record, options });
          return { error: null };
        },
      };
      for (const method of ["select", "eq", "lt", "order", "limit"]) query[method] = () => query;
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
      validation: { canonicalCsv: "source", rows: [{ test: true }] },
    },
  ];
  mocks.load.mockResolvedValue(inputs);
  mocks.parse.mockReturnValue({ dataset: getMockDataset(), stats: { rows: 1 } });
  mocks.cache.mockResolvedValue({
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
for (const phase of ["prices", "warm"] as const) {
  test(`${phase} failure is isolated after history/cache/run publication; bundle contract and source release remain intact`, async () => {
    mocks[phase].mockRejectedValue(new Error("chart failure"));
    await expect(runScreening(args())).resolves.toBeUndefined();
    expect(mocks.load).toHaveBeenCalledWith(expect.anything(), expect.any(String), "screening", {
      compact: true,
    });
    const history = upserts.find((v) => v.table === "screening_history")!;
    expect(history.options).toEqual({ onConflict: "user_id,date" });
    expect(history.record.snapshot.date).toBe(history.record.date);
    const run = upserts.find((v) => v.table === "analysis_runs")!.record;
    expect(run.status).toBe("COMPLETED");
    expect(mocks.cache).toHaveBeenCalledTimes(1);
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
