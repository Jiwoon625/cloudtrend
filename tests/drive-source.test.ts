import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { preliminarySource } from "./kr-preliminary-fixture";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  load: vi.fn(),
  register: vi.fn(),
  run: vi.fn(),
  head: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("../scripts/analysis-run-store", async (original) => ({
  ...(await original<typeof import("../scripts/analysis-run-store")>()),
  trustedSupabaseClient: () => ({}),
}));
vi.mock("../scripts/source-registry-store", async (original) => ({
  ...(await original<typeof import("../scripts/source-registry-store")>()),
  listSourceRecords: mocks.list,
  loadAnalysisSourceInputs: mocks.load,
  registerSourceBytes: mocks.register,
}));
vi.mock("../scripts/run-screening", () => ({ runScreening: mocks.run }));
vi.mock("../scripts/publish-drive-result", () => ({
  maybeDriveHead: mocks.head,
  publishDriveResult: mocks.publish,
}));
import { runDriveScreening } from "../scripts/run-drive-screening";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let directory: string;
let spec: { mode: string; [key: string]: unknown };
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.head.mockResolvedValue(null);
  mocks.publish.mockResolvedValue({ roundTripVerified: true, sourceUploads: 0 });
  vi.stubEnv("SUPABASE_USER_ID", "00000000-0000-4000-8000-000000000001");
  directory = await mkdtemp(path.join(tmpdir(), "drive-screening-test-"));
  const csv =
    "symbol,name,market,type,date,close,volume,marketCapSource\nKOSPI,Index,INDEX,INDEX,2026-10-06,2500,0,\nTEST,Synthetic,KOSPI,STOCK,2026-10-06,100,1000,KRX_PENDING_PUBLICATION\n";
  const manifest = JSON.parse(
    preliminarySource().source.validation_result.krPublication.manifestText,
  );
  Object.assign(manifest, {
    createdAt: "2026-10-06T16:00:00Z",
    csv: [{ file: "input.csv", sha256: sha(csv), bytes: Buffer.byteLength(csv) }],
  });
  const text = JSON.stringify(manifest);
  spec = {
    version: "drive-screening-input-v1",
    runId: manifest.runId,
    mode: "drive",
    archiveFileId: "synthetic_archive",
    archiveSha256: sha("archive"),
    manifestSha256: sha(text),
    parts: [{ path: "input.csv", sha256: sha(csv) }],
  };
  await writeFile(path.join(directory, "input.json"), JSON.stringify(spec));
  await writeFile(path.join(directory, "collector-manifest.json"), text);
  await writeFile(path.join(directory, "input.csv"), csv);
  mocks.list.mockResolvedValue([]);
  mocks.load.mockImplementation(async () => [
    {
      id: "baseline",
      fileHash: "historical-hash",
      dataHash: "historical-data",
      text: "historical",
    },
  ]);
  mocks.run.mockResolvedValue({ summary: { krPublication: { phase: "PRELIMINARY" } } });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test("direct mode overlays existing history with Drive data and never registers or publishes inputs", async () => {
  await runDriveScreening(directory);
  expect(mocks.register).not.toHaveBeenCalled();
  const [args, inputs, provenance] = mocks.run.mock.calls[0]!;
  expect(args).not.toContain("--upload");
  expect(args).toContain("--force");
  expect(inputs[0].id).toBe("baseline");
  expect(inputs[1].sourceRecord.storage_bucket).toBe("google-drive");
  expect(inputs[1].sourceRecord.validation_result.krPublication.phase).toBe("PRELIMINARY");
  expect(provenance.historicalSources).toEqual([
    { id: "baseline", fileHash: "historical-hash", dataHash: "historical-data" },
  ]);
  const receipt = JSON.parse(
    await readFile(path.join(directory, "execution-receipt.json"), "utf8"),
  );
  expect(receipt).toMatchObject({
    status: "COMPLETED",
    dashboardPublished: false,
    phase: "PRELIMINARY",
  });
  await runDriveScreening(directory);
  expect(mocks.register).not.toHaveBeenCalled();
});

