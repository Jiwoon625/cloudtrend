import type { SupabaseClient } from "@supabase/supabase-js";
import type { LedgerEvent } from "./types";
import type { AssistedRecordingTask } from "./assistedRecording";
import { validateEvent } from "./validation";
/** Trusted reviewed flow only. No browser route exposes this writer; RPC permissions fail closed. */
export async function appendReviewedEvent(
  client: SupabaseClient,
  userId: string,
  event: LedgerEvent,
  task: AssistedRecordingTask | null,
) {
  if (!/^[a-f\d-]{36}$/i.test(userId)) throw new Error("Verified owner ID required");
  validateEvent(event);
  if (
    task &&
    (event.book !== "ACTUAL" ||
      task.key !== `RECEIPT:${event.id}:${event.revision}` ||
      !task.requestRef.trim() ||
      task.eventId !== event.id ||
      task.eventRevision !== event.revision ||
      task.sourceHash !== event.source.contentHash ||
      task.status !== "PENDING")
  )
    throw new Error("Assisted recording event identity mismatch");
  const { data, error } = await client.rpc("ledger_append_reviewed_event", {
    p_user_id: userId,
    p_expected_revision: event.revision - 1,
    p_event: event,
    p_recording_task: task,
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
