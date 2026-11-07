import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({ load: vi.fn(), prepared: vi.fn(), engine: vi.fn() }));
vi.mock("../scripts/drive-history-inputs", () => ({
  loadDriveHistory: mocks.load,
  KR_OWNER: "11111111-1111-1111-1111-111111111111",
  KR_BASELINE_SHA: "pinned-baseline-sha",
}));
vi.mock("../scripts/run-drive-screening", () => ({ runDriveScreening: mocks.prepared }));
vi.mock("../scripts/run-screening", () => ({ runScreening: mocks.engine }));
import { runDriveHistoryScreening } from "../scripts/run-drive-history-screening";

const owner = "11111111-1111-1111-1111-111111111111";
const prefix = `https://example.supabase.co/storage/v1/object/cloudtrend-data/${owner}/`;
const inputs = [
  { id: "verified-baseline", fileHash: "verified-file", dataHash: "verified-data", rows: [] },
];
const evidence = { sha256: "verified-sha", source: "immutable-drive-file" };
let root: string;
let transport: ReturnType<typeof vi.fn>;

async function prepared(mode = "drive") {
  await mkdir(path.join(root, "prepared"), { recursive: true });
  await writeFile(path.join(root, "prepared/input.json"), JSON.stringify({ mode }));
}
async function result(directory: string, published = false) {
  await writeFile(
    path.join(directory, "execution-receipt.json"),
    JSON.stringify({
      dashboardPublished: published,
      phase: "FINAL",
      status: "COMPLETED",
    }),
  );
}
async function receipt() {
  return JSON.parse(await readFile(path.join(root, "execution-receipt.json"), "utf8"));
}
function actions() {
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv(
    "GITHUB_WORKFLOW_REF",
    "owner/repo/.github/workflows/drive-history-screening-v7.yml@refs/heads/main",
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "drive-history-runner-"));
  vi.stubEnv("SUPABASE_USER_ID", owner);
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITHUB_WORKFLOW_REF", "");
  transport = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", transport);
  mocks.load.mockImplementation(async (_directory, onValidation) => {
    await onValidation({ status: "VERIFIED" });
    return { inputs, evidence };
  });
  mocks.prepared.mockImplementation(async (directory) => result(directory));
  mocks.engine.mockResolvedValue({ status: "COMPLETED" });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("Drive history execution wrapper", () => {
  it("passes verified inputs and provenance to prepared dry run without uploading sources", async () => {
    await prepared();
    const completed = await runDriveHistoryScreening(root);
    expect(mocks.load).toHaveBeenCalledWith(path.join(root, "baseline"), expect.any(Function));
    expect(mocks.prepared).toHaveBeenCalledWith(path.join(root, "prepared"), false, {
      inputs,
      provenance: { kind: "VERIFIED_IMMUTABLE_DRIVE_HISTORY", ...evidence },
      beforePublish: expect.any(Function),
    });
    expect(mocks.prepared.mock.calls[0]![2].inputs).toBe(inputs);
    expect(mocks.engine).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(completed).toMatchObject({
      status: "COMPLETED_CALCULATION_ONLY",
      dashboardPublished: false,
      phase: "FINAL",
      inputEvidence: evidence,
    });
    expect(await receipt()).toMatchObject(completed);
    expect(JSON.parse(await readFile(path.join(root, "validation-receipt.json"), "utf8"))).toEqual([
      { status: "VERIFIED" },
    ]);
    expect(globalThis.fetch).toBe(transport);
  });

  it.each([
    ["", ""],
    ["true", "owner/repo/.github/workflows/other.yml@main"],
    ["false", "owner/repo/.github/workflows/drive-history-screening-v7.yml@main"],
  ])("rejects publication outside its shared workflow (%s, %s)", async (enabled, workflow) => {
    vi.stubEnv("GITHUB_ACTIONS", enabled);
    vi.stubEnv("GITHUB_WORKFLOW_REF", workflow);
    await expect(runDriveHistoryScreening(root, true)).rejects.toThrow(
      "shared screening-writer Actions workflow",
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(transport);
  });

  it("rejects an unpinned owner before loading history", async () => {
    vi.stubEnv("SUPABASE_USER_ID", "22222222-2222-2222-2222-222222222222");
    await expect(runDriveHistoryScreening(root)).rejects.toThrow("Pinned baseline owner mismatch");
    expect(mocks.load).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(transport);
  });

  it.each([
    ["publish", false],
    ["drive", true],
    ["supabase", false],
  ] as const)("saves failure for prepared mode %s and publish=%s", async (mode, publish) => {
    actions();
    await prepared(mode);
    await expect(runDriveHistoryScreening(root, publish)).rejects.toThrow(
      "Prepared run and publication option differ",
    );
    expect(mocks.prepared).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({
      status: "FAILED",
      dashboardPublished: false,
      failureClass: "Error",
      elapsedMs: expect.any(Number),
      peakRssBytes: expect.any(Number),
    });
    expect(globalThis.fetch).toBe(transport);
  });

  it("keeps result writes blocked until beforePublish and never permits raw collection writes", async () => {
    actions();
    await prepared("publish");
    mocks.prepared.mockImplementation(async (directory, _upload, history) => {
      const resultUrl = prefix + "results/screening/run-12345678.json";
      await expect(fetch(resultUrl, { method: "POST" })).rejects.toThrow("blocked supabase-write");
      history.beforePublish("run-12345678");
      await expect(fetch(resultUrl, { method: "POST" })).resolves.toBeInstanceOf(Response);
      for (const suffix of [
        "source/screening/raw.csv",
        "source/us-screening/raw.csv",
        "results/screening/another-run.json",
      ]) {
        await expect(fetch(prefix + suffix, { method: "POST" })).rejects.toThrow(
          "Drive validation blocked",
        );
      }
      await expect(
        fetch("https://example.supabase.co/rest/v1/source_registry", { method: "POST" }),
      ).rejects.toThrow("blocked supabase-write");
      await result(directory, true);
    });
    const completed = await runDriveHistoryScreening(root, true);
    expect(completed).toMatchObject({
      status: "COMPLETED_PUBLISHED",
      dashboardPublished: true,
      network: { supabaseWrites: 1 },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toBe(transport);
  });

  it("retains baseline-only calculation fallback without invoking the publisher", async () => {
    const completed = await runDriveHistoryScreening(root);
    expect(mocks.engine).toHaveBeenCalledWith(
      ["--supabase-user-id", owner, "--output", path.join(root, "results"), "--force"],
      inputs,
      { kind: "VERIFIED_IMMUTABLE_DRIVE_HISTORY", ...evidence },
    );
    expect(mocks.prepared).not.toHaveBeenCalled();
    expect(completed).toMatchObject({
      status: "COMPLETED_CALCULATION_ONLY",
      dashboardPublished: false,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(transport);
  });

  it("requires completed collection inputs to publish", async () => {
    actions();
    await expect(runDriveHistoryScreening(root, true)).rejects.toThrow(
      "Completed collection manifest required",
    );
    expect(mocks.engine).not.toHaveBeenCalled();
    expect(await receipt()).toMatchObject({ status: "FAILED", dashboardPublished: false });
    expect(globalThis.fetch).toBe(transport);
  });

  it.each(["loader", "prepared", "engine", "malformed-input"])(
    "saves failures and restores fetch after %s errors",
    async (stage) => {
      if (stage === "loader") mocks.load.mockRejectedValue(new TypeError("invalid baseline"));
      if (stage === "prepared") {
        await prepared();
        mocks.prepared.mockRejectedValue(new TypeError("calculation failed"));
      }
      if (stage === "engine") mocks.engine.mockRejectedValue(new TypeError("engine failed"));
      if (stage === "malformed-input") {
        await prepared();
        await writeFile(path.join(root, "prepared/input.json"), "{");
      }
      await expect(runDriveHistoryScreening(root)).rejects.toThrow();
      expect(await receipt()).toMatchObject({
        status: "FAILED",
        dashboardPublished: false,
        failureClass: stage === "malformed-input" ? "SyntaxError" : "TypeError",
      });
      expect(globalThis.fetch).toBe(transport);
    },
  );
});
