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
  mocks.run.mockResolvedValue({
    run: { id: "synthetic-engine-run" },
    summary: { krPublication: { phase: "PRELIMINARY" } },
  });
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
    run: { id: "synthetic-engine-run" },
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

test("FINAL Drive input derives exact pending repair evidence from verified rows", async () => {
  const { validateSourceText, compareSourceRows } = await import("../src/lib/sourceData");
  const { recordFor } = await import("../scripts/source-registry-store");
  const { buildKrSourcePublication } = await import("../src/lib/krScreeningPublication.server");
  const oldText = await readFile(path.join(directory, "input.csv"), "utf8");
  const validation = await validateSourceText(oldText, "prior.csv");
  const raw = preliminarySource().source.validation_result.krPublication;
  const prior = recordFor({
    id: "prior-pending",
    userId: process.env["SUPABASE_USER_ID"]!,
    sourceType: "screening",
    origin: "github_action",
    storagePath: "prior.csv",
    validation,
    overlap: compareSourceRows([], []),
  });
  prior.validation_result = {
    ...prior.validation_result,
    krPublication: buildKrSourcePublication(raw, prior),
  };
  mocks.load.mockResolvedValue([
    {
      id: prior.id,
      fileHash: prior.file_hash,
      dataHash: prior.data_hash,
      schemaHash: prior.schema_hash,
      text: validation.canonicalCsv,
      validation: { ...validation, rows: [] },
      sourceRecord: prior,
    },
  ]);
  const csv = oldText
    .replace("marketCapSource\n", "marketCapSource,marketCap\n")
    .replace("2500,0,\n", "2500,0,,\n")
    .replace("KRX_PENDING_PUBLICATION\n", "KRX_STOCK,100000000000\n");
  const manifest = JSON.parse(
    await readFile(path.join(directory, "collector-manifest.json"), "utf8"),
  );
  manifest.latestKrxPublicationPending = false;
  manifest.krxPublicationEvidence.phase = "FINAL";
  for (const market of Object.values(manifest.krxPublicationEvidence.markets) as Array<
    Record<string, unknown>
  >)
    Object.assign(market, {
      status: "PUBLISHED",
      lastPublishedDate: "2026-10-06",
      usableRows: 1,
      rawRows: 1,
    });
  manifest.csv = [{ file: "input.csv", sha256: sha(csv), bytes: Buffer.byteLength(csv) }];
  const manifestText = JSON.stringify(manifest);
  spec.manifestSha256 = sha(manifestText);
  spec.parts = [{ path: "input.csv", sha256: sha(csv) }];
  await writeFile(path.join(directory, "input.json"), JSON.stringify(spec));
  await writeFile(path.join(directory, "collector-manifest.json"), manifestText);
  await writeFile(path.join(directory, "input.csv"), csv);
  await runDriveScreening(directory);
  const inputs = mocks.run.mock.calls[0]![1];
  expect(inputs[1].sourceRecord.validation_result.krPublication.supersedesPending).toEqual([
    {
      sourceId: prior.id,
      fileHash: prior.file_hash,
      dataHash: prior.data_hash,
      schemaHash: prior.schema_hash,
      asOfDate: "2026-10-06",
    },
  ]);
  expect(mocks.register).not.toHaveBeenCalled();
});

