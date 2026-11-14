import { currentScreeningEngineIdentity } from "../src/lib/screeningEngineIdentity";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { driveFixture } from "./drive-publication-fixture";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import type { LoadedSourceInput } from "../scripts/source-registry-store";
import { stableCacheJson } from "../src/lib/screeningCacheContract";
const m = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  paths: [] as string[],
  files: [] as string[],
  live: vi.fn(),
  engineManifest: vi.fn(),
  readFailure: null as string | null,
}));
vi.mock("../scripts/october-shadow-code-manifest", () => ({
  shadowEngineManifest: m.engineManifest,
}));
vi.mock("../scripts/analysis-run-store", async (original) => ({
  ...(await original<typeof import("../scripts/analysis-run-store")>()),
  downloadJson: vi.fn(async (_client, p: string) => {
    if (m.readFailure && p.endsWith("cache/screening/latest.json")) throw new Error(m.readFailure);
    if (!m.store.has(p)) throw new Error("Object not found");
    return m.store.get(p);
  }),
  uploadJson: vi.fn(async (_client, p: string, v: unknown) => {
    m.paths.push(p);
    m.store.set(p, v);
    return { body: JSON.stringify(v) };
  }),
}));
vi.mock("../scripts/screening-json-file", () => ({
  uploadScreeningJsonFile: vi.fn(async (_c, p: string) => {
    m.files.push(p);
    return { bytes: 1 };
  }),
}));
// The two homepage pointers are stored gzip-encoded; keep the write/read log in one place.
vi.mock("../scripts/screening-cache-pointer", () => ({
  uploadCachePointer: vi.fn(async (_client, p: string, v: unknown) => {
    // Record the stored gzip object; the in-memory map keeps the decoded logical value.
    m.paths.push(`${p}.gz`);
    m.store.set(p, v);
    return Buffer.from("");
  }),
  downloadCachePointer: vi.fn(async (_client, p: string) => {
    if (m.readFailure && p.endsWith("cache/screening/latest.json")) throw new Error(m.readFailure);
    return m.store.get(`${p}.gz`) ?? m.store.get(p) ?? null;
  }),
}));
vi.mock("../src/lib/confirmedEtfContext.server", () => ({ preserveConfirmedEtfContext: vi.fn() }));
vi.mock("../src/lib/screeningSnapshot", () => ({ buildSnapshot: () => ({}) }));
vi.mock("../scripts/source-registry-store", async (original) => ({
  ...(await original<typeof import("../scripts/source-registry-store")>()),
  listSourceRecords: m.live,
}));
vi.mock("../src/lib/screeningCacheContract", async (original) => ({
  ...(await original<typeof import("../src/lib/screeningCacheContract")>()),
  buildDashboardSummary: vi.fn((analysis, inputFingerprint, resultDigest) => ({
    asOfDate: analysis.asOfDate,
    inputFingerprint,
    resultDigest,
    counts: {},
  })),
}));
import { publishDriveResult } from "../scripts/publish-drive-result";
let directory: string;
const owner = "synthetic-owner";
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "drive-publisher-"));
  m.store.clear();
  m.readFailure = null;
  m.paths = [];
  m.files = [];
  m.live.mockReset().mockResolvedValue([]);
  m.engineManifest
    .mockReset()
    .mockResolvedValue({ codeHash: `sha256:${currentScreeningEngineIdentity.codeHash}` });
  m.store.set(`${owner}/cache/screening/latest.json`, {
    payload: { analysis: { asOfDate: "2026-10-05" } },
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function request(phase: "PRELIMINARY" | "FINAL" = "PRELIMINARY") {
  const proof = driveFixture(phase),
    record = proof.sources[0]!.record;
  const inputs = [
    {
      id: record.id,
      fileHash: record.file_hash,
      dataHash: record.data_hash,
      schemaHash: record.schema_hash,
      sourceRecord: record,
    },
  ] as LoadedSourceInput[];
  const result = {
    asOfDate: proof.asOfDate,
    calculatedAt: "now",
    ...(phase === "PRELIMINARY" ? { krPublication: { phase: proof.phase } } : {}),
    rows: [],
  };
  await writeFile(
    path.join(directory, "screening-bundle.json"),
    JSON.stringify({
      engineIdentity: currentScreeningEngineIdentity,
      result,
      config: DEFAULT_SCORING_CONFIG,
      run: { id: "synthetic-run", kind: "SCREENING" },
      summary: {},
      data: { asOfDate: proof.asOfDate, sources: inputs },
    }),
  );
  return {
    client: {} as never,
    owner,
    outputDir: directory,
    inputs,
    sources: proof.sources,
    expectedHeadHash: null,
  };
}
test("one calculated bundle publishes only result objects and preserves the Drive input chain", async () => {
  const receipt = await publishDriveResult(await request());
  expect(receipt).toMatchObject({
    sourceUploads: 0,
    sourceRegistryWrites: 0,
    financialHistoryWrites: 0,
    date: "2026-10-06",
    phase: "PRELIMINARY",
  });
  expect(m.paths.every((p) => p.includes("/cache/") || p.includes("/results/"))).toBe(true);
  expect(
    m.paths.some((p) => p.includes("/source/") || p.includes("/raw/") || p.endsWith("/kr.json")),
  ).toBe(false);
  expect(m.files).toEqual([`${owner}/results/screening/synthetic-run.json`]);
  expect(
    stableCacheJson(m.store.get(`${owner}/results/drive-screening/input-head/latest.json`)),
  ).toContain("syntheticArchive123");
});
test("a newer homepage result blocks all writes including the input head", async () => {
  const r = await request();
  m.store.set(`${owner}/cache/screening/latest.json`, {
    payload: { analysis: { asOfDate: "2026-10-07" } },
  });
  await expect(publishDriveResult(r)).rejects.toThrow("최신");
  expect(m.paths).toEqual([]);
});
test("a competing history head blocks publication before writes", async () => {
  const r = await request();
  m.store.set(`${owner}/results/drive-screening/input-head/latest.json`, { version: "changed" });
  await expect(publishDriveResult(r)).rejects.toThrow("게시 이력");
  expect(m.paths).toEqual([]);
});
test("a result bundle with altered input identities cannot be published", async () => {
  const r = await request();
  r.inputs[0]!.dataHash = "altered";
  await expect(publishDriveResult(r)).rejects.toThrow("identities differ");
  expect(m.paths).toEqual([]);
});

test("implicit FINAL bundle publishes and binds both result caches to its generation", async () => {
  const receipt = await publishDriveResult(await request("FINAL"));
  expect(receipt.phase).toBe("FINAL");
  const head = m.store.get(`${owner}/results/drive-screening/input-head/latest.json`) as {
    publicationId: string;
  };
  expect(head.publicationId).toBe(receipt.publicationId);
  expect(m.store.get(`${owner}/cache/dashboard/latest.json`)).toMatchObject({
    publicationId: head.publicationId,
  });
});
test("implicit FINAL cannot be downgraded by a same-day preliminary result", async () => {
  const r = await request();
  m.store.set(`${owner}/cache/screening/latest.json`, {
    payload: { analysis: { asOfDate: "2026-10-06" } },
  });
  await expect(publishDriveResult(r)).rejects.toThrow("확정");
  expect(m.paths).toEqual([]);
});
test("a verified missing previous cache allows first publication", async () => {
  const r = await request();
  m.store.delete(`${owner}/cache/screening/latest.json`);
  await expect(publishDriveResult(r)).resolves.toMatchObject({ sourceUploads: 0 });
});
test("previous-cache permission errors block before any writes", async () => {
  const r = await request();
  m.readFailure = "permission denied";
  await expect(publishDriveResult(r)).rejects.toThrow("permission denied");
  expect(m.paths).toEqual([]);
});

test.each(["archive", "manifest", "missing"])(
  "publisher revalidates %s parent binding before any writes",
  async (mutation) => {
    const { sha256 } = await import("../scripts/analysis-run-store");
    const r = await request("FINAL");
    await publishDriveResult(r);
    const head = m.store.get(`${owner}/results/drive-screening/input-head/latest.json`);
    const repeat = {
      ...r,
      expectedHeadHash: sha256(stableCacheJson(head)),
      sources: structuredClone(r.sources),
    };
    if (mutation === "archive") repeat.sources[0]!.archiveSha256 = "b".repeat(64);
    if (mutation === "manifest")
      repeat.sources[0]!.record.validation_result.krPublication.manifestSha256 =
        "sha256:" + "b".repeat(64);
    if (mutation === "missing") repeat.sources = [];
    m.paths = [];
    m.files = [];
    await expect(publishDriveResult(repeat)).rejects.toThrow("이전 Drive 입력");
    expect(m.paths).toEqual([]);
    expect(m.files).toEqual([]);
  },
);

test("same engine regression rejects before any write, including head", async () => {
  const r = await request("FINAL");
  const receipt = await publishDriveResult(r);
  const headPath = `${owner}/results/drive-screening/input-head/latest.json`;
  const oldHead = structuredClone(m.store.get(headPath));
  const { sha256 } = await import("../scripts/analysis-run-store");
  const { readFile } = await import("node:fs/promises");
  const file = path.join(directory, "screening-bundle.json");
  const bundle = JSON.parse(await readFile(file, "utf8"));
  bundle.result.rows = [{ changed: true }];
  await writeFile(file, JSON.stringify(bundle));
  m.paths = [];
  m.files = [];
  await expect(
    publishDriveResult({ ...r, expectedHeadHash: sha256(stableCacheJson(oldHead)) }),
  ).rejects.toThrow("regression guard");
  expect(m.paths).toEqual([]);
  expect(m.files).toEqual([]);
  expect(m.store.get(headPath)).toEqual(oldHead);
  expect(m.store.get(`${owner}/cache/screening/latest.json`)).toMatchObject({
    resultDigest: receipt.resultDigest,
  });
});

test.each([
  undefined,
  null,
  {},
  { ...currentScreeningEngineIdentity, codeHash: "f".repeat(64) },
  {
    ...currentScreeningEngineIdentity,
    codeHash: "0d2307099c51f1d0e3a37773651001fdbb2bd83cefcc45bb279018689e27d09b",
  },
])("bundle engine identity is never filled/relabelled at publish: %j", async (engineIdentity) => {
  const r = await request();
  const { readFile } = await import("node:fs/promises");
  const file = path.join(directory, "screening-bundle.json");
  const bundle = JSON.parse(await readFile(file, "utf8"));
  bundle.engineIdentity = engineIdentity;
  const original = JSON.stringify(bundle);
  await writeFile(file, original);
  await expect(publishDriveResult(r)).rejects.toThrow(/engine|recalculat/i);
  expect(m.paths).toEqual([]);
  expect(m.files).toEqual([]);
  expect(await readFile(file, "utf8")).toBe(original);
});

test("engine identity follows calculated bundle into all publication envelopes", async () => {
  const receipt = await publishDriveResult(await request("FINAL"));
  expect(receipt.engineIdentity).toEqual(currentScreeningEngineIdentity);
  for (const p of [
    "cache/screening/latest.json",
    "cache/dashboard/latest.json",
    "results/drive-screening/input-head/latest.json",
    "results/drive-screening/receipts/synthetic-run.json",
  ])
    expect(m.store.get(`${owner}/${p}`)).toMatchObject({
      engineIdentity: currentScreeningEngineIdentity,
    });
});

test("registry change during preflight rejects before head write", async () => {
  const r = await request("FINAL");
  m.live.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "changed", data_hash: "changed" }]);
  await expect(publishDriveResult(r)).rejects.toThrow("registry changed");
  expect(m.paths).toEqual([]);
});

