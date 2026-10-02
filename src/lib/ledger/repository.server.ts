import type { SupabaseClient } from "@supabase/supabase-js";
import type { LedgerEvent } from "./types";
import type { SyncIntent } from "./sync";
import { validateEvent } from "./validation";
/** Trusted reviewed flow only. No browser route exposes this writer; RPC permissions fail closed. */
export async function appendReviewedEvent(
  client: SupabaseClient,
  userId: string,
  event: LedgerEvent,
  intent: SyncIntent | null,
) {
  if (!/^[a-f\d-]{36}$/i.test(userId)) throw new Error("Verified owner ID required");
  validateEvent(event);
  if (
    intent &&
    (event.book !== "ACTUAL" ||
      intent.eventId !== event.id ||
      intent.eventRevision !== event.revision ||
      intent.sourceHash !== event.source.contentHash ||
      intent.status !== "PENDING")
  )
    throw new Error("Outbox event identity mismatch");
  const { data, error } = await client.rpc("ledger_append_reviewed_event", {
    p_user_id: userId,
    p_expected_revision: event.revision - 1,
    p_event: event,
    p_sync_intent: intent,
  });
  if (error) throw new Error(`Reviewed journal append failed: ${error.message}`);
  if (!data || typeof data.reused !== "boolean" || data.revision !== event.revision)
    throw new Error("Journal acknowledgement mismatch");
  return data as { reused: boolean; revision: number };
}
export async function readJournal(
  client: SupabaseClient,
  userId: string,
  book: "ACTUAL" | "MODEL",
  bookId: string,
) {
  if (!/^[a-f\d-]{36}$/i.test(userId)) throw new Error("Verified owner ID required");
  // One statement/snapshot; offset pagination could skip/duplicate concurrent appends.
  const { data, error } = await client.rpc("ledger_read_events", {
    p_user_id: userId,
    p_book: book,
    p_book_id: bookId,
  });
  if (error) throw new Error(`Journal read failed: ${error.message}`);
  if (!Array.isArray(data)) throw new Error("Journal snapshot response must be an array");
  return data.map((raw: unknown) => {
    const event = raw as LedgerEvent;
    validateEvent(event);
    if (event.book !== book || event.bookId !== bookId)
      throw new Error("Journal payload scope mismatch");
    return event;
  });
}
