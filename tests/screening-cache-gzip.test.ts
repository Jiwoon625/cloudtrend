import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
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
import {
  COMPRESSED_CACHE_CONTENT_TYPE,
  compressedCacheObjectPath,
  gzipJson,
  gunzipJson,
  isCompressedCacheObject,
} from "../src/lib/cacheObjectEncoding";
import { readFreshCacheObject, writeFreshCacheObject } from "../src/lib/cacheObjectStorage";

const bytes = (value: unknown) => new Blob([JSON.stringify(value)]).arrayBuffer();
const gzip = (value: unknown) =>
  new Blob([
    new Uint8Array(gzipSync(Buffer.from(JSON.stringify(value)))) as BlobPart,
  ]).arrayBuffer();

/** Minimal storage double: objects are keyed by path, a missing path is a 404. */
function storage(objects: Record<string, () => Promise<ArrayBuffer>>) {
  const downloads: string[] = [];
  const uploads: Array<{ path: string; body: BlobPart; options: unknown }> = [];
  const client = {
    storage: {
      from: () => ({
        download: async (path: string) => {
          downloads.push(path);
          const body = objects[path];
          if (!body)
            return { data: null, error: { message: "Object not found", statusCode: "404" } };
          return { data: new Blob([await body()]), error: null };
        },
        upload: async (path: string, body: BlobPart, options: unknown) => {
          uploads.push({ path, body, options });
          return { error: null };
        },
      }),
    },
  };
  return { client: client as never, downloads, uploads };
}

test("cache object paths and their compressed form are recognised", () => {
  expect(isCompressedCacheObject("owner/cache/screening/latest.json")).toBe(true);
  expect(isCompressedCacheObject("owner/cache/dashboard/latest.json")).toBe(true);
  expect(compressedCacheObjectPath("owner/cache/screening/latest.json")).toBe(
    "owner/cache/screening/latest.json.gz",
  );
  // Every other mutable pointer keeps its plain encoding.
  expect(isCompressedCacheObject("owner/results/drive-screening/input-head/latest.json")).toBe(
    false,
  );
  expect(isCompressedCacheObject("owner/cache/us-screening/latest.json")).toBe(false);
  expect(isCompressedCacheObject("owner/cache/instruments/005930.json.gz")).toBe(false);
});

test("gzip round trip preserves the stored payload", async () => {
  const value = { rows: [{ symbol: "005930", score: 9.5 }], observationDates: ["2026-11-13"] };
  expect(await gunzipJson(await gzipJson(value))).toEqual(value);
});

test("a compressed pointer is read and the plain pointer is never downloaded", async () => {
  const value = { version: "v1", payload: { rows: [] } };
  const io = storage({ "owner/cache/screening/latest.json.gz": () => gzip(value) });
  expect(
    await readFreshCacheObject(io.client, "bucket", "owner/cache/screening/latest.json"),
  ).toEqual(value);
  expect(io.downloads).toEqual(["owner/cache/screening/latest.json.gz"]);
});

test("a plain pointer keeps working while a publication still holds only the old object", async () => {
  const value = { version: "v1", payload: { rows: [] } };
  const io = storage({ "owner/cache/screening/latest.json": () => bytes(value) });
  expect(
    await readFreshCacheObject(io.client, "bucket", "owner/cache/screening/latest.json"),
  ).toEqual(value);
  expect(io.downloads).toEqual([
    "owner/cache/screening/latest.json.gz",
    "owner/cache/screening/latest.json",
  ]);
});

