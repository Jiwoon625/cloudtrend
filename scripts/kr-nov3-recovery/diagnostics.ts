/** Exact public enums only. Never emit error messages, values, paths or private objects. */
export const KR_COMPANION_PHASES = [
  "OUTPUT_DIRECTORY",
  "RAW_EVIDENCE",
  "CAPTURE_VALIDATION",
  "CAPTURE_ENCODING",
  "CAPTURE_WRITE",
  "PLAN_COMPUTE",
  "BLOCKED_DIAGNOSIS_WRITE",
  "PLAN_WRITE",
  "APPROVAL_CANDIDATE",
  "APPROVAL_WRITE",
  "COMPLETE",
] as const;
export type KrCompanionPhase = (typeof KR_COMPANION_PHASES)[number];
const GUARD_CODES = [
  "PRIVATE_OUTPUT_PATH",
  "RAW_EVIDENCE_REQUIRED",
  "SELECTED_RAW_SOURCE",
  "RAW_CANONICAL_HASH",
  "RAW_EVIDENCE_COLUMNS",
  "RAW_SHORT_VOLUME",
  "RAW_EVIDENCE_DATES",
  "SHARED_CAPTURE_IDENTITY",
  "SHARED_CAPTURE_INVENTORY",
  "BASELINE_OWNER",
  "ACTUAL_OWNER",
  "FINAL_PUBLICATION",
  "SOURCE_OBJECT_BINDING",
  "FIVE_SERIES",
  "EXACT_PREDECESSOR",
  "CAPTURED_ARTIFACTS",
  "ARTIFACT_HASH_OWNER",
  "ARCHIVE_IDENTITY",
  "VINTAGE_ROWS",
  "VINTAGE_AUTHORITY_CONFLICT",
  "CAPTURED_KOSPI_OBJECT",
  "CAPTURE_CLOCK",
  "NOVEMBER_LINEAGE_HASH",
  "DIAGNOSTIC_STAGE",
] as const;
export const KR_COMPANION_CHECKS = [
  ...GUARD_CODES,
  "CAPTURE_CODEC_REJECTED",
  "CAPTURE_CODEC_REJECTED_NON_JSON_VALUE",
  "CAPTURE_CODEC_REJECTED_LOGICAL_LIMIT",
  "CAPTURE_CODEC_REJECTED_OBSERVED_BARS_REQUIRED",
  "CAPTURE_CODEC_REJECTED_BAR_NOT_EXACT_OBSERVATION",
  "CAPTURE_CODEC_REJECTED_EXPANSION_LIMIT",
  "CAPTURE_CODEC_REJECTED_ROUNDTRIP_HASH",
  "TYPE_ERROR",
  "RANGE_ERROR",
  "SYNTAX_ERROR",
  "FILE_EXISTS",
  "FILE_MISSING",
  "FILE_PERMISSION",
  "FILE_CAPACITY",
  "UNKNOWN",
] as const;
export type KrCompanionCheck = (typeof KR_COMPANION_CHECKS)[number];
export interface KrCompanionDiagnostic {
  phase: KrCompanionPhase | "UNKNOWN";
  check: KrCompanionCheck | null;
}
export function safeKrCompanionDiagnostic(value: unknown): KrCompanionDiagnostic {
  const v = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    phase: KR_COMPANION_PHASES.includes(v.phase as KrCompanionPhase)
      ? (v.phase as KrCompanionPhase)
      : "UNKNOWN",
    check:
      v.check === null
        ? null
        : KR_COMPANION_CHECKS.includes(v.check as KrCompanionCheck)
          ? (v.check as KrCompanionCheck)
          : "UNKNOWN",
  };
}
export function krCompanionFailureCheck(error: unknown): KrCompanionCheck {
  if (!(error instanceof Error)) return "UNKNOWN";
  for (const code of GUARD_CODES) if (error.message === "KR_NOV3_RECOVERY_" + code) return code;
  if (
    error.message.startsWith("CAPTURE_CODEC_REJECTED") &&
    KR_COMPANION_CHECKS.includes(error.message as KrCompanionCheck)
  )
    return error.message as KrCompanionCheck;
  if (error instanceof TypeError) return "TYPE_ERROR";
  if (error instanceof RangeError) return "RANGE_ERROR";
  if (error instanceof SyntaxError) return "SYNTAX_ERROR";
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") return "FILE_EXISTS";
  if (code === "ENOENT") return "FILE_MISSING";
  if (code === "EACCES" || code === "EPERM") return "FILE_PERMISSION";
  if (code === "ENOSPC" || code === "EDQUOT") return "FILE_CAPACITY";
  return "UNKNOWN";
}
/** Reporting cannot swallow the original failure or turn a successful result into a failure. */
export async function withKrCompanionDiagnostics<T>(
  work: (mark: (phase: KrCompanionPhase) => void) => Promise<T>,
  report: (value: KrCompanionDiagnostic) => void = () => {},
): Promise<T> {
  let phase: KrCompanionPhase = "OUTPUT_DIRECTORY";
  const emit = (check: KrCompanionCheck | null) => {
    try {
      report(safeKrCompanionDiagnostic({ phase, check }));
    } catch {
      /* Observability only. */
    }
  };
  try {
    return await work((next) => {
      phase = next;
      emit(null);
    });
  } catch (error) {
    emit(krCompanionFailureCheck(error));
    throw error;
  }
}
