import type { ScreeningSnapshot } from "./screeningSnapshot";
import { hydrateScreeningSnapshot, screeningSnapshotJsonbBytes } from "./screeningSnapshotStorage";

export const SCREENING_RUN_ARCHIVE_FORMAT = "screening-run-archive-gzip-v1";
export const SCREENING_RUN_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
const COMPRESSION_THRESHOLD_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const headerKeys = ["runId", "asOfDate", "market", "strategyVersion", "savedAt"] as const;

export interface CompressedScreeningRunArchive {
  storageFormat: typeof SCREENING_RUN_ARCHIVE_FORMAT;
  runId: string;
  asOfDate: string;
  market: "KR" | "US";
  strategyVersion: string;
  savedAt: string;
  uncompressedBytes: number;
  sha256: string;
  /** Base64 of one gzip stream containing the complete, unmodified JSON snapshot. */
  payload: string;
}

function invalid(detail: string): never {
  throw new Error(`실행별 스크리닝 기록 저장 형식 오류: ${detail}`);
}

function validHeader(value: Record<string, unknown>) {
  if (
    typeof value["runId"] !== "string" ||
    value["runId"].length < 1 ||
    value["runId"].length > 256 ||
    typeof value["asOfDate"] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value["asOfDate"]) ||
    (value["market"] !== "KR" && value["market"] !== "US") ||
    typeof value["strategyVersion"] !== "string" ||
    value["strategyVersion"].length === 0 ||
    typeof value["savedAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["savedAt"]))
  )
    invalid("실행 식별 헤더 누락 또는 오류");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Bound output while streaming, not after materializing a decompression bomb. */
async function boundedBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) invalid("복원 또는 압축 크기 한도 초과");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Archive boundary only. Daily representatives retain their separate column encoding. */
export async function serializeScreeningRunArchive(
  snapshot: ScreeningSnapshot,
): Promise<ScreeningSnapshot | CompressedScreeningRunArchive> {
  // Preserve the existing JSON boundary, including undefined array values becoming null.
  const json = JSON.stringify(snapshot);
  const normalized = JSON.parse(json) as ScreeningSnapshot;
  const jsonbBytes = screeningSnapshotJsonbBytes(normalized);
  if (jsonbBytes > SCREENING_RUN_ARCHIVE_MAX_BYTES) invalid("복원 크기 한도 초과");
  if (jsonbBytes <= COMPRESSION_THRESHOLD_BYTES) return normalized;
  validHeader(normalized as unknown as Record<string, unknown>);
  const bytes = encoder.encode(json);
  const compressed = await boundedBytes(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
    SCREENING_RUN_ARCHIVE_MAX_BYTES,
  );
  const stored: CompressedScreeningRunArchive = {
    storageFormat: SCREENING_RUN_ARCHIVE_FORMAT,
    runId: normalized.runId!,
    asOfDate: normalized.asOfDate,
    market: normalized.market!,
    strategyVersion: normalized.strategyVersion!,
    savedAt: normalized.savedAt,
    uncompressedBytes: bytes.byteLength,
    sha256: await digest(bytes),
    payload: base64(compressed),
  };
  // Incompressible input must not regress the existing 32 MiB database contract.
  return screeningSnapshotJsonbBytes(stored) < jsonbBytes ? stored : normalized;
}

/** Read legacy raw archives and verify every byte/header of new compressed archives. */
export async function hydrateScreeningRunArchive(stored: unknown): Promise<ScreeningSnapshot> {
  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored) ||
    !Object.hasOwn(stored, "storageFormat") ||
    (stored as Record<string, unknown>)["storageFormat"] !== SCREENING_RUN_ARCHIVE_FORMAT
  )
    return hydrateScreeningSnapshot(stored);
  const envelope = stored as unknown as CompressedScreeningRunArchive;
  validHeader(envelope as unknown as Record<string, unknown>);
  if (
    !Number.isSafeInteger(envelope.uncompressedBytes) ||
    envelope.uncompressedBytes < 1 ||
    envelope.uncompressedBytes > SCREENING_RUN_ARCHIVE_MAX_BYTES ||
    typeof envelope.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(envelope.sha256) ||
    typeof envelope.payload !== "string" ||
    envelope.payload.length < 4 ||
    envelope.payload.length > SCREENING_RUN_ARCHIVE_MAX_BYTES ||
    envelope.payload.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(envelope.payload)
  )
    invalid("압축 데이터 메타데이터 오류");
  if (screeningSnapshotJsonbBytes(envelope) > SCREENING_RUN_ARCHIVE_MAX_BYTES)
    invalid("저장 크기 한도 초과");
  let compressed: Uint8Array<ArrayBuffer>;
  try {
    compressed = Uint8Array.from(atob(envelope.payload), (char) => char.charCodeAt(0));
  } catch {
    return invalid("잘못된 base64 데이터");
  }
  if (base64(compressed) !== envelope.payload) invalid("잘못된 base64 데이터");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await boundedBytes(
      new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")),
      envelope.uncompressedBytes,
    );
  } catch {
    return invalid("gzip 손상 또는 복원 크기 한도 초과");
  }
  if (bytes.byteLength !== envelope.uncompressedBytes || (await digest(bytes)) !== envelope.sha256)
    invalid("복원 크기 또는 SHA-256 무결성 불일치");
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid("스냅샷 JSON 본문 오류");
  }
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !Array.isArray((result as ScreeningSnapshot).entries) ||
    Object.hasOwn(result, "storageFormat")
  )
    invalid("스냅샷 본문 누락");
  if (screeningSnapshotJsonbBytes(result) > SCREENING_RUN_ARCHIVE_MAX_BYTES)
    invalid("복원 크기 한도 초과");
  for (const key of headerKeys)
    if (envelope[key] !== (result as Record<string, unknown>)[key])
      invalid("스냅샷 헤더와 본문 불일치");
  return result as ScreeningSnapshot;
}
