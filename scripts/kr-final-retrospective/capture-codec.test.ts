import { describe, it, expect } from "vitest";
import { captureCanonicalProof, encodeFinalCapture, hydrateFinalCapture } from "./capture-codec";
import type { FinalCaptureV1 } from "./contracts";
import { canonicalSeriesJson, hashSeriesValue } from "../../src/lib/ledger/modelSeries";
it("streaming proof uses exactly the existing canonical UTF8 byte domain", async () => {
  const iterable = [1, 2, 3];
  iterable[Symbol.iterator] = function* () {
    yield 3;
    yield 1;
    return undefined;
  };
  const values = [
    null,
    true,
    -0,
    1e-100,
    1e100,
    "한글😀\ud800",
    { z: "é".repeat(70000), a: [1, false, null] },
    iterable,
  ];
  for (const value of values) {
    expect(captureCanonicalProof(value)).toEqual({
      hash: await hashSeriesValue(value),
      bytes: Buffer.byteLength(canonicalSeriesJson(value)),
    });
  }
  for (const value of [
    undefined,
    Infinity,
    NaN,
    new Date(),
    new Map(),
    Object.create(null),
    Array(2),
  ])
    expect(() => captureCanonicalProof(value)).toThrow();
});
it("codec diagnostics expose only fixed statuses and numeric byte counts", async () => {
  const events: unknown[] = [];
  const value = await encodeFinalCapture(fixture(), (event) => events.push(event));
  expect(events).toEqual([
    { status: "CAPTURE_CODEC_ORIGINAL_BYTES", bytes: captureCanonicalProof(fixture()).bytes },
    { status: "CAPTURE_CODEC_STORED_BYTES", bytes: captureCanonicalProof(value).bytes },
    { status: "CAPTURE_CODEC_ROUNDTRIP_VERIFIED" },
  ]);
  expect(JSON.stringify(events)).not.toContain("00000000-0000");
  expect(JSON.stringify(events)).not.toContain("123ABC");
});
it("legacy v1 hydration retains the same 256MiB admission bound", async () => {
  const value = fixture();
  value.preservationBaseline = { padding: Array(130).fill("x".repeat(2 * 1024 * 1024)) };
  await expect(hydrateFinalCapture(value)).rejects.toThrow("CAPTURE_CODEC_REJECTED");
}, 30000);
function fixture(): FinalCaptureV1 {
  const observed = [
    {
      tradeDate: "2026-10-27",
      open: 10,
      close: 10,
      volume: 100,
      marketCap: null,
      openObserved: true,
    },
    { tradeDate: "2026-10-28", open: 11, close: 0, volume: 0, marketCap: null, openObserved: true },
    {
      tradeDate: "2026-10-29",
      open: 12,
      close: 13,
      volume: 123,
      marketCap: 1000,
      etfUnderlyingIndexClose: null,
      etfUnderlyingIndexName: "지수",
      etfMarketCap: 1500,
      etfTradingValue: 1599,
      priceSource: "KRX_ETF",
    },
  ];
  return {
    version: "kr-final-retrospective-capture-v1",
    owner: "00000000-0000-0000-0000-000000000001",
    codeCommit: "a".repeat(40),
    runtimeHashes: { october: "sha256:" + "1".repeat(64), kospi: "sha256:" + "2".repeat(64) },
    capturedAt: "2026-10-30T01:00:00Z",
    computedAt: "2026-10-30T01:00:01Z",
    sourceManifest: [{ full: "kept" }],
    captureManifest: { full: "kept" },
    preservationBaseline: { full: "kept" },
    finalPublication: {
      hash: "sha256:" + "3".repeat(64),
      activatedAt: "2026-10-30T00:39:00Z",
      asOfDate: "2026-10-29",
    },
    dataset: {
      provider: "MANUAL_INPUT",
      asOfDate: "2026-10-29",
      bars: { "123ABC": [structuredClone(observed[0]), structuredClone(observed[2])], EMPTY: [] },
      observedBars: { "123ABC": observed, EMPTY: [] },
      otherOriginalField: { nested: "preserved", null: null },
    },
    config: { untouched: true },
    sourceVintageApproval: { untouched: true },
    predecessors: [],
    archives: [],
    legacyObjects: {},
  } as unknown as FinalCaptureV1;
}
describe("lossless bounded capture codec", () => {
  it("restores exactfull capture and dataset with zeros ETFnullablefields emptyseries and order intact", async () => {
    const c = fixture(),
      before = canonicalSeriesJson(c),
      p = await encodeFinalCapture(c),
      restored = await hydrateFinalCapture(p);
    expect(p.dataset.barIndices).toEqual({ "123ABC": [0, 2], EMPTY: [] });
    expect(canonicalSeriesJson(restored)).toBe(before);
    expect(canonicalSeriesJson(c)).toBe(before);
    expect(p.decodedCaptureHash).toBe(await hashSeriesValue(c));
    expect(p.dataset.datasetHash).toBe(await hashSeriesValue(c.dataset));
    expect(await hashSeriesValue(p)).not.toBe(await hashSeriesValue(c));
    expect(p.dataset.dataset).not.toHaveProperty("bars");
    expect(p.dataset.dataset.observedBars?.["123ABC"]?.[1]?.close).toBe(0);
  });
  it("preserves backward-compatible V1 including omitted observedBars", async () => {
    const c = fixture();
    delete c.dataset.observedBars;
    expect(await hydrateFinalCapture(c)).toBe(c);
    await expect(encodeFinalCapture(c)).rejects.toThrow();
  });
  it("rejects nonmatching analytical value and reordered bars onencode", async () => {
    for (const mode of ["value", "order"]) {
      const c = fixture();
      if (mode === "value") c.dataset.bars["123ABC"]![0]!.close = 999;
      else c.dataset.bars["123ABC"]!.reverse();
      await expect(encodeFinalCapture(c)).rejects.toThrow();
    }
  });
  it.each([[0, 0], [2, 0], [-1], [0.5], [3], [0, 2, 3]].map((indices) => ({ indices })))(
    "rejects duplicate reordered negative fractional and outofrange indices %j",
    async ({ indices }) => {
      const p = await encodeFinalCapture(fixture());
      p.dataset.barIndices["123ABC"] = indices;
      await expect(hydrateFinalCapture(p)).rejects.toThrow();
    },
  );
  it("rejects missing or extra symbol maps", async () => {
    for (const mode of ["missing", "extra"]) {
      const p = await encodeFinalCapture(fixture());
      if (mode === "missing") delete p.dataset.barIndices.EMPTY;
      else p.dataset.barIndices.EXTRA = [];
      await expect(hydrateFinalCapture(p)).rejects.toThrow();
    }
  });
  it("rejects unknown capture/envelope keys and embedded analyticalbars", async () => {
    for (const target of ["capture", "codec", "dataset"]) {
      const p = await encodeFinalCapture(fixture());
      Object.assign(
        target === "capture" ? p : target === "codec" ? p.dataset : p.dataset.dataset,
        target === "dataset" ? { bars: {} } : { unexpected: true },
      );
      await expect(hydrateFinalCapture(p)).rejects.toThrow();
    }
  });
  it("rejects hash and preserved evidence tampering", async () => {
    for (const target of ["datasetHash", "decodedHash", "baseline", "observation"]) {
      const p = await encodeFinalCapture(fixture());
      if (target === "datasetHash") p.dataset.datasetHash = `sha256:${"f".repeat(64)}`;
      if (target === "decodedHash") p.decodedCaptureHash = `sha256:${"f".repeat(64)}`;
      if (target === "baseline") p.preservationBaseline = { changed: true };
      if (target === "observation") p.dataset.dataset.observedBars!["123ABC"]![2]!.close = 99;
      await expect(hydrateFinalCapture(p)).rejects.toThrow();
    }
  });
  it("rejects sparse undefined nonfinite and nonplain original JSON", async () => {
    for (const bad of [undefined, Infinity, new Date()]) {
      const c = fixture();
      c.preservationBaseline = { bad };
      await expect(encodeFinalCapture(c)).rejects.toThrow();
    }
    const c = fixture();
    delete c.dataset.bars["123ABC"]![0];
    await expect(encodeFinalCapture(c)).rejects.toThrow();
  });
});

