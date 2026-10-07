import type { ScreeningSnapshot } from "./screeningSnapshot";

export const SCREENING_HISTORY_MAX_BYTES = 1_048_576;
export const SCREENING_SNAPSHOT_STORAGE_FORMAT = "screening-snapshot-columns-v1";
const MAX_DEPTH = 64;
const MAX_HYDRATED_BYTES = 32 * SCREENING_HISTORY_MAX_BYTES;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const encoder = new TextEncoder();
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface CompactScreeningSnapshot {
  storageFormat: typeof SCREENING_SNAPSHOT_STORAGE_FORMAT;
  date: string;
  asOfDate: string;
  savedAt: string;
  totalCount: number;
  /** Ordered property names, shared by every object with exactly this property set/order. */
  schemas: string[][];
  /** Objects are [schema index, ...values]; arrays are [-1, ...values]. Scalars stay exact. */
  value: Json;
}
export type StoredScreeningSnapshot = ScreeningSnapshot | CompactScreeningSnapshot;

function invalid(detail: string): never {
  throw new Error(`스크리닝 이력 저장 형식 오류: ${detail}`);
}
function numberBytes(value: number) {
  if (!Number.isFinite(value)) return invalid("유한하지 않은 숫자");
  const text = JSON.stringify(value);
  const scientific = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
  if (!scientific) return text.length;
  const sign = scientific[1]!.length;
  const digits = scientific[2]!.length + (scientific[3]?.length ?? 0);
  const point = scientific[2]!.length + Number(scientific[4]);
  // PostgreSQL jsonb::text expands exponent-form JSON numbers into decimal notation.
  return sign + (point <= 0 ? 2 - point + digits : point >= digits ? point : digits + 1);
}
function stringBytes(value: string) {
  // jsonb cannot represent NUL or unpaired UTF-16 surrogates.
  if (value.includes("\0") || /[\uD800-\uDFFF]/u.test(value))
    return invalid("지원하지 않는 유니코드 문자");
  return encoder.encode(JSON.stringify(value)).byteLength;
}
function keysOf(value: object) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid("일반 JSON 객체가 아님");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined);
  for (const key of keys) if (unsafeKeys.has(key)) return invalid("허용되지 않는 속성 이름");
  return keys;
}

/** Upper bound for octet_length(jsonb::text), including UTF-8, spaces, and numeric expansion. */
export function screeningSnapshotJsonbBytes(value: unknown, depth = 0): number {
  if (depth > MAX_DEPTH) return invalid("중첩 깊이 초과");
  if (value === null) return 4;
  if (typeof value === "string") return stringBytes(value);
  if (typeof value === "number") return numberBytes(value);
  if (typeof value === "boolean") return value ? 4 : 5;
  if (Array.isArray(value)) {
    let bytes = 2 + Math.max(0, value.length - 1) * 2;
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) return invalid("비어 있는 배열 항목");
      bytes += screeningSnapshotJsonbBytes(value[index], depth + 1);
    }
    return bytes;
  }
  if (value && typeof value === "object") {
    const keys = keysOf(value);
    return (
      2 +
      Math.max(0, keys.length - 1) * 2 +
      keys.reduce(
        (sum, key) =>
          sum +
          stringBytes(key) +
          2 +
          screeningSnapshotJsonbBytes((value as Record<string, unknown>)[key], depth + 1),
        0,
      )
    );
  }
  return invalid("JSON으로 저장할 수 없는 값");
}

