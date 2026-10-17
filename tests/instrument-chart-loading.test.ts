import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { loadActiveSources, type ActiveSourceRecord } from "../src/lib/screeningSources.server";
import { instrumentChartQueryRevision } from "../src/lib/instrumentChartCache";
import type { AnalysisPayload } from "../src/lib/marketPayload";

function sourceClient() {
  const bodies = [
    new TextEncoder().encode("older,first"),
    new Uint8Array([0xb0, 0xa1]),
    new TextEncoder().encode("newer,third"),
    new TextEncoder().encode("newest,last"),
  ];
  const sources = bodies.map((bytes, index) => ({
    id: String(index),
    original_filename: `file-${index}.csv`,
    storage_bucket: "cloudtrend-data",
    storage_path: `owner/source-${index}.csv`,
    file_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  })) as ActiveSourceRecord[];
  let active = 0,
    peak = 0;
  const download = vi.fn(async (path: string) => {
    const index = sources.findIndex((s) => s.storage_path === path);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 15 : 1));
    active--;
    return { data: new Blob([bodies[index]! as BlobPart]), error: null };
  });
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    then(resolve: (value: unknown) => unknown) {
      return Promise.resolve({ data: sources, error: null }).then(resolve);
    },
  };
  const client = {
    from: () => query,
    storage: { from: vi.fn(() => ({ download })) },
  } as unknown as Parameters<typeof loadActiveSources>[0];
  return { client, sources, bodies, download, query, peak: () => peak };
}

test("chart opt-in downloads are bounded and preserve source precedence, byte hashes and decoding", async () => {
  const serial = sourceClient(),
    parallel = sourceClient();
  const expected = await loadActiveSources(serial.client, "owner");
  const actual = await loadActiveSources(parallel.client, "owner", 3);
  expect(serial.peak()).toBe(1);
  expect(parallel.peak()).toBe(3);
  expect(actual).toEqual(expected);
  expect(actual.texts).toEqual(["older,first", "가", "newer,third", "newest,last"]);
  expect(parallel.query.eq).toHaveBeenCalledWith("user_id", "owner");
  expect(parallel.query.order.mock.calls).toEqual(serial.query.order.mock.calls);
  expect(parallel.download.mock.calls).toEqual(serial.download.mock.calls);
  const capped = sourceClient();
  await loadActiveSources(capped.client, "owner", 100);
  expect(capped.peak()).toBe(3);
});

test("parallel source loading rejects hash corruption and returns no partial texts", async () => {
  const source = sourceClient();
  source.sources[1]!.file_hash = "sha256:incorrect";
  await expect(loadActiveSources(source.client, "owner", 3)).rejects.toThrow(
    "해시가 등록정보와 다릅니다",
  );
});

test("React query revisions separate different analysis objects with equal timestamps", () => {
  const a = { analysis: { calculatedAt: "same" } } as AnalysisPayload;
  const b = { analysis: { calculatedAt: "same" } } as AnalysisPayload;
  expect(instrumentChartQueryRevision(a)).toBe(instrumentChartQueryRevision(a));
  expect(instrumentChartQueryRevision(b)).not.toBe(instrumentChartQueryRevision(a));
});

test("optional source transform receives verified original bytes and source metadata without decoding", async () => {
  const source = sourceClient();
  const originalBodies = source.bodies.map((bytes) => Array.from(bytes));
  const transform = vi.fn(async (bytes: Uint8Array, record: ActiveSourceRecord) => {
    expect(record).toBe(source.sources[Number(record.id)]);
    expect(Array.from(bytes)).toEqual(originalBodies[Number(record.id)]);
    return `canonical-${record.id}`;
  });
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  try {
    const result = await loadActiveSources(source.client, "owner", undefined, transform);
    expect(result.sources).toEqual(source.sources);
    expect(result.texts).toEqual(["canonical-0", "canonical-1", "canonical-2", "canonical-3"]);
    expect(transform).toHaveBeenCalledTimes(4);
    expect(Array.from(transform.mock.calls[1]![0])).toEqual([0xb0, 0xa1]);
    // Other failed concurrent batches may still finish; inspect only this call's byte objects.
    const transformedBytes = new Set(transform.mock.calls.map(([bytes]) => bytes));
    expect(
      decode.mock.calls.filter(([bytes]) => transformedBytes.has(bytes as Uint8Array)),
    ).toEqual([]);
    expect(source.peak()).toBe(1);
  } finally {
    decode.mockRestore();
  }
});

test("hash failure rejects original bytes before invoking the optional transform", async () => {
  const source = sourceClient();
  source.sources[0]!.file_hash = "sha256:incorrect";
  const transform = vi.fn(async () => "canonical");
  await expect(loadActiveSources(source.client, "owner", undefined, transform)).rejects.toThrow(
    "해시가 등록정보와 다릅니다",
  );
  expect(transform).not.toHaveBeenCalled();
  expect(source.download).toHaveBeenCalledTimes(1);
});

test("default sequential loading finishes each transform before downloading the next raw source", async () => {
  const source = sourceClient();
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let finishFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const calls: string[] = [];
  const result = loadActiveSources(source.client, "owner", undefined, async (_bytes, record) => {
    calls.push(record.id);
    if (record.id === "0") {
      firstStarted();
      await gate;
    }
    return `canonical-${record.id}`;
  });
  await started;
  expect(source.download).toHaveBeenCalledTimes(1);
  expect(calls).toEqual(["0"]);
  finishFirst();
  expect((await result).texts).toEqual([
    "canonical-0",
    "canonical-1",
    "canonical-2",
    "canonical-3",
  ]);
  expect(calls).toEqual(["0", "1", "2", "3"]);
});

test("parallel transforms stay bounded and retain registry order regardless of completion order", async () => {
  const source = sourceClient();
  let active = 0,
    peak = 0;
  const finished: string[] = [];
  const result = await loadActiveSources(source.client, "owner", 100, async (bytes, record) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, record.id === "0" ? 40 : 30));
    active--;
    finished.push(record.id);
    return `${record.id}:${Array.from(bytes).join(",")}`;
  });
  expect(source.peak()).toBe(3);
  expect(peak).toBeLessThanOrEqual(3);
  expect(finished.indexOf("1")).toBeLessThan(finished.indexOf("0"));
  expect(finished.at(-1)).toBe("3");
  expect(result.texts).toEqual(
    source.bodies.map((bytes, i) => `${i}:${Array.from(bytes).join(",")}`),
  );
  expect(result.sources).toEqual(source.sources);
});

test("transform failures return no partial result and stop subsequent sequential downloads", async () => {
  const source = sourceClient();
  const transform = vi.fn(async () => {
    throw new Error("canonical validation failed");
  });
  await expect(loadActiveSources(source.client, "owner", 1, transform)).rejects.toThrow(
    "canonical validation failed",
  );
  expect(transform).toHaveBeenCalledTimes(1);
  expect(source.download).toHaveBeenCalledTimes(1);
});

test("an explicit absent transform preserves the original default UTF-8 and EUC-KR decoding", async () => {
  const implicit = sourceClient(),
    explicit = sourceClient();
  expect(await loadActiveSources(explicit.client, "owner", 1, undefined)).toEqual(
    await loadActiveSources(implicit.client, "owner"),
  );
});
