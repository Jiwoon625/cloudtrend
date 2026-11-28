import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { validateMasterRows, masterChanges, type MasterSnapshot } from "./manualMaster";
const table="manual_security_master";
import { loadManualMaster } from "./manualMaster.server";
const request=z.discriminatedUnion("action",[
  z.object({action:z.literal("load"),accessToken:z.string().min(1)}).strict(),
  z.object({action:z.literal("save"),accessToken:z.string().min(1),expectedRevision:z.number().int().nonnegative(),asOf:z.string(),rows:z.array(z.unknown()).max(2000),confirmed:z.literal(true)}).strict(),
]);
export const manualMasterServer=createServerFn({method:"POST"}).inputValidator((x:unknown)=>request.parse(x)).handler(async({data}):Promise<MasterSnapshot|null>=>{
  const client=createClient(import.meta.env["VITE_SUPABASE_URL"]||"https://ahbvrtugugwnbrfnbxzp.supabase.co",import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"]||"sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",{
    global:{headers:{Authorization:`Bearer ${data.accessToken}`}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}
  });
  const auth=await client.auth.getUser(data.accessToken);
  if(auth.error||!auth.data.user||auth.data.user.is_anonymous)throw new Error("로그인 세션을 확인하세요.");
  const uid=auth.data.user.id;
  const read=()=>loadManualMaster(client,uid);
  const before=await read();
  if(data.action==="load")return before;
  if((before?.revision??0)!==data.expectedRevision)throw new Error("다른 저장이 발생했습니다. 다시 조회하세요.");
  if(before&&data.asOf<before.asOf)throw new Error("기준일을 이전으로 되돌릴 수 없습니다.");
  const rows=validateMasterRows(data.rows,data.asOf);
  if(masterChanges(before?.rows??[],rows).removed.length)throw new Error("기존 종목은 삭제하지 말고 보유수량을 0으로 변경하세요.");
  const next={revision:data.expectedRevision+1,as_of:data.asOf,rows,saved_at:new Date().toISOString()};
  const saved=before
    ?await client.from(table).update(next).eq("user_id",uid).eq("revision",data.expectedRevision).select("revision").maybeSingle()
    :await client.from(table).insert({user_id:uid,...next}).select("revision").maybeSingle();
  if(saved.error||!saved.data)throw new Error("저장 확인 실패. 다시 조회한 후 재시도하세요.");
  const checked=await read();
  if(!checked||checked.revision!==next.revision||checked.asOf!==next.as_of||JSON.stringify(checked.rows)!==JSON.stringify(rows))throw new Error("저장 결과가 일치하지 않습니다. 다시 조회하세요.");
  return checked;
});
