import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import { buildKospiShadowSession } from "../src/lib/engine/kospiShadowDataset";
import { KOSPI_SHADOW_POLICY } from "../src/lib/engine/kospiShadow";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { persistKospiShadow, type ShadowObjectStore } from "../src/lib/kospiShadowStore";
import { canonicalSeriesJson } from "../src/lib/ledger/modelSeries";
import { runKospiShadow } from "../scripts/run-kospi-shadow";

const mocks = vi.hoisted(() => ({
  dataset: null as unknown,
  data: new Map<string, unknown>(),
  upload: vi.fn(),
  recovery: vi.fn(),
  verify: vi.fn(),
  sourceHash: "changed-whole-KR",
}));
vi.mock("../scripts/verify-shadow-runtime-manifests", () => ({
  verifyShadowRuntimeManifests: () => mocks.verify(),
}));
vi.mock("../scripts/verify-kospi-shadow-runtime", () => ({
  verifyKospiShadowRuntimeManifest: () => mocks.verify(),
}));
vi.mock("../src/lib/engine/manualDataset", () => ({
  parseManualMarketData: () => ({ dataset: mocks.dataset }),
}));
vi.mock("../scripts/source-registry-store", () => ({
  loadAnalysisSourceInputs: async () => [
    {
      text: "synthetic",
      dataHash: mocks.sourceHash,
      validation: { stats: { minDate: "2026-10-23", maxDate: "2026-10-23" } },
      savedAt: "2026-10-25T23:20:00Z",
    },
  ],
}));
vi.mock("../src/lib/kospiShadowSeries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/kospiShadowSeries")>()),
  openKospiShadowRevisionStore: async (store: ShadowObjectStore) => store,
}));
vi.mock("../scripts/kospi-shadow-late-recovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/kospi-shadow-late-recovery")>()),
  runLateRecovery: (...args: unknown[]) => mocks.recovery(...args),
}));
vi.mock("../scripts/analysis-run-store", async () => {
  const { createHash } = await import("node:crypto");
  const { canonicalSeriesJson } = await import("../src/lib/ledger/modelSeries");
  return {
    ANALYSIS_BUCKET: "synthetic",
    codeVersion: () => "new-commit",
    sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
    stableJson: canonicalSeriesJson,
    trustedSupabaseClient: () => ({
      storage: {
        from: () => ({
          download: async (path: string) =>
            mocks.data.has(path)
              ? { data: new Blob([JSON.stringify(mocks.data.get(path))]), error: null }
              : { data: null, error: { statusCode: "404" } },
          list: async (path: string) => ({
            data: [...mocks.data.keys()]
              .filter((k) => k.startsWith(`${path}/`))
              .map((k) => ({ name: k.split("/").at(-1)! }))
              .sort((a, b) => b.name.localeCompare(a.name))
              .slice(0, 1),
            error: null,
          }),
          upload: mocks.upload,
        }),
      },
    }),
  };
});
const uid = "00000000-0000-0000-0000-000000000001";
const originalArgv = process.argv;
let output: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  mocks.data.clear();
  mocks.upload.mockClear();
  mocks.recovery.mockClear();
  mocks.verify.mockClear();
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("GITHUB_WORKFLOW", "KOSPI prospective Shadow");
  vi.stubEnv("GITHUB_REF", "refs/heads/main");
  vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch");
  vi.stubEnv("KOSPI_LATE_RECOVERY_REQUEST", "");
  vi.stubEnv("SUPABASE_USER_ID", uid);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T00:50:00Z")); // 09:50 KST, after open.
  process.argv = ["node", "runner", "--as-of", "2026-10-23"];
  output = vi.spyOn(console, "log").mockImplementation(() => {});
  const raw = structuredClone(getMockDataset());
  const shift = Date.parse("2026-10-23") - Date.parse(raw.asOfDate);
  const serialized = JSON.stringify(raw).replace(/\d{4}-\d{2}-\d{2}/g, (date) =>
    new Date(Date.parse(date) + shift).toISOString().slice(0, 10),
  );
  const dataset = { ...JSON.parse(serialized), isLive: true };
  mocks.dataset = dataset;
  const config = { policy: KOSPI_SHADOW_POLICY, scoring: DEFAULT_SCORING_CONFIG };
  const session = buildKospiShadowSession(dataset, DEFAULT_SCORING_CONFIG, {
    sourceHash: "original-full-KR",
    codeVersion: "old-commit",
    configHash: `sha256:${createHash("sha256").update(canonicalSeriesJson(config)).digest("hex")}`,
    sourceCollectedAt: "2026-10-25T23:20:00Z",
    now: "2026-10-25T23:30:00Z",
  });
  const store: ShadowObjectStore = {
    read: async <T>(key: string) => structuredClone(mocks.data.get(key) ?? null) as T | null,
    latestSessionDate: async () => null,
    putImmutable: async (key, value) => {
      mocks.data.set(key, structuredClone(value));
    },
    putLatest: async (key, value) => {
      mocks.data.set(key, structuredClone(value));
    },
  };
  await persistKospiShadow(store, uid, session, config);
});
afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("post-open ordinary duplicate is verified read-only rather than entering late recovery", async () => {
  const before = JSON.stringify([...mocks.data]);
  await runKospiShadow();
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.recovery).not.toHaveBeenCalled();
  expect(JSON.stringify([...mocks.data])).toBe(before);
  expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({
    readOnly: true,
    reused: true,
    reuseReason: "VERIFIED_EQUIVALENT_INPUT",
    recordedCodeVersion: "old-commit",
    observedCodeVersion: "new-commit",
  });
});
it("post-open changed completed input fails closed and does not fall through to recovery", async () => {
  const ds = mocks.dataset as ReturnType<typeof getMockDataset>;
  ds.indexSeries.find((index) => index.indexCode === "KOSPI")!.bars.at(-1)!.close++;
  await expect(runKospiShadow()).rejects.toThrow(/immutable/);
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.recovery).not.toHaveBeenCalled();
});
it("uncompleted post-open date still enters the existing strict late-recovery path", async () => {
  mocks.data.clear();
  await runKospiShadow();
  expect(mocks.recovery).toHaveBeenCalledOnce();
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.recovery.mock.calls[0]!.slice(-2)).toEqual([["2026-10-23"], "auto"]);
});
it("explicit verification returns proof only and cannot create a missing date", async () => {
  process.argv.push("--verify-completed");
  await runKospiShadow();
  expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({
    status: "COMPLETED_INPUT_VERIFIED",
    readOnly: true,
  });
  mocks.data.clear();
  await expect(runKospiShadow()).rejects.toThrow(/No ordinary completed/);
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.recovery).not.toHaveBeenCalled();
});
it("explicit verification rejects altered input without recovery or upload fallback", async () => {
  process.argv.push("--verify-completed");
  const ds = mocks.dataset as ReturnType<typeof getMockDataset>;
  ds.indexSeries.find((index) => index.indexCode === "KOSPI")!.bars.at(-1)!.close++;
  await expect(runKospiShadow()).rejects.toThrow(/immutable/);
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.recovery).not.toHaveBeenCalled();
});
it.each([
  ["--verify-completed"],
  ["--verify-completed", "--as-of", "2026-10-23", "--as-of", "2026-10-23"],
  ["--verify-completed", "--as-of", "latest"],
  ["--verify-completed", "--as-of", "2026-10-23", "--dry-run"],
  ["--verify-completed", "--as-of", "2026-10-23", "--initialize-correction"],
  [
    "--verify-completed",
    "--as-of",
    "2026-10-23",
    "--recovery-mode",
    "apply",
    "--recovery-dates",
    "2026-10-23",
  ],
])("rejects invalid verify-only arguments %j before storage access", async (...args) => {
  process.argv = ["node", "runner", ...args];
  await expect(runKospiShadow()).rejects.toThrow(/Completed verification/);
  expect(mocks.verify).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
});