test("a damaged compressed body falls back to the readable plain pointer", async () => {
  const value = { version: "v1" };
  const io = storage({
    "owner/cache/dashboard/latest.json.gz": () => bytes({ truncated: true }),
    "owner/cache/dashboard/latest.json": () => bytes(value),
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(
    await readFreshCacheObject(io.client, "bucket", "owner/cache/dashboard/latest.json"),
  ).toEqual(value);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test("a gzip body stored under the plain name is decoded by its magic bytes", async () => {
  const value = { version: "v1", migrated: true };
  const io = storage({ "owner/cache/dashboard/latest.json": () => gzip(value) });
  expect(
    await readFreshCacheObject(io.client, "bucket", "owner/cache/dashboard/latest.json"),
  ).toEqual(value);
});

test("absent pointers read as null and a real failure stays visible", async () => {
  const empty = storage({});
  expect(
    await readFreshCacheObject(empty.client, "bucket", "owner/cache/screening/latest.json"),
  ).toBeNull();

  const failing = {
    storage: {
      from: () => ({
        download: async () => ({ data: null, error: { message: "network unavailable" } }),
      }),
    },
  } as never;
  await expect(
    readFreshCacheObject(failing, "bucket", "owner/cache/screening/latest.json"),
  ).rejects.toThrow("network unavailable");
});

test("writing a cache pointer stores only the compressed body", async () => {
  const value = { version: "v1", payload: { rows: [1, 2, 3] } };
  const io = storage({});
  const written = await writeFreshCacheObject(
    io.client,
    "bucket",
    "owner/cache/screening/latest.json",
    value,
  );
  expect(io.uploads.map((upload) => upload.path)).toEqual(["owner/cache/screening/latest.json.gz"]);
  expect(io.uploads[0]!.options).toMatchObject({
    upsert: true,
    contentType: COMPRESSED_CACHE_CONTENT_TYPE,
    cacheControl: "0",
  });
  const stored = new Uint8Array(await (io.uploads[0]!.body as Blob).arrayBuffer());
  expect(written).toBe(stored.byteLength);
  expect(await gunzipJson(stored)).toEqual(value);
});

/** The browser storage layer must route the two pointers and nothing else through gzip. */
const cloud = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => cloud.client }));

const hash = (value: unknown) => createHash("sha256").update(stableCacheJson(value)).digest("hex");
const analysis = runAnalysis(getMockDataset());
const screening = {
  version: SCREENING_CACHE_VERSION,
  createdAt: analysis.calculatedAt,
  inputFingerprint: hash({
    version: SCREENING_CACHE_VERSION,
    strategyConfig: DEFAULT_SCORING_CONFIG,
    sources: [],
    legacyFallback: { dataHash: null, schemaHash: null, savedAt: null, chars: null },
  }),
  resultDigest: hash(deterministicAnalysis(analysis)),
  payload: { analysis },
};

vi.mock("@/lib/scoringConfigStore", () => ({
  getActiveScoringConfig: () => DEFAULT_SCORING_CONFIG,
}));
vi.mock("@/lib/sourceRegistry", () => ({
  listRegisteredSources: async () => [],
  listActiveScreeningSourceFingerprints: async () => [],
}));

beforeEach(() => {
  vi.resetModules();
});

test("the browser cloud layer reads and writes the screening pointer gzip-encoded", async () => {
  const summary = buildDashboardSummary(
    analysis,
    screening.inputFingerprint,
    screening.resultDigest,
    screening.createdAt,
  );
  const objects: Record<string, ArrayBuffer> = {
    "owner/cache/screening/latest.json.gz": await gzip(screening),
    "owner/cache/dashboard/latest.json": await bytes(summary),
  };
  const uploads: string[] = [];
  cloud.client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "owner" } } }, error: null }),
    },
    storage: {
      from: () => ({
        download: async (path: string) => ({
          data: objects[path] ? new Blob([objects[path]!]) : null,
          error: objects[path] ? null : { message: "Object not found", statusCode: "404" },
        }),
        upload: async (path: string) => {
          uploads.push(path);
          return { error: null };
        },
      }),
    },
  };
  const { readObject, writeObject } = await import("../src/lib/cloud");
  // JSON storage drops `undefined` members, so compare the serialized form.
  const stored = JSON.parse(JSON.stringify(screening)) as unknown;
  expect(stableCacheJson(await readObject("owner/cache/screening/latest.json"))).toBe(
    stableCacheJson(stored),
  );
  // A plain dashboard pointer is still readable...
  expect(await readObject("owner/cache/dashboard/latest.json")).toEqual(
    JSON.parse(JSON.stringify(summary)),
  );
  // ...and the next write moves it to the compressed object.
  await writeObject("owner/cache/dashboard/latest.json", { version: "v2" });
  expect(uploads).toEqual(["owner/cache/dashboard/latest.json.gz"]);
  // Objects outside the two pointers keep their plain path.
  await writeObject("owner/results/screening/latest.json", { run: "x" });
  expect(uploads).toEqual([
    "owner/cache/dashboard/latest.json.gz",
    "owner/results/screening/latest.json",
  ]);
});
