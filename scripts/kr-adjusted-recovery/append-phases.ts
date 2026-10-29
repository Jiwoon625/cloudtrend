/** Finite public observations only; never raw errors, response bodies or private selectors. */
export const APPEND_PHASES = [
  "APPEND_PAYLOAD_READ",
  "APPEND_PAYLOAD_VERIFICATION",
  "APPEND_IDENTITY",
  "APPEND_CANONICAL_HASH",
  "APPEND_STORAGE_ENCODING",
  "APPEND_NAMESPACE_READ",
  "APPEND_NAMESPACE_SHAPE",
  "APPEND_EXISTING_IDENTITY",
  "FRESH_PLAN_READ",
  "FRESH_PLAN_VALIDATION",
  "FRESH_RECEIPT_PLAN_BINDING",
  "FRESH_CAPSULE_READ",
  "FRESH_CAPSULE_HASH",
  "FRESH_CAPSULE_VALIDATION",
  "FRESH_SOURCE_ROSTER",
  "FRESH_CAPTURE_IDENTITY",
  "FRESH_MODEL_READ",
  "FRESH_MODEL_HASH",
  "FRESH_MODEL_RECEIPT_BINDING",
  "FRESH_REGISTRY_READ",
  "FRESH_REGISTRY_BINDING",
  "FRESH_MODEL_LATER_READ",
  "FRESH_MODEL_LATER_ABSENCE",
  "FRESH_ARCHIVE_READ",
  "FRESH_ARCHIVE_HASH",
  "FRESH_ARCHIVE_PREFIX",
  "FRESH_VINTAGE_READ",
  "FRESH_VINTAGE_BINDING",
  "FRESH_FINAL_SOURCE_READ",
  "FRESH_FINAL_SOURCE_HASH",
  "FRESH_FINAL_DECLARATION",
  "FRESH_INTEGRATED_BOOK_BINDING",
  "FRESH_INTEGRATED_MODEL_READ",
  "FRESH_INTEGRATED_MODEL_STATE",
  "FRESH_INTEGRATED_MODEL_CANONICAL",
  "FRESH_INTEGRATED_LATER_READ",
  "FRESH_INTEGRATED_LATER_ABSENCE",
  "FRESH_KR_COMPLETED_EVIDENCE_READ",
  "FRESH_KR_COMPLETED_EVIDENCE_HASH",
  "FRESH_KR_HISTORY_COUNT",
  "FRESH_KR_HISTORY_EVIDENCE_READ",
  "FRESH_KR_HISTORY_EVIDENCE_HASH",
  "FRESH_US_PREVIOUS_EVIDENCE_READ",
  "FRESH_US_PREVIOUS_EVIDENCE_HASH",
  "FRESH_US_CURRENT_EVIDENCE_READ",
  "FRESH_US_CURRENT_EVIDENCE_HASH",
  "FRESH_LEGACY_GENERATION_READ",
  "FRESH_LEGACY_GENERATION_MATCH",
  "FRESH_PINS_COMPLETE",
  "APPEND_BODY_SIZE",
  "APPEND_POST",
  "APPEND_READBACK_READ",
  "APPEND_READBACK_SHAPE",
  "APPEND_READBACK_IDENTITY",
  "APPEND_READBACK_PRESENT",
] as const;
export type AppendPhase = (typeof APPEND_PHASES)[number];
export const POST_RESPONSE_CATEGORIES = [
  "NOT_SENT",
  "HTTP_2XX",
  "HTTP_3XX",
  "HTTP_4XX",
  "HTTP_5XX",
  "OTHER_STATUS",
  "NETWORK_UNCERTAIN",
] as const;
export type PostResponseCategory = (typeof POST_RESPONSE_CATEGORIES)[number];
export interface AppendObservation {
  payloadBytes?: number;
  storedPayloadBytes?: number;
  postResponse?: PostResponseCategory;
  httpStatus?: number;
}
export function publicAppendObservation(value: AppendObservation): AppendObservation {
  return {
    ...(Number.isSafeInteger(value.payloadBytes) && value.payloadBytes! >= 0
      ? { payloadBytes: value.payloadBytes }
      : {}),
    ...(Number.isSafeInteger(value.storedPayloadBytes) && value.storedPayloadBytes! >= 0
      ? { storedPayloadBytes: value.storedPayloadBytes }
      : {}),
    ...(POST_RESPONSE_CATEGORIES.includes(value.postResponse!)
      ? { postResponse: value.postResponse }
      : {}),
    ...(Number.isInteger(value.httpStatus) && value.httpStatus! >= 100 && value.httpStatus! <= 599
      ? { httpStatus: value.httpStatus }
      : {}),
  };
}
