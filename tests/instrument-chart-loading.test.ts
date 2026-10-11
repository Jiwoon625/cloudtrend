import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { loadActiveSources, type ActiveSourceRecord } from "../src/lib/screeningSources.server";
import { instrumentChartQueryRevision } from "../src/lib/instrumentChartCache";
import type { AnalysisPayload } from "../src/lib/market.functions";

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
