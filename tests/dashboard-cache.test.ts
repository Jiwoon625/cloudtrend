import { createHash } from "node:crypto";
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
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), compute: vi.fn(), raw: vi.fn() }));
vi.mock("@/lib/cloud", () => ({
  ownerPath: async (path: string) => `owner/${path}`,
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
vi.mock("@/lib/sourceRegistry", () => ({ listRegisteredSources: async () => [] }));
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
