import type { LedgerEvent } from "./types";
import { validateEvent } from "./validation";
export interface SyncIntent {
  key: string;
  direction: "TO_NOTION" | "FROM_NOTION";
  eventId: string;
  eventRevision: number;
  sourceHash: string;
  notionPageId: string | null;
  expectedNotionHash: string | null;
  expectedLedgerRevision: number | null;
  status: "PENDING" | "BLOCKED_BRIDGE" | "CONFLICT" | "ACKNOWLEDGED";
  reason: string | null;
}
/** Metadata only: receipts remain at stable private evidence references; do not publish file URLs. */
export function makeSyncIntent(
  event: LedgerEvent,
  direction: SyncIntent["direction"],
  target: {
    notionPageId: string | null;
    expectedNotionHash: string | null;
    expectedLedgerRevision: number | null;
  },
): SyncIntent {
  validateEvent(event);
  if (event.book !== "ACTUAL")
    throw new Error("Model journals must never sync as actual executions");
  return {
    key: `${direction}:${event.id}:${event.revision}`,
    direction,
    eventId: event.id,
    eventRevision: event.revision,
    sourceHash: event.source.contentHash,
    ...target,
    status: "PENDING",
    reason: null,
  };
}
export function inspectSync(
  intent: SyncIntent,
  observed: {
    bridgeAvailable: boolean;
    /** The connector available to the assistant is not a credential available to GitHub/server runtime. */
    ledgerRevision: number | null;
    notionHash: string | null;
    acknowledgement: { key: string; sourceHash: string; notionPageId: string } | null;
  },
): SyncIntent {
  const ack = observed.acknowledgement;
  if (ack?.key === intent.key) {
    if (
      ack.sourceHash !== intent.sourceHash ||
      (intent.notionPageId && ack.notionPageId !== intent.notionPageId)
    )
      return { ...intent, status: "CONFLICT", reason: "acknowledgement_identity_mismatch" };
    return { ...intent, notionPageId: ack.notionPageId, status: "ACKNOWLEDGED", reason: null };
  }
  if (
    observed.ledgerRevision !== intent.expectedLedgerRevision ||
    observed.notionHash !== intent.expectedNotionHash
  )
    return { ...intent, status: "CONFLICT", reason: "target_changed_since_review" };
  if (!observed.bridgeAvailable)
    return { ...intent, status: "BLOCKED_BRIDGE", reason: "runtime_notion_access_not_verified" };
  // A successful preflight is not a write acknowledgement. The future bridge must recheck atomically.
  return { ...intent, status: "PENDING", reason: "ready_for_authorized_adapter" };
}
