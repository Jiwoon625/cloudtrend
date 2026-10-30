/** Pure lossless representation only. No dates/values/fields are rounded, filtered or repaired. */
import { canonicalSeriesJson, type SeriesHash } from "../../src/lib/ledger/modelSeries";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { MarketDataset } from "../../src/lib/engine/dataset";
import type { FinalCapture, FinalCaptureV1, FinalCaptureV2 } from "./contracts";
export type CaptureCodecDiagnostic = {
  status:
    | "CAPTURE_CODEC_ORIGINAL_BYTES"
    | "CAPTURE_CODEC_STORED_BYTES"
    | "CAPTURE_CODEC_ROUNDTRIP_VERIFIED";
  bytes?: number;
};
/** Exact existing canonicalSeriesJson UTF8 bytes in bounded chunks, with no whole-capture string. */
export function* captureCanonicalChunks(value: unknown): Generator<Buffer> {
  const ancestors = new Set<object>();
  function* tokens(v: unknown): Generator<string> {
    if (v === null || typeof v === "string" || typeof v === "boolean") {
      yield JSON.stringify(v);
      return;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      yield JSON.stringify(v);
      return;
    }
    if (Array.isArray(v)) {
      check(!ancestors.has(v));
      ancestors.add(v);
      yield "[";
      let first = true;
      // Array.from(value, canonicalSeriesJson) visits iterator values immediately.
      // Preserve that order, including custom iterators and its array-like fallback.
      if (v[Symbol.iterator] == null) {
        const length = v.length;
        for (let i = 0; i < length; i++) {
          if (!first) yield ",";
          first = false;
          yield* tokens(v[i]);
        }
      } else {
        for (const item of v) {
          if (!first) yield ",";
          first = false;
          yield* tokens(item);
        }
      }
      yield "]";
      ancestors.delete(v);
      return;
    }
    check(plain(v) && !ancestors.has(v));
    ancestors.add(v);
    yield "{";
    let first = true;
    for (const key of Object.keys(v).sort()) {
      if (!first) yield ",";
      first = false;
      yield JSON.stringify(key);
      yield ":";
      yield* tokens(v[key]);
    }
    yield "}";
    ancestors.delete(v);
  }
  let parts: string[] = [],
    pending = 0;
  for (const token of tokens(value)) {
    parts.push(token);
    pending += Buffer.byteLength(token);
    if (pending >= 65536) {
      const data = Buffer.from(parts.join(""));
      parts = [];
      pending = 0;
      for (let i = 0; i < data.length; i += 65536)
        yield data.subarray(i, Math.min(i + 65536, data.length));
    }
  }
  if (parts.length) {
    const data = Buffer.from(parts.join(""));
    for (let i = 0; i < data.length; i += 65536)
      yield data.subarray(i, Math.min(i + 65536, data.length));
  }
}
export function captureCanonicalProof(value: unknown): { hash: SeriesHash; bytes: number } {
  const digest = createHash("sha256");
  let bytes = 0;
  for (const chunk of captureCanonicalChunks(value)) {
    bytes += chunk.length;
    digest.update(chunk);
  }
  return { hash: ("sha256:" + digest.digest("hex")) as SeriesHash, bytes };
}
const LIMIT = 256 * 1024 * 1024;
const HASH = /^sha256:[a-f0-9]{64}$/;
const V1_KEYS = [
  "version",
  "owner",
  "codeCommit",
  "runtimeHashes",
  "capturedAt",
  "computedAt",
  "sourceManifest",
  "captureManifest",
  "preservationBaseline",
  "finalPublication",
  "dataset",
  "config",
  "sourceVintageApproval",
  "predecessors",
  "archives",
  "legacyObjects",
];
function check(ok: unknown): asserts ok {
  if (!ok) throw Error("CAPTURE_CODEC_REJECTED");
}
function plain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}
function keys(v: unknown, expected: string[]) {
  check(
    plain(v) &&
      canonicalSeriesJson(Object.keys(v).sort()) === canonicalSeriesJson([...expected].sort()),
  );
}
function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>) {
  check(canonicalSeriesJson(Object.keys(a).sort()) === canonicalSeriesJson(Object.keys(b).sort()));
}
function validateOriginal(c: FinalCaptureV1) {
  keys(c, V1_KEYS);
  check(
    c.version === "kr-final-retrospective-capture-v1" && plain(c.dataset) && plain(c.dataset.bars),
  );
}
function encodedSize(c: FinalCapture, emit?: (event: CaptureCodecDiagnostic) => void) {
  const { bytes } = captureCanonicalProof(c);
  emit?.({ status: "CAPTURE_CODEC_STORED_BYTES", bytes });
  check(bytes > 0 && bytes <= LIMIT);
  return bytes;
}
export async function encodeFinalCapture(
  original: FinalCaptureV1,
  emit?: (event: CaptureCodecDiagnostic) => void,
): Promise<FinalCaptureV2> {
  validateOriginal(original);
  check(plain(original.dataset.observedBars));
  sameKeys(original.dataset.bars, original.dataset.observedBars);
  // Canonical hashing also rejects undefined, nonfinite values, sparse arrays and nonplain JSON.
  const originalProof = captureCanonicalProof(original);
  emit?.({ status: "CAPTURE_CODEC_ORIGINAL_BYTES", bytes: originalProof.bytes });
  const decodedCaptureHash = originalProof.hash,
    datasetHash = captureCanonicalProof(original.dataset).hash;
  const observed = original.dataset.observedBars!;
  const entries: Array<[string, number[]]> = [];
  for (const symbol of Object.keys(original.dataset.bars)) {
    const bars = original.dataset.bars[symbol]!,
      all = observed[symbol]!;
    check(Array.isArray(bars) && Array.isArray(all));
    const indices: number[] = [];
    let cursor = 0;
    for (const bar of bars) {
      const exact = canonicalSeriesJson(bar);
      while (cursor < all.length && canonicalSeriesJson(all[cursor]) !== exact) cursor++;
      check(cursor < all.length);
      indices.push(cursor++);
    }
    entries.push([symbol, indices]);
  }
  const { bars: _bars, ...dataset } = original.dataset;
  void _bars;
  const encoded: FinalCaptureV2 = {
    ...original,
    version: "kr-final-retrospective-capture-v2",
    dataset: {
      version: "kr-final-retrospective-bars-index-v1",
      dataset,
      barIndices: Object.fromEntries(entries),
      datasetHash,
    },
    decodedCaptureHash,
  };
  encodedSize(encoded, emit);
  // Decode and prove the entire original capture, not merely market bars, before admission.
  await hydrateFinalCapture(encoded);
  emit?.({ status: "CAPTURE_CODEC_ROUNDTRIP_VERIFIED" });
  return encoded;
}
export async function hydrateFinalCapture(stored: FinalCapture): Promise<FinalCaptureV1> {
  check(plain(stored));
  if (stored.version === "kr-final-retrospective-capture-v1") {
    validateOriginal(stored);
    encodedSize(stored);
    return stored;
  }
  keys(stored, [...V1_KEYS, "decodedCaptureHash"]);
  check(
    stored.version === "kr-final-retrospective-capture-v2" && HASH.test(stored.decodedCaptureHash),
  );
  const size = encodedSize(stored),
    codec = stored.dataset;
  keys(codec, ["version", "dataset", "barIndices", "datasetHash"]);
  check(
    codec.version === "kr-final-retrospective-bars-index-v1" &&
      HASH.test(codec.datasetHash) &&
      plain(codec.dataset) &&
      !Object.hasOwn(codec.dataset, "bars") &&
      plain(codec.dataset.observedBars) &&
      plain(codec.barIndices),
  );
  const observed = codec.dataset.observedBars;
  sameKeys(observed, codec.barIndices);
  const entries: Array<[string, MarketDataset["bars"][string]]> = [];
  for (const symbol of Object.keys(codec.barIndices)) {
    const indices = codec.barIndices[symbol]!,
      all = observed[symbol]!;
    check(Array.isArray(indices) && Array.isArray(all) && indices.length <= all.length);
    let previous = -1;
    for (const index of indices) {
      check(Number.isSafeInteger(index) && index > previous && index < all.length);
      previous = index;
    }
    entries.push([symbol, indices.map((index) => all[index]!)]);
  }
  const dataset: MarketDataset = { ...codec.dataset, bars: Object.fromEntries(entries) };
  check(captureCanonicalProof(dataset).hash === codec.datasetHash);
  const { decodedCaptureHash, dataset: _encoded, version: _version, ...rest } = stored;
  void _encoded;
  void _version;
  const original: FinalCaptureV1 = {
    ...rest,
    version: "kr-final-retrospective-capture-v1",
    dataset,
  };
  validateOriginal(original);
  // Increasing unique indices permit at most one analytical copy of each observation.
  // This is an in-memory expansion bound, NOT a relaxation of the 256MiB stored limit.
  const restoredProof = captureCanonicalProof(original);
  check(restoredProof.bytes <= 2 * size);
  check(restoredProof.hash === decodedCaptureHash);
  return original;
}
