import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyEntryCommand,
  emptyEntryDecisions,
  entryDocumentSchema,
  type EntryCommand,
  type EntryDecisionDocument,
} from "./actualEntryDecisions";
const TABLE = "actual_entry_decisions";
export async function loadActualEntryDecisions(
  client: SupabaseClient,
  uid: string,
): Promise<EntryDecisionDocument> {
  const { data, error } = await client
    .from(TABLE)
    .select("revision,events")
    .eq("user_id", uid)
    .maybeSingle();
  if (error) throw new Error("실제 미매수 기록을 불러오지 못했습니다. 다시 조회하세요.");
  if (!data) return emptyEntryDecisions();
  const parsed = entryDocumentSchema.safeParse(data);
  if (!parsed.success) throw new Error("미매수 기록 형식을 확인할 수 없습니다. 저장을 중단합니다.");
  return parsed.data;
}
export async function saveActualEntryDecision(
  client: SupabaseClient,
  uid: string,
  command: EntryCommand,
  revision: number,
) {
  const before = await loadActualEntryDecisions(client, uid);
  const next = applyEntryCommand(before, command, revision, new Date().toISOString());
  if (next === before) return before;
  const row = { user_id: uid, ...next, updated_at: new Date().toISOString() };
  const result =
    before.revision === 0
      ? await client.from(TABLE).insert(row).select("revision").maybeSingle()
      : await client
          .from(TABLE)
          .update({ revision: next.revision, events: next.events, updated_at: row.updated_at })
          .eq("user_id", uid)
          .eq("revision", before.revision)
          .select("revision")
          .maybeSingle();
  if (result.error || !result.data)
    throw new Error("미매수 저장을 확인하지 못했습니다. 다시 조회 후 재시도하세요.");
  const checked = await loadActualEntryDecisions(client, uid);
  if (
    !checked.events.some(
      (e) => e.command.id === command.id && JSON.stringify(e.command) === JSON.stringify(command),
    )
  )
    throw new Error("미매수 저장 확인이 필요합니다. 다시 조회하세요.");
  return checked;
}
