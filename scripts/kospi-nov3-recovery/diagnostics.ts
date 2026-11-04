import {
  safeKrCompanionDiagnostic,
  type KrCompanionDiagnostic,
} from "../kr-nov3-recovery/diagnostics";
/** Public diagnostics contain fixed enums and bounded counters only. Never error text. */
export const CAPTURE_STAGES = [
  "CAPTURE_READ",
  "SOURCE_READ",
  "SOURCE_VALIDATE",
  "SOURCE_MANIFEST",
  "PUBLICATION_VALIDATE",
  "DATASET_PARSE",
  "DATASET_HASH",
  "SESSION_PREDECESSOR",
  "SESSION_TARGET",
  "HISTORICAL_PROOF",
  "RECEIPT_WRITE",
  "KR_COMPANION",
  "OUTPUT_WRITE",
  "COMPLETE",
] as const;
export type CaptureStage = (typeof CAPTURE_STAGES)[number];
const counter = (v: unknown, max: number) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null;
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
export function safeCaptureProgress(value: unknown) {
  const v = record(value);
  return {
    stage: CAPTURE_STAGES.includes(v.stage as CaptureStage) ? (v.stage as CaptureStage) : "UNKNOWN",
    sourceIndex: counter(v.sourceIndex, 127),
    elapsedMs: counter(v.elapsedMs, 24 * 60 * 60 * 1000),
    rssBytes: counter(v.rssBytes, 1024 ** 4),
    heapUsedBytes: counter(v.heapUsedBytes, 1024 ** 4),
    externalBytes: counter(v.externalBytes, 1024 ** 4),
    ...(Object.hasOwn(v, "krCompanion")
      ? { krCompanion: safeKrCompanionDiagnostic(v.krCompanion) }
      : {}),
  };
}
export function captureProgress(
  stage: CaptureStage,
  sourceIndex: number | null,
  started: number,
  krCompanion?: KrCompanionDiagnostic,
) {
  const m = process.memoryUsage();
  return safeCaptureProgress({
    stage,
    sourceIndex,
    elapsedMs: Date.now() - started,
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    externalBytes: m.external,
    ...(krCompanion === undefined ? {} : { krCompanion }),
  });
}
export function safeChildTermination(value: unknown) {
  const v = record(value),
    e = record(v.error);
  return {
    exitCode: counter(v.status, 255),
    signal:
      v.signal === null
        ? null
        : ["SIGKILL", "SIGABRT", "SIGTERM"].includes(v.signal as string)
          ? v.signal
          : "OTHER",
    spawnError:
      v.error == null
        ? null
        : ["ENOBUFS", "ETIMEDOUT", "ENOENT", "EACCES"].includes(e.code as string)
          ? e.code
          : "OTHER",
    outOfMemoryMarker:
      typeof v.stderr === "string" &&
      /FATAL ERROR: (?:Reached heap limit|Ineffective mark-compacts near heap limit)|Allocation failed - JavaScript heap out of memory/.test(
        v.stderr,
      ),
  };
}
