import type { LedgerEvent } from "./types";
import { validateEvent } from "./validation";
/** One user-requested receipt recording, verified on both sides by the assistant. */
export interface AssistedRecordingTask {
  key: string;
  requestRef: string;
  eventId: string;
  eventRevision: number;
  sourceHash: string;
  notionPageId: string | null;
  expectedNotionHash: string | null;
  expectedLedgerRevision: number | null;
  status: "PENDING" | "PARTIAL" | "CONFLICT" | "VERIFIED";
  reason: string | null;
}
export interface RecordingReadback {
  eventId: string;
  eventRevision: number;
  sourceHash: string;
}
/** Metadata only; original receipt references remain private and stable. */
export function makeAssistedRecordingTask(
  event: LedgerEvent,
  requestRef: string,
  target: {
    notionPageId: string | null;
    expectedNotionHash: string | null;
    expectedLedgerRevision: number | null;
  },
): AssistedRecordingTask {
  validateEvent(event);
  if (event.book !== "ACTUAL")
    throw new Error("Model journals cannot be recorded as actual executions");
  if (!requestRef.trim()) throw new Error("User-request reference is required");
  return {
    key: `RECEIPT:${event.id}:${event.revision}`,
    requestRef,
    eventId: event.id,
    eventRevision: event.revision,
    sourceHash: event.source.contentHash,
    ...target,
    status: "PENDING",
    reason: null,
  };
}
/** Read-only preflight. A conflict is held for review; this helper never initiates or repeats writes. */
export function inspectRecordingTargets(
  task: AssistedRecordingTask,
  observed: { ledgerRevision: number | null; notionHash: string | null },
): AssistedRecordingTask {
  if (
    observed.ledgerRevision !== task.expectedLedgerRevision ||
    observed.notionHash !== task.expectedNotionHash
  )
    return { ...task, status: "CONFLICT", reason: "target_changed_since_review" };
  return { ...task, status: "PENDING", reason: "ready_for_requested_assisted_recording" };
}
/** Read back both destinations after requested writes. Missing one side is never reported complete.
 * Adapters must inspect actual event fields/evidence and derive these IDs/hash from that readback,
 * not treat an API write response or copied metadata alone as proof that values match.
 */
export function verifyAssistedRecording(
  task: AssistedRecordingTask,
  observed: {
    ledger: RecordingReadback | null;
    notion: (RecordingReadback & { pageId: string }) | null;
  },
): AssistedRecordingTask {
  const matches = (record: RecordingReadback) =>
    record.eventId === task.eventId &&
    record.eventRevision === task.eventRevision &&
    record.sourceHash === task.sourceHash;
  if (
    (observed.ledger && !matches(observed.ledger)) ||
    (observed.notion &&
      (!matches(observed.notion) ||
        !observed.notion.pageId.trim() ||
        (task.notionPageId !== null && task.notionPageId !== observed.notion.pageId)))
  )
    return { ...task, status: "CONFLICT", reason: "readback_identity_or_values_mismatch" };
  if (observed.ledger && observed.notion)
    return { ...task, notionPageId: observed.notion.pageId, status: "VERIFIED", reason: null };
  if (observed.ledger || observed.notion)
    return {
      ...task,
      notionPageId: observed.notion?.pageId ?? task.notionPageId,
      status: "PARTIAL",
      reason: observed.ledger ? "notion_readback_missing" : "ledger_readback_missing",
    };
  return { ...task, status: "PENDING", reason: "both_readbacks_missing" };
}
