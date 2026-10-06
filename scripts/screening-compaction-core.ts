import { createHash } from "node:crypto";
import {
  CANONICAL_SOURCE_COLUMNS,
  SOURCE_MAX_FILE_BYTES,
  visitDelimitedRows,
} from "../src/lib/sourceData";
import { sourceTimingEvidence, type SourceTimingRecord } from "../src/lib/sourceTimingEvidence";

export const COMPACTION_ALGORITHM = "screening-compaction-v1";
export const COMPACTION_TARGET_BYTES = 38 * 1024 * 1024;
const columns = [...CANONICAL_SOURCE_COLUMNS];
const identity = new Set(["name", "market", "type", "sector"]);
const optionalBarNumbers = new Set([
  "marketCap",
  "foreignNetBuyValue",
  "institutionNetBuyValue",
  "shortSellingVolumeRate",
  "lendingBalanceQuantity",
  "etfUnderlyingIndexClose",
  "etfMarketCap",
  "etfTradingValue",
]);
const cell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const line = (values: string[]) => values.map(cell).join(",");
export const COMPACTION_HEADER = columns.join(",") + "\n";

function finiteManualNumber(value: string) {
  const text = value.replace(/[, ₩원%]/g, "").trim();
  return (
    text !== "" &&
    text !== "-" &&
    !/^(null|none|nan|na)$/i.test(text) &&
    Number.isFinite(Number(text))
  );
}

/** Hash plain JSON incrementally; do not allocate a dataset-sized JSON string. */
export function stableValueHash(value: unknown): string {
  const hash = createHash("sha256");
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      hash.update("[");
      item.forEach((entry, index) => {
        if (index) hash.update(",");
        visit(entry);
      });
      hash.update("]");
    } else if (item && typeof item === "object") {
      hash.update("{");
      Object.entries(item as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([key, entry], index) => {
          if (index) hash.update(",");
          hash.update(JSON.stringify(key) + ":");
          visit(entry);
        });
      hash.update("}");
    } else hash.update(JSON.stringify(item) ?? "null");
  };
  visit(value);
  return `sha256:${hash.digest("hex")}`;
}

export function bytesHash(bytes: Uint8Array | string) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Retain encoded rows, not hundreds of thousands of wide property objects.
 * First-key insertion order is significant: the engine keeps first-seen instrument
 * metadata and instrument order. Nullable bar enrichment follows manualDataset.
 * Every original immutable object remains preserved separately.
 */
export class ScreeningCompactor {
  private rows = new Map<string, string>();
  private firstKey = new Map<string, string>();
  inputRows = 0;
  duplicateRows = 0;
  preservedEnrichmentCells = 0;

  addCanonicalCsv(text: string) {
    visitDelimitedRows(text, (incoming, index) => {
      if (index === 0) {
        if (incoming.join(",") !== columns.join(","))
          throw new Error("Compaction requires all canonical source columns in order");
        return;
      }
      if (incoming.length !== columns.length)
        throw new Error("Canonical row width differs from the source contract");
      const symbol = incoming[0]!;
      const key = `${symbol}\u0000${incoming[4]}`;
      if (!symbol || !incoming[4]) throw new Error("Missing canonical source key");
      this.inputRows++;
      if (!this.firstKey.has(symbol)) this.firstKey.set(symbol, key);
      const previousLine = this.rows.get(key);
      if (previousLine === undefined) {
        this.rows.set(key, line(incoming));
        return;
      }
      this.duplicateRows++;
      let previous: string[] = [];
      visitDelimitedRows(previousLine, (values) => {
        previous = values;
      });
      if (previous.length !== columns.length)
        throw new Error("Encoded compaction row cannot be decoded");
      const isFirstInstrumentRow = this.firstKey.get(symbol) === key;
      for (let i = 0; i < columns.length; i++) {
        const column = columns[i]!;
        // The analysis parser sets these from the first valid row of a symbol only.
        if (isFirstInstrumentRow && identity.has(column)) continue;
        const value = incoming[i]!;
        const present = optionalBarNumbers.has(column) ? finiteManualNumber(value) : value !== "";
        if (present) previous[i] = value;
        else if (previous[i] !== "") this.preservedEnrichmentCells++;
      }
      this.rows.set(key, line(previous));
    });
  }

