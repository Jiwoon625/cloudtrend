import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({
  load: vi.fn(),
  replay: vi.fn(),
  buildLegacy: vi.fn(),
  trusted: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock("../scripts/source-registry-store", () => ({ loadAnalysisSourceInputs: capture.load }));
vi.mock("../src/lib/engine/manualDataset", () => ({
  parseManualMarketData: () => ({ dataset: { asOfDate: "2026-10-06" }, stats: {} }),
}));
vi.mock("../src/lib/engine/fullMarketAnalysis", () => ({
  runFullMarketAnalysis: () => ({
    dataset: { asOfDate: "2026-10-06" },
    analysis: {
      asOfDate: "2026-10-06",
      calculatedAt: "2026-10-07T00:00:00Z",
      rows: [],
      marketGate: { status: "NEUTRAL" },
    },
  }),
}));
vi.mock("../src/lib/onsetProfile", () => ({ withOnsetProfiles: (analysis: unknown) => analysis }));
vi.mock("../src/lib/analysisRunBundle", () => ({ buildScreeningSummary: () => ({}) }));
vi.mock("../src/lib/shadowReplay.server", async (original) => ({
  ...(await original<typeof import("../src/lib/shadowReplay.server")>()),
  replayKrShadow: capture.replay,
}));
vi.mock("../src/lib/engine/kospiShadowDataset", () => ({
  buildKospiShadowSession: capture.buildLegacy,
}));
vi.mock("../scripts/web-screening-cache-store", () => ({
  persistWebScreeningCaches: async () => null,
}));
vi.mock("../scripts/screening-json-file", () => ({
  writeScreeningJson: async () => {},
  uploadScreeningJsonFile: async () => {},
}));
vi.mock("../scripts/analysis-run-store", async (original) => ({
  ...(await original<typeof import("../scripts/analysis-run-store")>()),
  trustedSupabaseClient: capture.trusted,
  codeVersion: () => "test",
  saveRunRecord: async () => {},
  uploadJson: async () => {},
}));

import { runScreening } from "../scripts/run-screening";
import { runKospiShadow } from "../scripts/run-kospi-shadow";
import { sourceCaptureForDate } from "../src/lib/shadowReplay.server";

const origin = {
  id: "original",
  min_date: "2026-10-01",
  max_date: "2026-10-06",
  activated_at: "2026-10-06T23:00:00Z",
  created_at: "2026-10-06T22:59:00Z",
};
let directory: string;
let inputs: ReturnType<typeof input>[];
let argv: string[];
function input() {
  return {
    id: "compacted",
    fileName: "compacted.csv",
    bytes: 1,
    text: "source",
    fileHash: "file",
    dataHash: "data",
    schemaHash: "schema",
    savedAt: "2026-10-20T23:00:00Z",
    sourceRecord: {
      ...origin,
      id: "compacted",
      max_date: "2026-10-07",
      activated_at: "2026-10-20T23:00:00Z",
      created_at: "2026-10-20T22:59:00Z",
      storage_path: "user/compacted.csv",
      validation_result: { screeningCompaction: { original_source_evidence: [origin] } },
    },
    validation: {
      stats: { minDate: "2026-10-01", maxDate: "2026-10-07" },
      canonicalCsv: "source",
      rows: [],
    },
  };
}
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), "compaction-timing-cli-"));
  argv = process.argv;
  inputs = [input()];
  capture.load.mockResolvedValue(inputs);
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    lt: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    maybeSingle: async () => ({ data: null, error: null }),
    upsert: capture.upsert,
  };
  for (const method of [query.select, query.eq, query.lt, query.order, query.limit])
    method.mockReturnValue(query);
  capture.upsert.mockResolvedValue({ error: null });
  capture.trusted.mockReturnValue({ from: () => query });
  capture.replay.mockResolvedValue({ processed: [], deferred: null });
  capture.buildLegacy.mockReturnValue({
    date: "2026-10-06",
    rows: [],
    gate: { status: "NEUTRAL" },
    sourceHash: "hash",
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  process.argv = argv;
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it("passes the original receipt to replay and preserves snapshot registration in the screening CLI", async () => {
  await runScreening([
    "--supabase-user-id",
    "11111111-1111-4111-8111-111111111111",
    "--output",
    directory,
    "--upload",
    "--force",
  ]);
  const replay = capture.replay.mock.calls[0]![0];
  expect(replay.sources[0].validation_result).toEqual(inputs[0]!.sourceRecord.validation_result);
  expect(sourceCaptureForDate(replay.sources, "2026-10-06")).toBe(origin.activated_at);
  expect(capture.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      snapshot: expect.objectContaining({ sourceRegisteredAt: origin.activated_at }),
    }),
    expect.anything(),
  );
});

it("legacy Shadow matches original max-date evidence even when the compacted physical range is newer", async () => {
  process.argv = [
    "node",
    "run-kospi-shadow",
    "--dry-run",
    "--user",
    "user",
    "--as-of",
    "2026-10-06",
  ];
  await runKospiShadow();
  expect(capture.buildLegacy).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ sourceCollectedAt: origin.activated_at }),
    "2026-10-06",
  );
});

it("legacy Shadow still lets a new raw source for that close dominate", async () => {
  const appended = input();
  appended.sourceRecord = {
    ...appended.sourceRecord,
    ...origin,
    id: "appended",
    activated_at: "2026-10-21T23:00:00Z",
    validation_result: {} as typeof appended.sourceRecord.validation_result,
  };
  inputs.push(appended);
  process.argv = [
    "node",
    "run-kospi-shadow",
    "--dry-run",
    "--user",
    "user",
    "--as-of",
    "2026-10-06",
  ];
  await runKospiShadow();
  expect(capture.buildLegacy.mock.calls[0]![2].sourceCollectedAt).toBe("2026-10-21T23:00:00Z");
});

it("rejects corrupt receipts before snapshot or legacy Shadow publication", async () => {
  inputs[0]!.sourceRecord.validation_result.screeningCompaction.original_source_evidence = [];
  await expect(
    runScreening([
      "--supabase-user-id",
      "11111111-1111-4111-8111-111111111111",
      "--output",
      directory,
      "--upload",
      "--force",
    ]),
  ).rejects.toThrow("Invalid screening compaction timing evidence");
  expect(capture.upsert).not.toHaveBeenCalled();
  expect(capture.replay).not.toHaveBeenCalled();
  process.argv = [
    "node",
    "run-kospi-shadow",
    "--dry-run",
    "--user",
    "user",
    "--as-of",
    "2026-10-06",
  ];
  await expect(runKospiShadow()).rejects.toThrow("Invalid screening compaction timing evidence");
  expect(capture.buildLegacy).not.toHaveBeenCalled();
});
