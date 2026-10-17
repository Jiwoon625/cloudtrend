import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActiveSourceRecord } from "./screeningSources.server";
import { stableCacheJson } from "./screeningCacheContract";
const mock = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("./engine/manualDataset", () => ({ parseManualMarketData: mock.parse }));
import { getCachedActualPriceInputs } from "./portfolioLedgers.server";
const digest = (value: unknown) =>
  createHash("sha256").update(stableCacheJson(value)).digest("hex");
const evidence = {
  bars: { "0046A0": [{ tradeDate: "2026-10-16", close: 9230 }] },
  marketDates: [],
};
beforeEach(() => {
  mock.parse.mockReset().mockReturnValue({
    dataset: {
      instruments: [{ symbol: "0046A0", market: "ETF" }],
      bars: evidence.bars,
      tradeDates: [],
    },
  });
});
function storage() {
  const files = new Map<string, Blob>();
  const download = vi.fn(async (path: string) => ({
    data: files.get(path) ?? null,
    error: files.has(path) ? null : { statusCode: "404", message: "not found" },
  }));
  const upload = vi.fn(async (path: string, bytes: Uint8Array) => {
    files.set(path, new Blob([new Uint8Array(bytes)]));
    return { error: null };
  });
  return {
    files,
    download,
    upload,
    client: { storage: { from: () => ({ download, upload }) } } as unknown as SupabaseClient,
  };
}
it("reuses verified compressed evidence without reparsing or reuploading", async () => {
  const s = storage();
  await getCachedActualPriceInputs(s.client, "owner-a", [], new Set(["0046A0"]), "2026-10-12");
  expect(
    await getCachedActualPriceInputs(s.client, "owner-a", [], new Set(["0046A0"]), "2026-10-12"),
  ).toEqual(evidence);
  expect(mock.parse).toHaveBeenCalledTimes(1);
  expect(s.upload).toHaveBeenCalledTimes(1);
});
it("binds evidence to owner, date boundary and normalized holdings", async () => {
  const s = storage();
  for (const [owner, from, symbols] of [
    ["a", "2026-10-12", ["B", "0046A0"]],
    ["a", "2026-10-12", ["0046A0", "B"]],
    ["b", "2026-10-12", ["0046A0", "B"]],
    ["a", "2026-10-13", ["0046A0", "B"]],
    ["a", "2026-10-12", ["0046A0"]],
  ] as const)
    await getCachedActualPriceInputs(s.client, owner, [], new Set(symbols), from);
  const paths = s.download.mock.calls.map(([path]) => path);
  expect(paths[0]).toBe(paths[1]);
  expect(new Set(paths).size).toBe(4);
});
it("invalidates for source content changes and source precedence", async () => {
  const s = storage();
  const source = (id: string, bytes: string) => {
    s.files.set(`raw/${id}`, new Blob([bytes]));
    return {
      id,
      file_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      storage_bucket: "test",
      storage_path: `raw/${id}`,
      activated_at: "2026-10-17",
      created_at: "2026-10-17",
    } as ActiveSourceRecord;
  };
  const a = source("a", "test-a"),
    b = source("b", "test-b");
  for (const sources of [
    [a, b],
    [b, a],
    [source("a", "revised-a"), b],
  ]) {
    // Restore the historical fixture bytes for each synthetic source request.
    s.files.set(
      "raw/a",
      new Blob([sources.some((x) => x.file_hash === a.file_hash) ? "test-a" : "revised-a"]),
    );
    await getCachedActualPriceInputs(
      s.client,
      "source-owner",
      sources,
      new Set(["0046A0"]),
      "2026-10-12",
    );
  }
  expect(new Set(s.upload.mock.calls.map(([path]) => path)).size).toBe(3);
});
it("rejects corrupted content even at the expected cache path", async () => {
  const s = storage();
  await getCachedActualPriceInputs(
    s.client,
    "corrupt-owner",
    [],
    new Set(["0046A0"]),
    "2026-10-12",
  );
  const path = s.upload.mock.calls[0]![0];
  s.files.set(
    path,
    new Blob([
      gzipSync(
        JSON.stringify({
          version: "actual-holding-price-inputs-20261017-v1",
          key: path.split("/").at(-1)!.replace(".json.gz", ""),
          from: "2026-10-12",
          symbols: ["0046A0"],
          digest: digest(evidence),
          ...evidence,
          bars: { "0046A0": [{ tradeDate: "2026-10-16", close: 1 }] },
        }),
      ),
    ]),
  );
  expect(
    await getCachedActualPriceInputs(
      s.client,
      "corrupt-owner",
      [],
      new Set(["0046A0"]),
      "2026-10-12",
    ),
  ).toEqual(evidence);
  expect(mock.parse).toHaveBeenCalledTimes(2);
});