  get rowCount() {
    return this.rows.size;
  }
  get symbolCount() {
    return this.firstKey.size;
  }
  effectiveRowsHash() {
    const hash = createHash("sha256").update(COMPACTION_HEADER);
    for (const value of this.rows.values()) hash.update(value + "\n");
    return `sha256:${hash.digest("hex")}`;
  }
  *chunks(
    maxBytes = COMPACTION_TARGET_BYTES,
  ): Generator<{ text: string; rowCount: number; bytes: number }> {
    const headerBytes = Buffer.byteLength(COMPACTION_HEADER);
    if (!Number.isInteger(maxBytes) || maxBytes > SOURCE_MAX_FILE_BYTES || maxBytes <= headerBytes)
      throw new Error("Invalid compaction chunk byte limit");
    let parts: string[] = [COMPACTION_HEADER],
      bytes = headerBytes,
      rowCount = 0;
    for (const row of this.rows.values()) {
      const encoded = row + "\n",
        size = Buffer.byteLength(encoded);
      if (size + headerBytes > maxBytes)
        throw new Error("One source row exceeds the requested chunk limit");
      if (bytes + size > maxBytes) {
        yield { text: parts.join(""), bytes, rowCount };
        parts = [COMPACTION_HEADER];
        bytes = headerBytes;
        rowCount = 0;
      }
      parts.push(encoded);
      bytes += size;
      rowCount++;
    }
    if (rowCount) yield { text: parts.join(""), bytes, rowCount };
  }
}

export function canonicalRowsHash(texts: Iterable<string>) {
  const hash = createHash("sha256").update(COMPACTION_HEADER);
  for (const text of texts)
    visitDelimitedRows(text, (values, index) => {
      if (!index) {
        if (values.join(",") !== columns.join(",")) throw new Error("Candidate schema changed");
      } else hash.update(line(values) + "\n");
    });
  return `sha256:${hash.digest("hex")}`;
}

/** Rebind a cached canonical payload to the registry's order-independent data hash. */
export function canonicalSourceDataHash(text: string) {
  const rows = new Map<string, string>();
  visitDelimitedRows(text, (values, index) => {
    if (!index) {
      if (values.join(",") !== columns.join(","))
        throw new Error("Cached canonical schema differs");
      return;
    }
    if (values.length !== columns.length) throw new Error("Cached canonical row width differs");
    const key = `${values[0]}\u0000${values[4]}`;
    if (rows.has(key)) throw new Error("Cached canonical duplicate key");
    rows.set(key, line(values));
  });
  const hash = createHash("sha256").update(COMPACTION_HEADER);
  for (const key of [...rows.keys()].sort((a, b) => a.localeCompare(b)))
    hash.update(rows.get(key)! + "\n");
  return `sha256:${hash.digest("hex")}`;
}

export function sourceDescriptor(source: Record<string, unknown>) {
  const keys = [
    "id",
    "user_id",
    "source_type",
    "original_filename",
    "storage_bucket",
    "storage_path",
    "canonical_format",
    "content_type",
    "file_size_bytes",
    "normalized_size_bytes",
    "file_hash",
    "data_hash",
    "schema_hash",
    "row_count",
    "min_date",
    "max_date",
    "upload_source",
    "created_at",
    "activated_at",
    "storage_object_id",
    "storage_object_version",
  ];
  return Object.fromEntries(keys.map((key) => [key, source[key] ?? null]));
}

export function registrySourceSetHash(sources: Array<{ id: string; file_hash: string }>) {
  return bytesHash(
    sources
      .map((source) => `${source.id}\t${source.file_hash}`)
      .sort()
      .join("\n"),
  );
}

export function compactionExecutionMode(args: string[], restoredArgs: boolean) {
  if (args.includes("--retry-cutover")) return "retry" as const;
  if (args.includes("--apply")) return restoredArgs ? ("retry" as const) : ("apply" as const);
  return "prepare" as const;
}

export function originalTimingEvidence(sources: SourceTimingRecord[]) {
  const origins = new Map<
    string,
    {
      id: string;
      min_date: string | null;
      max_date: string | null;
      activated_at: string | null;
      created_at: string;
    }
  >();
  for (const record of sources.flatMap(sourceTimingEvidence)) {
    if (!record.id || !record.created_at)
      throw new Error("Original source timing identity is missing");
    const evidence = {
      id: record.id,
      min_date: record.min_date ?? null,
      max_date: record.max_date ?? null,
      activated_at: record.activated_at ?? null,
      created_at: record.created_at,
    };
    const old = origins.get(record.id);
    if (old && stableValueHash(old) !== stableValueHash(evidence))
      throw new Error("Original source timing evidence conflicts");
    origins.set(record.id, evidence);
  }
  return [...origins.values()];
}

export function logicalTimingHash(sources: SourceTimingRecord[]) {
  return stableValueHash(
    originalTimingEvidence(sources)
      .map((record) => ({
        ...record,
        activated_at: record.activated_at === null ? null : Date.parse(record.activated_at),
        created_at: Date.parse(record.created_at),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function assertSourceOrderUnambiguous(
  sources: Array<{ activated_at: string | null; created_at: string }>,
) {
  const seen = new Set<string>();
  for (const source of sources) {
    const key = `${source.activated_at ?? ""}|${source.created_at}`;
    if (seen.has(key))
      throw new Error("Existing source activation order is ambiguous; compaction stopped");
    seen.add(key);
  }
}
