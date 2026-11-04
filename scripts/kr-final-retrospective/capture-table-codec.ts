import { Buffer } from "node:buffer";
/** Lossless column-name dictionaries only. Values, row order and absent/null fields are retained. */
export interface ObservedTable {
  columns: string[][];
  rows: Record<string, Array<[number, ...unknown[]]>>;
}
const reject = () => {
  throw Error("CAPTURE_CODEC_REJECTED_TABLE");
};
const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
export function packObservedTable(observed: Record<string, unknown[]>): ObservedTable {
  const columns: string[][] = [],
    shapes = new Map<string, number>();
  const rows = Object.fromEntries(
    Object.entries(observed).map(([symbol, values]) => [
      symbol,
      values.map((value) => {
        if (!plain(value)) return reject();
        const keys = Object.keys(value),
          identity = JSON.stringify(keys);
        let shape = shapes.get(identity);
        if (shape === undefined) {
          shape = columns.length;
          shapes.set(identity, shape);
          columns.push(keys);
        }
        return [shape, ...keys.map((key) => value[key])] as [number, ...unknown[]];
      }),
    ]),
  );
  return { columns, rows };
}
export function unpackObservedTable(
  table: ObservedTable,
  storedBytes: number,
): Record<string, Record<string, unknown>[]> {
  if (
    !Number.isSafeInteger(storedBytes) ||
    storedBytes <= 0 ||
    storedBytes > 256 * 1024 * 1024 ||
    !plain(table) ||
    Object.keys(table).sort().join(",") !== "columns,rows" ||
    !Array.isArray(table.columns) ||
    table.columns.length > 4096 ||
    !plain(table.rows)
  )
    return reject();
  const keyBytes = table.columns.map((keys) => {
    if (
      !Array.isArray(keys) ||
      keys.length > 256 ||
      keys.some((k) => typeof k !== "string" || k.length > 256) ||
      new Set(keys).size !== keys.length
    )
      return reject();
    return keys.reduce((sum, key) => sum + Buffer.byteLength(JSON.stringify(key)) + 1, 0);
  });
  // Bound the worst-case decoded JSON before allocating row objects. Each analytical row
  // may reference an observation only once; 2x includes both copies and all retained metadata.
  let addedKeys = 0;
  for (const rows of Object.values(table.rows)) {
    if (!Array.isArray(rows)) return reject();
    for (const row of rows) {
      if (
        !Array.isArray(row) ||
        !Number.isSafeInteger(row[0]) ||
        row[0] < 0 ||
        row[0] >= table.columns.length ||
        row.length !== table.columns[row[0]]!.length + 1
      )
        return reject();
      addedKeys += keyBytes[row[0]]!;
      if (2 * (storedBytes + addedKeys) > 1024 ** 3) return reject();
    }
  }
  return Object.fromEntries(
    Object.entries(table.rows).map(([symbol, rows]) => [
      symbol,
      rows.map((row) =>
        Object.fromEntries(table.columns[row[0]]!.map((key, i) => [key, row[i + 1]])),
      ),
    ]),
  );
}
