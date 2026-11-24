import { gzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  downloadStorageObject,
  isStorageObjectMissing,
  isTransientStorageReadError,
  type StorageReadErrorLike,
} from "../src/lib/storageReadRetry";
import { readChartBundle } from "../src/lib/instrumentChartStore.server";
import { warmFullInstrumentCharts } from "../src/lib/fullInstrumentCharts.server";
import { warmRecentEtfCharts } from "../src/lib/instrumentChartStore.server";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { createEtfChartFixture, ETF_CHART_TEST_SYMBOL } from "./fixtures/etf-chart-fixture";
import { chartPath } from "../src/lib/instrumentChartContract";

type RawDownload = { data: Blob | null; error: StorageReadErrorLike | null };

const ok = (body: string): RawDownload => ({ data: new Blob([body]), error: null });

function blobOf(value: unknown) {
  const compressed = gzipSync(JSON.stringify(value));
  return { data: new Blob([new Uint8Array(compressed)]), error: null } satisfies RawDownload;
}

/** Minimal Supabase Storage client whose download answers follow a script. */
function scriptedStorage(...steps: Array<RawDownload | Error | "hang">) {
  let calls = 0;
  const download = vi.fn(async (_path: string): Promise<RawDownload> => {
    const step = steps[Math.min(calls, steps.length - 1)]!;
    calls += 1;
    if (step === "hang") return new Promise<RawDownload>(() => {});
    if (step instanceof Error) throw step;
    return step;
  });
  const client = { storage: { from: () => ({ download }) } } as unknown as SupabaseClient;
  return { client, download, callCount: () => calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("transient storage read classification", () => {
  test.each<[string, StorageReadErrorLike, boolean]>([
    ["intermittent CDN 403", { statusCode: "403", message: "Forbidden" }, true],
    ["numeric 403", { statusCode: 403, message: "Forbidden" }, true],
    ["rate limited", { statusCode: "429", message: "Too Many Requests" }, true],
    ["gateway 502 by message", { message: "Bad gateway" }, true],
    ["storage 503", { statusCode: "503", message: "Service Unavailable" }, true],
    ["opaque <none>", { message: "<none>" }, true],
    ["opaque empty message", { message: "" }, true],
    ["opaque null body", { message: "<none>", statusCode: undefined }, true],
    ["network failure", { message: "fetch failed" }, true],
    ["socket reset", { message: "read ECONNRESET" }, true],
    ["request timeout", { statusCode: "408", message: "Request Timeout" }, true],
    ["real 404", { statusCode: "404", message: "Object not found" }, false],
    ["404 by message", { message: "Object not found" }, false],
    ["invalid request", { statusCode: "400", message: "Bad Request" }, false],
    ["unauthorized", { statusCode: "401", message: "Unauthorized" }, false],
    ["gone", { statusCode: "410", message: "Gone" }, false],
  ])("%s", (_label, error, expected) => {
    expect(isTransientStorageReadError(error)).toBe(expected);
  });

  test("only a genuine absence counts as missing", () => {
    expect(isStorageObjectMissing({ statusCode: "404", message: "Object not found" })).toBe(true);
    expect(isStorageObjectMissing({ message: "Object not found" })).toBe(true);
    expect(isStorageObjectMissing({ statusCode: "403", message: "Forbidden" })).toBe(false);
    expect(isStorageObjectMissing({ message: "<none>" })).toBe(false);
  });
});

describe("read retry with backoff", () => {
  test("a transient 403 that clears is retried and succeeds", async () => {
    const sleeps: number[] = [];
    const { client, download } = scriptedStorage(
      { data: null, error: { statusCode: "403", message: "Forbidden" } },
      { data: null, error: { message: "<none>" } },
      blobOf({ ready: true }),
    );
    const outcome = await downloadStorageObject(client, "bucket", "owner/a.json.gz", {
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.attempts).toBe(3);
    expect(download).toHaveBeenCalledTimes(3);
    // 500ms then 1000ms; the 2000ms slot is never needed.
    expect(sleeps).toEqual([500, 1000]);
  });

  test("three retries then the last error is reported", async () => {
    const sleeps: number[] = [];
    const onRetry = vi.fn();
    const { client, download } = scriptedStorage({
      data: null,
      error: { statusCode: "403", message: "Forbidden" },
    });
    const outcome = await downloadStorageObject(client, "bucket", "owner/a.json.gz", {
      sleep: async (ms) => void sleeps.push(ms),
      onRetry,
    });
    expect(outcome).toMatchObject({ status: "failed", attempts: 4 });
    if (outcome.status === "failed")
      expect(outcome.error).toMatchObject({ statusCode: "403", message: "Forbidden" });
    expect(download).toHaveBeenCalledTimes(4);
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  test("a missing object returns at once without retrying", async () => {
    const { client, download } = scriptedStorage({
      data: null,
      error: { statusCode: "404", message: "Object not found" },
    });
    expect(await downloadStorageObject(client, "bucket", "owner/a.json.gz")).toMatchObject({
      status: "missing",
      attempts: 1,
    });
    expect(download).toHaveBeenCalledTimes(1);
  });

  test("a non-transient client error is not swallowed by retries", async () => {
    const { client, download } = scriptedStorage({
      data: null,
      error: { statusCode: "400", message: "Bad Request" },
    });
    expect(await downloadStorageObject(client, "bucket", "owner/a.json.gz")).toMatchObject({
      status: "failed",
      attempts: 1,
    });
    expect(download).toHaveBeenCalledTimes(1);
  });

  test("a request that never answers is abandoned and retried", async () => {
    const { client, download } = scriptedStorage("hang");
    const outcome = await downloadStorageObject(client, "bucket", "owner/a.json.gz", {
      timeoutMs: 5,
      delaysMs: [0, 0, 0],
    });
    expect(outcome).toMatchObject({ status: "failed", attempts: 4 });
    if (outcome.status === "failed") expect(String(outcome.error.statusCode)).toBe("408");
    expect(download).toHaveBeenCalledTimes(4);
  });

  test("a thrown network error is retried like a returned one", async () => {
    const { client } = scriptedStorage(
      new Error("fetch failed"),
      { data: null, error: { message: "<none>" } },
      blobOf({ ready: true }),
    );
    expect(
      await downloadStorageObject(client, "bucket", "owner/a.json.gz", { delaysMs: [0, 0, 0] }),
    ).toMatchObject({ status: "ok", attempts: 3 });
  });

  test("a retry can be disabled explicitly", async () => {
    const { client, download } = scriptedStorage({
      data: null,
      error: { statusCode: "503", message: "Service Unavailable" },
    });
    expect(
      await downloadStorageObject(client, "bucket", "owner/a.json.gz", { retries: 0 }),
    ).toMatchObject({ status: "failed", attempts: 1 });
    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe("chart bundle read", () => {
  const identity = { inputFingerprint: "a".repeat(64), resultDigest: "b".repeat(64) };

  test("a single flaky read no longer fails the bundle and the parsed data is returned", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = scriptedStorage(
      { data: null, error: { statusCode: "403", message: "Forbidden" } },
      blobOf({ [ETF_CHART_TEST_SYMBOL]: { chart: [] } }),
    );
    const bundle = await readChartBundle<{ chart: unknown[] }>(
      client,
      "owner",
      chartPath(identity, ETF_CHART_TEST_SYMBOL, "all", "etf"),
      { delaysMs: [0, 0, 0] },
    );
    expect(Object.keys(bundle ?? {})).toEqual([ETF_CHART_TEST_SYMBOL]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("재시도"));
  });

  test("exhausted retries still surface the storage failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = scriptedStorage({
      data: null,
      error: { statusCode: "403", message: "Forbidden" },
    });
    await expect(
      readChartBundle(client, "owner", chartPath(identity, "005930", "all", "scored"), {
        delaysMs: [0, 0, 0],
      }),
    ).rejects.toThrow("차트 캐시 읽기 실패: Forbidden (4회 시도)");
  });

  test("a genuinely absent bundle is still null, not an error", async () => {
    const { client, download } = scriptedStorage({
      data: null,
      error: { statusCode: "404", message: "Object not found" },
    });
    expect(
      await readChartBundle(client, "owner", chartPath(identity, "005930", "all", "scored")),
    ).toBeNull();
    expect(download).toHaveBeenCalledTimes(1);
  });

  test("corrupt content is regenerated instead of retried", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, download } = scriptedStorage(ok("not gzip at all"));
    expect(
      await readChartBundle(client, "owner", chartPath(identity, "005930", "all", "scored")),
    ).toBeNull();
    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe("full-history verification", () => {
  test("one transient 403 during readback is retried and the run still verifies", async () => {
    const ctx = {
      ...runFullMarketAnalysis(createEtfChartFixture(140), DEFAULT_SCORING_CONFIG),
      config: DEFAULT_SCORING_CONFIG,
    };
    const identity = { inputFingerprint: "c".repeat(64), resultDigest: "d".repeat(64) };
    const files = new Map<string, Uint8Array>();
    const upload = vi.fn(async (key: string, value: Uint8Array) => {
      files.set(key, value);
      return { error: null };
    });
    const original = async (key: string): Promise<RawDownload> =>
      files.has(key)
        ? { data: new Blob([files.get(key)! as BlobPart]), error: null }
        : { data: null, error: { statusCode: "404", message: "Object not found" } };
    const fullPath = `owner/${chartPath(identity, ETF_CHART_TEST_SYMBOL, "all", "etf")}`;
    let fullReads = 0;
    const download = vi.fn(async (key: string) => {
      // First read is prepareChartBucket's cache probe, the second is the readback.
      if (key === fullPath && ++fullReads === 2)
        return { data: null, error: { statusCode: "403", message: "Forbidden" } };
      return original(key);
    });
    const client = { storage: { from: () => ({ upload, download }) } } as unknown as SupabaseClient;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await warmRecentEtfCharts(client, "owner", identity, ctx);
    const coverage = await warmFullInstrumentCharts(client, "owner", identity, ctx);

    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toMatchObject({ symbol: ETF_CHART_TEST_SYMBOL, kind: "ETF", points: 140 });
    expect(fullReads).toBeGreaterThanOrEqual(3);
  });
});