async function injectedHistory(maxDate = "2026-10-05") {
  const { validateSourceText, compareSourceRows } = await import("../src/lib/sourceData");
  const { recordFor } = await import("../scripts/source-registry-store");
  const text = (await readFile(path.join(directory, "input.csv"), "utf8")).replaceAll(
    "2026-10-06",
    maxDate,
  );
  const validation = await validateSourceText(text, "baseline.csv");
  const source = recordFor({
    id: "injected-baseline",
    userId: process.env["SUPABASE_USER_ID"]!,
    sourceType: "screening",
    origin: "github_action",
    storagePath: "drive://immutable-baseline/baseline.csv",
    validation,
    overlap: compareSourceRows([], []),
  });
  return {
    inputs: [
      {
        id: source.id,
        fileName: "baseline.csv",
        bytes: Buffer.byteLength(text),
        savedAt: "2026-10-05T16:00:00Z",
        text,
        fileHash: validation.fileHash,
        dataHash: validation.dataHash,
        schemaHash: validation.schemaHash,
        validation,
        sourceRecord: source,
      },
    ],
    provenance: { kind: "VERIFIED_IMMUTABLE_DRIVE_HISTORY", baselineSha256: "verified-baseline" },
    beforePublish: vi.fn(),
  };
}

async function saveCheckpoint(mode = "drive") {
  Object.assign(spec, { mode, parents: [], expectedHeadHash: null });
  await writeFile(path.join(directory, "input.json"), JSON.stringify(spec));
}

test("injected history replaces registry loading and preserves baseline then delta ordering and provenance", async () => {
  await saveCheckpoint();
  const history = await injectedHistory();
  // Registry contains no date: continuity must come from the injected history.
  mocks.list.mockResolvedValue([]);
  await runDriveScreening(directory, false, history);
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(history.beforePublish).not.toHaveBeenCalled();
  const [args, inputs, provenance] = mocks.run.mock.calls[0]!;
  expect(args).not.toContain("--upload");
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toBe(history.inputs[0]);
  expect(inputs[1].sourceRecord.storage_bucket).toBe("google-drive");
  expect(inputs[1].sourceRecord.max_date).toBe("2026-10-06");
  expect(history.inputs).toHaveLength(1);
  expect(provenance).toMatchObject({
    ...history.provenance,
    historicalSources: [
      {
        id: history.inputs[0].id,
        fileHash: history.inputs[0].fileHash,
        dataHash: history.inputs[0].dataHash,
      },
    ],
  });
});

test("injected dry runs require checkpoints and actual baseline previous-session coverage", async () => {
  const history = await injectedHistory("2026-10-02");
  // A recent live registry record cannot fill a hole in the supplied baseline.
  mocks.list.mockResolvedValue([{ max_date: "2026-10-05" }]);
  for (const missing of ["parents", "expectedHeadHash"]) {
    await saveCheckpoint();
    delete spec[missing];
    await writeFile(path.join(directory, "input.json"), JSON.stringify(spec));
    await expect(runDriveScreening(directory, false, history)).rejects.toThrow(
      "Missing Drive input head checkpoint",
    );
  }
  await saveCheckpoint();
  mocks.head.mockResolvedValueOnce({ version: "changed" });
  await expect(runDriveScreening(directory, false, history)).rejects.toThrow("head changed");
  await expect(runDriveScreening(directory, false, history)).rejects.toThrow(
    "이전 거래일 2026-10-05",
  );
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(history.beforePublish).not.toHaveBeenCalled();
  const receipt = JSON.parse(
    await readFile(path.join(directory, "execution-receipt.json"), "utf8"),
  );
  expect(receipt).toMatchObject({ status: "FAILED", dashboardPublished: false });
});

test("injected history rejects raw Supabase source registration mode", async () => {
  await saveCheckpoint("supabase");
  const history = await injectedHistory();
  await expect(runDriveScreening(directory, true, history)).rejects.toThrow(
    "Drive history cannot register sources",
  );
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(history.beforePublish).not.toHaveBeenCalled();
});