test("head change during preflight rejects before any write", async () => {
  const r = await request("FINAL");
  m.live.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
    m.store.set(`${owner}/results/drive-screening/input-head/latest.json`, { competing: true });
    return [];
  });
  await expect(publishDriveResult(r)).rejects.toThrow("head changed");
  expect(m.paths).toEqual([]);
  expect(m.files).toEqual([]);
});

test("predecessor cache cannot be substituted under an otherwise valid head", async () => {
  const r = await request("FINAL");
  await publishDriveResult(r);
  const head = m.store.get(`${owner}/results/drive-screening/input-head/latest.json`);
  const { sha256 } = await import("../scripts/analysis-run-store");
  const old = m.store.get(`${owner}/cache/screening/latest.json`) as Record<string, unknown>;
  m.store.set(`${owner}/cache/screening/latest.json`, {
    ...old,
    publicationId: "wrong-predecessor",
  });
  m.paths = [];
  m.files = [];
  await expect(
    publishDriveResult({ ...r, expectedHeadHash: sha256(stableCacheJson(head)) }),
  ).rejects.toThrow("predecessor cache");
  expect(m.paths).toEqual([]);
  expect(m.files).toEqual([]);
});

test.each(["content", "digest"])(
  "corrupted predecessor %s rejects before head writes",
  async (mutation) => {
    const r = await request("FINAL");
    await publishDriveResult(r);
    const headPath = `${owner}/results/drive-screening/input-head/latest.json`;
    const head = structuredClone(m.store.get(headPath));
    const old = structuredClone(m.store.get(`${owner}/cache/screening/latest.json`)) as {
      payload: { analysis: { rows: unknown[] } };
      resultDigest: string;
    };
    if (mutation === "content") old.payload.analysis.rows = [{ corrupted: true }];
    else {
      old.resultDigest = "f".repeat(64);
      // Even matching head metadata must not authenticate corrupted result bytes.
      (head as { resultDigest: string }).resultDigest = old.resultDigest;
      m.store.set(headPath, head);
    }
    m.store.set(`${owner}/cache/screening/latest.json`, old);
    const { sha256 } = await import("../scripts/analysis-run-store");
    m.paths = [];
    m.files = [];
    await expect(
      publishDriveResult({ ...r, expectedHeadHash: sha256(stableCacheJson(head)) }),
    ).rejects.toThrow("content does not match");
    expect(m.paths).toEqual([]);
    expect(m.files).toEqual([]);
    expect(m.store.get(headPath)).toEqual(head);
  },
);