test("Supabase mode uses the existing merge publisher and then runs dashboard publication", async () => {
  spec.mode = "supabase";
  await writeFile(path.join(directory, "input.json"), JSON.stringify(spec));
  mocks.register.mockResolvedValue({
    source: { id: "registered", file_hash: "hash" },
    reused: false,
  });
  await runDriveScreening(directory);
  expect(mocks.register).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "merge", syncLegacy: false }),
  );
  expect(mocks.run.mock.calls[0]![0]).toContain("--upload");
  expect(mocks.load).not.toHaveBeenCalled();
});

test("changed files and incomplete part sets stop before loading credentials or registering sources", async () => {
  await writeFile(path.join(directory, "input.csv"), "changed");
  await expect(runDriveScreening(directory)).rejects.toThrow("does not match");
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
});

test("a failed calculation saves a retryable receipt without changing the source registry", async () => {
  mocks.run.mockRejectedValue(new Error("synthetic failure"));
  await expect(runDriveScreening(directory)).rejects.toThrow("synthetic failure");
  const receipt = JSON.parse(
    await readFile(path.join(directory, "execution-receipt.json"), "utf8"),
  );
  expect(receipt.status).toBe("FAILED");
  expect(mocks.register).not.toHaveBeenCalled();
});

test("newer published source data prevents an accidental historical replay", async () => {
  mocks.list.mockResolvedValue([{ max_date: "2026-10-07" }]);
  await expect(runDriveScreening(directory)).rejects.toThrow("최신");
  expect(mocks.run).not.toHaveBeenCalled();
});

test("v1.1 calculates once and publishes only the result without registering source bytes", async () => {
  spec.mode = "publish";
  spec.parents = [];
  spec.expectedHeadHash = null;
  mocks.list.mockResolvedValue([{ max_date: "2026-10-05" }]);
  await writeFile(path.join(directory, "input.json"), JSON.stringify(spec));
  mocks.run.mockResolvedValue({
    outputDir: directory,
    summary: { krPublication: { phase: "PRELIMINARY" } },
  });
  await runDriveScreening(directory);
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.run.mock.calls[0]![0]).not.toContain("--upload");
  expect(mocks.publish).toHaveBeenCalledWith(
    expect.objectContaining({ owner: process.env["SUPABASE_USER_ID"], expectedHeadHash: null }),
  );
  const receipt = JSON.parse(
    await readFile(path.join(directory, "execution-receipt.json"), "utf8"),
  );
  expect(receipt).toMatchObject({
    dashboardPublished: true,
    sourceUploads: 0,
    phase: "PRELIMINARY",
  });
});

test("publishing a run cannot silently skip a missing previous trading session", async () => {
  spec.mode = "publish";
  spec.parents = [];
  spec.expectedHeadHash = null;
  await writeFile(path.join(directory, "input.json"), JSON.stringify(spec));
  mocks.list.mockResolvedValue([{ max_date: "2026-10-02" }]);
  await expect(runDriveScreening(directory)).rejects.toThrow("이전 거래일");
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});

test("a competing Drive history head blocks result publication", async () => {
  spec.mode = "publish";
  spec.parents = [];
  spec.expectedHeadHash = null;
  await writeFile(path.join(directory, "input.json"), JSON.stringify(spec));
  mocks.head.mockResolvedValue({ version: "changed" });
  await expect(runDriveScreening(directory)).rejects.toThrow("head changed");
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});

test("legacy raw-source publication cannot silently drop prior Drive deltas", async () => {
  spec.mode = "supabase";
  await writeFile(path.join(directory, "input.json"), JSON.stringify(spec));
  mocks.head.mockResolvedValue({ version: "drive-input-head-v1" });
  await expect(runDriveScreening(directory)).rejects.toThrow("v1.1");
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});
