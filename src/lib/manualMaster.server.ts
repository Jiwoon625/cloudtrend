import type { SupabaseClient } from "@supabase/supabase-js";
import { validateMasterRows, type MasterSnapshot } from "./manualMaster";

export async function loadManualMaster(client: SupabaseClient, uid: string): Promise<MasterSnapshot | null> {
  const {data:row,error}=await client.from("manual_security_master").select("revision,as_of,rows,saved_at").eq("user_id",uid).maybeSingle();
  if(error)throw new Error("종목마스터 조회 실패");
  if(!row)return null;
  if(!Number.isInteger(row.revision)||row.revision<=0||!Number.isFinite(Date.parse(row.saved_at)))throw new Error("종목마스터 저장정보 오류");
  return {revision:row.revision,asOf:row.as_of,rows:validateMasterRows(row.rows,row.as_of),savedAt:row.saved_at};
}