test("injected publication enables its writer with the calculated run id immediately before publishing", async () => {
  await saveCheckpoint("publish");
  const history = await injectedHistory();
  mocks.run.mockResolvedValue({
    run: { id: "calculated-run-not-collector-run" },
    outputDir: directory,
    summary: { krPublication: { phase: "PRELIMINARY" } },
  });
  mocks.publish.mockImplementation(async () => {
    expect(history.beforePublish).toHaveBeenCalledExactlyOnceWith(
      "calculated-run-not-collector-run",
    );
    return { roundTripVerified: true, sourceUploads: 0 };
  });
  await runDriveScreening(directory, false, history);
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.publish).toHaveBeenCalledTimes(1);
  expect(history.beforePublish.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.run.mock.invocationCallOrder[0]!,
  );
  expect(history.beforePublish.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.publish.mock.invocationCallOrder[0]!,
  );
  const receipt = JSON.parse(
    await readFile(path.join(directory, "execution-receipt.json"), "utf8"),
  );
  expect(receipt).toMatchObject({
    status: "COMPLETED",
    dashboardPublished: true,
    sourceUploads: 0,
  });
});

async function prepareMultidayDelta(omit?: { date: string; symbol?: string; zeroClose?: boolean }) {
  const dates = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"];
  const rows = ["symbol,name,market,type,date,close,volume,marketCapSource"];
  for (const date of dates) {
    for (const symbol of ["TEST", "OTHER", "KOSPI", "KOSDAQ"]) {
      const matches = omit?.date === date && (!omit.symbol || omit.symbol === symbol);
      if (matches && !omit.zeroClose) continue;
      const index = symbol === "KOSPI" || symbol === "KOSDAQ";
      rows.push(
        `${symbol},Synthetic,${index ? "INDEX" : "KOSPI"},${index ? "INDEX" : "STOCK"},${date},${matches && omit?.zeroClose ? 0 : 100},1000,${index ? "" : "KRX_PENDING_PUBLICATION"}`,
      );
    }
  }
  const csv = rows.join("\n") + "\n";
  const manifest = JSON.parse(
    await readFile(path.join(directory, "collector-manifest.json"), "utf8"),
  );
  manifest.requestedSymbols = ["TEST", "OTHER"];
  manifest.krxPublicationEvidence.calendar.sessions = dates;
  manifest.csv = [{ file: "input.csv", sha256: sha(csv), bytes: Buffer.byteLength(csv) }];
  const text = JSON.stringify(manifest);
  spec.manifestSha256 = sha(text);
  spec.parts = [{ path: "input.csv", sha256: sha(csv) }];
  await writeFile(path.join(directory, "collector-manifest.json"), text);
  await writeFile(path.join(directory, "input.csv"), csv);
  await saveCheckpoint();
}

test("a complete multiday delta bridges injected baseline through the previous trading session", async () => {
  const history = await injectedHistory("2026-09-30");
  await prepareMultidayDelta();
  await runDriveScreening(directory, false, history);
  expect(mocks.run).toHaveBeenCalledTimes(1);
  const inputs = mocks.run.mock.calls[0]![1];
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toBe(history.inputs[0]);
  expect(inputs[1].sourceRecord.min_date).toBe("2026-10-01");
  expect(inputs[1].sourceRecord.max_date).toBe("2026-10-06");
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});

test("multiday delta rejects missing symbols, indexes, intermediate sessions and nonpositive closes before calculation", async () => {
  const history = await injectedHistory("2026-09-30");
  for (const omission of [
    { date: "2026-10-02", symbol: "OTHER" },
    { date: "2026-10-02", symbol: "KOSPI" },
    { date: "2026-10-02", symbol: "KOSDAQ" },
    { date: "2026-10-02" },
    { date: "2026-10-02", symbol: "OTHER", zeroClose: true },
  ]) {
    await prepareMultidayDelta(omission);
    await expect(runDriveScreening(directory, false, history)).rejects.toThrow(
      "이전 거래일 2026-10-02의 종목·지수 이력이 불완전합니다.",
    );
    const receipt = JSON.parse(
      await readFile(path.join(directory, "execution-receipt.json"), "utf8"),
    );
    expect(receipt).toMatchObject({ status: "FAILED", dashboardPublished: false });
  }
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(history.beforePublish).not.toHaveBeenCalled();
});