test("standalone publisher rejects stale executable/manifest identity before any writes", async () => {
  const r = await request("FINAL");
  m.engineManifest.mockResolvedValue({ codeHash: `sha256:${"f".repeat(64)}` });
  await expect(publishDriveResult(r)).rejects.toThrow("Stale screening engine manifest");
  expect(m.engineManifest).toHaveBeenCalledWith(
    process.cwd(),
    expect.arrayContaining(["src/lib/currentScreening.ts"]),
    "screening-signal-engine-v1",
  );
  expect(m.paths).toEqual([]);
  expect(m.files).toEqual([]);
  expect(m.store.has(`${owner}/results/drive-screening/input-head/latest.json`)).toBe(false);
});

test("fresh equal-digest calculation adopts engine identity from a legacy PRELIMINARY generation without the Nov9 bridge", async () => {
  const r = await request();
  await publishDriveResult(r);
  const headPath = `${owner}/results/drive-screening/input-head/latest.json`;
  const cachePath = `${owner}/cache/screening/latest.json`;
  const dashboardPath = `${owner}/cache/dashboard/latest.json`;
  for (const p of [headPath, cachePath, dashboardPath])
    delete (m.store.get(p) as { engineIdentity?: unknown }).engineIdentity;
  const previous = structuredClone(m.store.get(cachePath)) as {
    publicationId: string;
    inputFingerprint: string;
    resultDigest: string;
    payload: unknown;
  };
  const { sha256 } = await import("../scripts/analysis-run-store");
  m.paths = [];
  m.files = [];
  const receipt = await publishDriveResult({
    ...r,
    expectedHeadHash: sha256(stableCacheJson(m.store.get(headPath))),
  });
  expect(receipt).toMatchObject({
    date: "2026-10-06",
    phase: "PRELIMINARY",
    inputFingerprint: previous.inputFingerprint,
    resultDigest: previous.resultDigest,
    engineIdentity: currentScreeningEngineIdentity,
  });
  expect(receipt.publicationId).not.toBe(previous.publicationId);
  expect(m.store.get(cachePath)).toMatchObject({
    payload: previous.payload,
    engineIdentity: currentScreeningEngineIdentity,
  });
  for (const p of [headPath, dashboardPath])
    expect(m.store.get(p)).toMatchObject({ engineIdentity: currentScreeningEngineIdentity });
});

test("Nov9 FINAL cannot replace Nov10 PRELIMINARY during cache preflight, before any write", async () => {
  const r = await request();
  const { preflightWebScreeningCaches } = await import("../scripts/web-screening-cache-store");
  const { readFile } = await import("node:fs/promises");
  const bundle = JSON.parse(await readFile(path.join(directory, "screening-bundle.json"), "utf8"));
  m.store.set(`${owner}/cache/screening/latest.json`, {
    payload: { analysis: { asOfDate: "2026-11-10", krPublication: { phase: "PRELIMINARY" } } },
  });
  const { krPublication: _preliminary, ...finalAnalysis } = bundle.result;
  await expect(
    preflightWebScreeningCaches({
      client: r.client,
      userId: owner,
      inputs: r.inputs,
      config: bundle.config,
      analysis: { ...finalAnalysis, asOfDate: "2026-11-09" },
      engineIdentity: currentScreeningEngineIdentity,
      snapshot: {} as never,
      previous: null,
      resultOnly: driveFixture(),
    }),
  ).rejects.toThrow("과거");
  expect(m.paths).toEqual([]);
  expect(m.files).toEqual([]);
});