/** Storage-only encoding: domain snapshots, calculations, and frozen archives are unchanged. */
export function serializeScreeningSnapshot(snapshot: ScreeningSnapshot): StoredScreeningSnapshot {
  const rawBytes = screeningSnapshotJsonbBytes(snapshot);
  if (rawBytes > MAX_HYDRATED_BYTES) return invalid("복원 크기 한도 초과");
  if (rawBytes <= SCREENING_HISTORY_MAX_BYTES) return snapshot;
  const schemas: string[][] = [];
  const schemaIds = new Map<string, number>();
  function pack(value: unknown): Json {
    if (Array.isArray(value)) return [-1, ...value.map(pack)];
    if (value && typeof value === "object") {
      const keys = keysOf(value);
      const signature = JSON.stringify(keys);
      let id = schemaIds.get(signature);
      if (id === undefined) {
        id = schemas.length;
        schemas.push(keys);
        schemaIds.set(signature, id);
      }
      return [id, ...keys.map((key) => pack((value as Record<string, unknown>)[key]))];
    }
    return value as Json;
  }
  const value = pack(snapshot);
  const stored: CompactScreeningSnapshot = {
    storageFormat: SCREENING_SNAPSHOT_STORAGE_FORMAT,
    date: snapshot.date,
    asOfDate: snapshot.asOfDate,
    savedAt: snapshot.savedAt,
    totalCount: snapshot.totalCount,
    schemas,
    value,
  };
  const bytes = screeningSnapshotJsonbBytes(stored);
  if (bytes > SCREENING_HISTORY_MAX_BYTES)
    throw new Error(
      `스크리닝 이력이 압축 후에도 1 MiB 저장 한도를 초과합니다 (${bytes.toLocaleString("en-US")} bytes). 종목이나 판단 근거를 누락하지 않기 위해 저장을 중단했습니다.`,
    );
  return stored;
}

/** Hydrate at database boundaries only; legacy snapshots retain their original representation. */
export function hydrateScreeningSnapshot(stored: unknown): ScreeningSnapshot {
  if (!stored || typeof stored !== "object" || Array.isArray(stored))
    return invalid("스냅샷 객체가 아님");
  const envelope = stored as Record<string, unknown>;
  if (!Object.hasOwn(envelope, "storageFormat")) return stored as ScreeningSnapshot;
  if (envelope["storageFormat"] !== SCREENING_SNAPSHOT_STORAGE_FORMAT)
    return invalid("지원하지 않는 저장 버전");
  if (screeningSnapshotJsonbBytes(stored) > SCREENING_HISTORY_MAX_BYTES)
    return invalid("저장 한도를 초과한 데이터");
  const schemas = envelope["schemas"];
  if (!Array.isArray(schemas)) return invalid("속성 사전 누락");
  for (const schema of schemas) {
    if (
      !Array.isArray(schema) ||
      schema.some((key) => typeof key !== "string" || unsafeKeys.has(key)) ||
      new Set(schema).size !== schema.length
    )
      return invalid("손상된 속성 사전");
  }
  const schemaTable = schemas as string[][];
  let expandedBytes = 0;
  function unpack(value: unknown, depth = 0): Json {
    if (depth > MAX_DEPTH) return invalid("중첩 깊이 초과");
    if (!Array.isArray(value)) {
      if (value !== null && typeof value === "object") return invalid("인코딩되지 않은 객체");
      expandedBytes += screeningSnapshotJsonbBytes(value);
      if (expandedBytes > MAX_HYDRATED_BYTES) return invalid("복원 크기 한도 초과");
      return value as Json;
    }
    const [tag, ...values] = value;
    if (!Number.isInteger(tag) || (tag as number) < -1) return invalid("잘못된 행 참조");
    expandedBytes += 2 + Math.max(0, values.length - 1) * 2;
    if (tag === -1) return values.map((item) => unpack(item, depth + 1));
    const schema: unknown = schemaTable[tag as number];
    if (!Array.isArray(schema) || schema.length !== values.length)
      return invalid("속성 수 또는 참조 불일치");
    return Object.fromEntries(
      schema.map((key: string, index: number) => {
        expandedBytes += stringBytes(key) + 2;
        if (expandedBytes > MAX_HYDRATED_BYTES) return invalid("복원 크기 한도 초과");
        return [key, unpack(values[index], depth + 1)];
      }),
    );
  }
  const result = unpack(envelope["value"]);
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !Array.isArray(result["entries"]) ||
    typeof result["asOfDate"] !== "string"
  )
    return invalid("스냅샷 본문 누락");
  for (const key of ["date", "asOfDate", "savedAt", "totalCount"])
    if (envelope[key] !== result[key]) return invalid("스냅샷 헤더와 본문 불일치");
  return result as unknown as ScreeningSnapshot;
}
