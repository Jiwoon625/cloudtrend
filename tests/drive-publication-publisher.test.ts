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
  readFailure: null as string | null,
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
