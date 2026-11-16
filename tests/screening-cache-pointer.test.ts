import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  getSession: vi.fn(),
}));
const client = () => ({
  storage: {
    from: () => ({ download: mocks.download, upload: mocks.upload, remove: mocks.remove }),
  },
});
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getSession: mocks.getSession }, ...client() }),
}));
import { getMockDataset } from "../src/lib/engine/mockProvider";
import { runAnalysis } from "../src/lib/engine/pipeline";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import {
  deterministicAnalysis,
  SCREENING_CACHE_VERSION,
  stableCacheJson,
} from "../src/lib/screeningCacheContract";
import { compressedCacheObjectPath, gzipJson } from "../src/lib/cacheObjectEncoding";
import { readFreshCacheObject, decodeCacheBytes } from "../src/lib/cacheObjectStorage";
import { downloadCachePointer, uploadCachePointer } from "../scripts/screening-cache-pointer";

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
const pointer = "owner/cache/screening/latest.json";
let objects: Map<string, unknown>;
let reads: string[];

beforeEach(() => {
  vi.resetAllMocks();
  objects = new Map([[compressedCacheObjectPath(pointer), screening]]);
  reads = [];
  mocks.download.mockImplementation(async (path: string) => {
    reads.push(path);
    if (!objects.has(path)) return { data: null, error: { message: "Object not found" } };
    const value = objects.get(path);
    const body = path.endsWith(".gz")
      ? new Uint8Array(await gzipJson(value))
      : new TextEncoder().encode(JSON.stringify(value));
    return { data: new Blob([body]), error: null };
  });
  mocks.upload.mockImplementation(async (path: string, body: Blob | Uint8Array) => {
    const bytes =
      body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : new Uint8Array(body);
    objects.set(path, await decodeCacheBytes(bytes));
    return { error: null };
  });
  mocks.getSession.mockResolvedValue({
    data: { session: { user: { id: "owner" } } },
    error: null,
  });
});

vi.mock("@/lib/cloud", () => ({
  ownerPath: async (path: string) => `owner/${path}`,
  userId: async () => "owner",
  CLOUD_DATA_BUCKET: "cloudtrend-data",
  supabase: { auth: { getSession: mocks.getSession }, ...client() },
  readObject: async (path: string) =>
    readFreshCacheObject(client() as never, "cloudtrend-data", path),
  writeObject: vi.fn(),
  readBinaryObject: vi.fn(async () => null),
  writeBinaryObject: vi.fn(),
}));
vi.mock("@/lib/manualDataStore", () => ({
  ensureManualDataset: vi.fn(),
  getManualDataMeta: () => null,
}));
vi.mock("@/lib/scoringConfigStore", () => ({
  getActiveScoringConfig: () => DEFAULT_SCORING_CONFIG,
}));
vi.mock("@/lib/sourceRegistry", () => ({
  listRegisteredSources: async () => [],
  listActiveScreeningSourceFingerprints: async () => [],
}));

test("the node publisher writes the compressed pointer and reads either encoding", async () => {
  const storage = client() as unknown as SupabaseClient;
  const body = await uploadCachePointer(storage, pointer, { version: "v2" });
  expect(body.byteLength).toBeGreaterThan(0);
  expect([...objects.keys()]).toEqual([compressedCacheObjectPath(pointer)]);
  expect(await downloadCachePointer(storage, pointer)).toEqual({ version: "v2" });

  // A plain pointer written by a deployment that predates the encoding is still readable.
  objects.delete(compressedCacheObjectPath(pointer));
  objects.set(pointer, { version: "plain" });
  expect(await downloadCachePointer(storage, pointer)).toEqual({ version: "plain" });
  expect(await downloadCachePointer(storage, "owner/cache/dashboard/latest.json")).toBeNull();
});

test("browsing several symbols reuses one verified shared-cache read for a few seconds", async () => {
  const { readSharedScreeningCache, invalidateSharedScreeningCache } =
    await import("../src/lib/screeningCache");
  const pointerReads = () =>
    reads.filter((path) => path.endsWith("cache/screening/latest.json.gz")).length;
  expect(await readSharedScreeningCache()).not.toBeNull();
  expect(await readSharedScreeningCache()).not.toBeNull();
  expect(pointerReads()).toBe(1);
  // A screen that writes the shared cache drops the reuse entry immediately.
  invalidateSharedScreeningCache();
  expect(await readSharedScreeningCache()).not.toBeNull();
  expect(pointerReads()).toBe(2);
});

test("concurrent panels download and validate the shared screening only once", async () => {
  const { readScreeningCache, readSharedScreeningCache, invalidateSharedScreeningCache } =
    await import("../src/lib/screeningCache");
  invalidateSharedScreeningCache();
  const results = await Promise.all([
    readScreeningCache(),
    readSharedScreeningCache(),
    readSharedScreeningCache(),
  ]);
  expect(results.every((r) => r?.resultDigest === screening.resultDigest)).toBe(true);
  expect(reads.filter((p) => p.endsWith("cache/screening/latest.json.gz"))).toHaveLength(1);
  // A later explicit read must still inspect the origin, not the 45-second reuse entry.
  await readScreeningCache();
  expect(reads.filter((p) => p.endsWith("cache/screening/latest.json.gz"))).toHaveLength(2);
});

test("a failed concurrent read does not poison the next request", async () => {
  const { readScreeningCache, invalidateSharedScreeningCache } =
    await import("../src/lib/screeningCache");
  invalidateSharedScreeningCache();
  mocks.download.mockRejectedValueOnce(new Error("offline"));
  // The compressed reader can try a plain fallback, which must fail too here.
  mocks.download.mockRejectedValueOnce(new Error("offline"));
  const results = await Promise.allSettled([readScreeningCache(), readScreeningCache()]);
  expect(results.every((r) => r.status === "rejected")).toBe(true);
  expect(await readScreeningCache()).not.toBeNull();
});

test("invalidation prevents an older in-flight read from repopulating shared reuse", async () => {
  const { readScreeningCache, readSharedScreeningCache, invalidateSharedScreeningCache } =
    await import("../src/lib/screeningCache");
  invalidateSharedScreeningCache();
  let finish!: (value: { data: Blob; error: null }) => void;
  mocks.download.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = readScreeningCache();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  invalidateSharedScreeningCache();
  finish({ data: new Blob([(await gzipJson(screening)) as BlobPart]), error: null });
  expect(await pending).not.toBeNull();
  reads.length = 0;
  expect(await readSharedScreeningCache()).not.toBeNull();
  expect(reads.filter((p) => p.endsWith("cache/screening/latest.json.gz"))).toHaveLength(1);
});
