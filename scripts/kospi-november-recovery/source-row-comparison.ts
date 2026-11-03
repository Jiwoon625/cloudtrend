import { canonicalSeriesJson } from "../../src/lib/ledger/modelSeries";

const TIMESTAMP_COLUMNS = new Set(["created_at", "updated_at", "activated_at"]);

/** SQL and PostgREST serialize timestamptz differently. Preserve all six digits. */
function instantMicroseconds(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw Error("INVALID_SOURCE_TIMESTAMP");
  const m =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2})(?::(\d{2}))?)$/.exec(
      value,
    );
  if (!m) throw Error("INVALID_SOURCE_TIMESTAMP");
  const local = `${m[1]}T${m[2]}.000Z`;
  const milliseconds = Date.parse(local);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== local)
    throw Error("INVALID_SOURCE_TIMESTAMP");
  const hours = Number(m[6] ?? 0),
    minutes = Number(m[7] ?? 0);
  if (hours > 15 || minutes > 59) throw Error("INVALID_SOURCE_TIMESTAMP");
  const offsetSeconds = (hours * 60 + minutes) * 60 * (m[5] === "-" ? -1 : 1);
  return (
    BigInt(milliseconds) * 1000n -
    BigInt(offsetSeconds) * 1000000n +
    BigInt((m[3] ?? "").padEnd(6, "0"))
  ).toString();
}

/** Comparison only: never changes capsule rows, their hashes, order, or nested values. */
export function sameSourceRows(actual: unknown, expected: unknown): boolean {
  const normalize = (rows: unknown) => {
    if (!Array.isArray(rows)) throw Error("INVALID_SOURCE_ROWS");
    return rows.map((row: unknown) => {
      if (row === null || typeof row !== "object" || Array.isArray(row))
        throw Error("INVALID_SOURCE_ROW");
      return Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          TIMESTAMP_COLUMNS.has(key) ? instantMicroseconds(value) : value,
        ]),
      );
    });
  };
  try {
    return canonicalSeriesJson(normalize(actual)) === canonicalSeriesJson(normalize(expected));
  } catch {
    return false;
  }
}