describe("bounded canonical UTF8 stream equivalence", () => {
  it("matches existing canonical bytes/hash acrossUnicode primitives nestedJSON and chunkboundaries", async () => {
    const { captureCanonicalChunks, captureCanonicalProof } = await import("./capture-codec");
    for (const value of [
      null,
      true,
      false,
      0,
      -0,
      1.25,
      1e30,
      "한글😀\ud800" + String.fromCharCode(92, 34, 10),
      { z: ["😀".repeat(40000), null, false], a: { 가: 1 } },
      Array.from({ length: 1000 }, (_, i) => ({ z: i, a: [null, "한😀", i / 3] })),
    ]) {
      const chunks = [...captureCanonicalChunks(value)],
        bytes = Buffer.concat(chunks);
      expect(chunks.every((x) => x.length > 0 && x.length <= 65536)).toBe(true);
      expect(bytes.toString()).toBe(canonicalSeriesJson(value));
      expect(captureCanonicalProof(value)).toEqual({
        hash: await hashSeriesValue(value),
        bytes: Buffer.byteLength(canonicalSeriesJson(value)),
      });
    }
  });
  it("preserves Array.from customiterator immediatevisits and arraylikefallback semantics", async () => {
    const { captureCanonicalChunks } = await import("./capture-codec");
    const make = () => {
      const a: number[] = [];
      a[Symbol.iterator] = function* () {
        yield 9;
        yield 3;
        return undefined;
      };
      return a;
    };
    expect(Buffer.concat([...captureCanonicalChunks(make())]).toString()).toBe(
      canonicalSeriesJson(make()),
    );
    const makeMutable = () => {
      const a: unknown[] = [];
      a[Symbol.iterator] = function* () {
        const x = { n: 1 };
        yield x;
        x.n = 2;
        yield x;
        return undefined;
      };
      return a;
    };
    expect(Buffer.concat([...captureCanonicalChunks(makeMutable())]).toString()).toBe(
      canonicalSeriesJson(makeMutable()),
    );
    const fallback = [1, 2];
    Object.defineProperty(fallback, Symbol.iterator, { value: null });
    expect(Buffer.concat([...captureCanonicalChunks(fallback)]).toString()).toBe(
      canonicalSeriesJson(fallback),
    );
  });
  it("rejects sparsearrays undefined nonfinite cycles andnonplainvalues", async () => {
    const { captureCanonicalProof } = await import("./capture-codec");
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const value of [
      Array(2),
      undefined,
      NaN,
      Infinity,
      new Date(),
      Object.create(null),
      cycle,
    ])
      expect(() => captureCanonicalProof(value)).toThrow();
  });
});
