import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { loadManualMaster } from "./manualMaster.server";
import { projection } from "./dashboardOperations.server";
import { loadActualEntryDecisions } from "./actualEntryDecisions.server";
import { activeEntryDecisions } from "./actualEntryDecisions";
import { projectManualMasterSignals } from "./manualMasterSignals";
export const manualMasterSignalsServer=createServerFn({method:"POST"})
  .inputValidator((input:unknown)=>z.object({accessToken:z.string().min(1),revision:z.number().int().positive()}).strict().parse(input))
  .handler(async({data})=>{
    const client=createClient(import.meta.env["VITE_SUPABASE_URL"]||"https://ahbvrtugugwnbrfnbxzp.supabase.co",import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"]||"sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",{
      global:{headers:{Authorization:`Bearer ${data.accessToken}`}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}
    });
    const auth=await client.auth.getUser(data.accessToken);
    if(auth.error||!auth.data.user||auth.data.user.is_anonymous)throw new Error("로그인 세션을 확인하세요.");
    const uid=auth.data.user.id;
    const snapshot=await loadManualMaster(client,uid);
    if(!snapshot||snapshot.revision!==data.revision)throw new Error("저장한 종목마스터의 최신 버전을 다시 조회하세요.");
    const [kr,us,entries]=await Promise.all([
      projection(client,uid,"kr").catch(()=>null),projection(client,uid,"us").catch(()=>null),
      loadActualEntryDecisions(client,uid).then(activeEntryDecisions).catch(()=>null)
    ]);
    const after=await loadManualMaster(client,uid);
    if(!after||after.revision!==snapshot.revision)throw new Error("보유현황이 변경되었습니다. 다시 조회하세요.");
    return projectManualMasterSignals(snapshot,kr,us,entries);
  });
