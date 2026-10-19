import process from "node:process";
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { trustedSupabaseClient } from "../../scripts/analysis-run-store";
import { existingTradeMatches, parseAssistantActualBuy, type AssistantTradeProposal } from "../lib/assistantActualTrade";
import { readWebsiteDocument } from "../lib/ledger/websiteRepository.server";
import { saveNewActualPortfolio, type NewActualDocument } from "../lib/newActualPortfolio.server";

const headers = {"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
const reply = (data:unknown,status=200) => new Response(JSON.stringify(data),{status,headers});
const actionSchema = z.object({
  action:z.enum(["CONFIRM","REJECT"]),
  proposalId:z.string().uuid(),
  confirmed:z.literal(true),
}).strict();

function configuredOwner() {
  const id = process.env["SUPABASE_USER_ID"]?.trim();
  if (!id || !z.string().uuid().safeParse(id).success)
    throw new Error("거래 승인 서비스의 소유자 설정이 누락되었습니다.");
  return id;
}

async function owner(request:Request) {
  const header=request.headers.get("authorization") ?? "";
  const token=header.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token) return null;
  const client=createClient(
    import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co",
    import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] || "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",
    {global:{headers:{Authorization:`Bearer ${token}`}},
      auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}},
  );
  const {data,error}=await client.auth.getUser(token);
  if (error || !data.user || data.user.id !== configuredOwner()) return null;
  return {client,userId:data.user.id};
}

async function list(ownerId:string) {
  const {data,error}=await trustedSupabaseClient().from("assistant_trade_proposals")
    .select("id,user_id,source_page_id,trade,status,ledger_execution_id,created_at")
    .eq("user_id",ownerId).order("created_at",{ascending:false}).limit(100);
  if (error) throw new Error("승인 대기내역을 조회하지 못했습니다.");
  return (data ?? []) as AssistantTradeProposal[];
}

async function apply(request:Request, auth:NonNullable<Awaited<ReturnType<typeof owner>>>) {
  const raw=await request.text();
  if (raw.length > 4096) return reply({error:"요청 본문이 너무 큽니다."},413);
  const input=actionSchema.parse(JSON.parse(raw));
  const service=trustedSupabaseClient();
  const {data,error}=await service.from("assistant_trade_proposals")
    .select("id,user_id,source_page_id,trade,status,ledger_execution_id,created_at")
    .eq("user_id",auth.userId).eq("id",input.proposalId).maybeSingle();
  if (error || !data) return reply({error:"소유자의 승인 요청을 찾을 수 없습니다."},404);
  const proposal=data as AssistantTradeProposal;
  if (input.action==="REJECT") {
    if (proposal.status!=="PENDING")
      return reply({error:"이미 처리한 요청은 변경할 수 없습니다."},409);
    const {data:updated,error:updateError}=await service.from("assistant_trade_proposals")
      .update({status:"REJECTED",reviewed_at:new Date().toISOString()})
      .eq("id",proposal.id).eq("user_id",auth.userId).eq("status","PENDING").select("id").maybeSingle();
    if (updateError || !updated) return reply({error:"반려 저장을 확인하지 못했습니다."},409);
    return reply({ok:true,status:"REJECTED",proposalId:proposal.id});
  }
  if (proposal.status==="RECORDED")
    return reply({ok:true,status:"RECORDED",proposalId:proposal.id,executionId:proposal.ledger_execution_id,reused:true});
  if (proposal.status!=="PENDING") return reply({error:"반려된 요청은 기록할 수 없습니다."},409);
  const trade=parseAssistantActualBuy(proposal.trade);
  if (trade.sourcePageId !== proposal.source_page_id)
    return reply({error:"승인 요청의 증빙 식별자가 일치하지 않습니다."},409);

  const snapshot=await readWebsiteDocument<NewActualDocument>(auth.client,auth.userId,"portfolio_ledgers");
  if (!snapshot) return reply({error:"실제 원장이 준비되지 않았습니다."},409);
  const expectedId=`new-actual:${proposal.id}`;
  const already=snapshot.payload.executions.find(e=>e.id===expectedId);
  if (already && !existingTradeMatches(trade,already))
    return reply({error:"기존 체결 식별자와 거래 세부정보가 다릅니다."},409);
  if (!already && snapshot.payload.executions.some(e=>existingTradeMatches(trade,e)))
    return reply({error:"동일한 체결이 이미 원장에 있을 수 있습니다. 중복 여부를 직접 대조하세요."},409);

  // The owner JWT, never service_role, is passed to the existing CAS journal bridge.
  // Stable proposal UUID is the idempotency key across network retries.
  const saved=await saveNewActualPortfolio(auth.client,auth.userId,{
    action:"execution",asset:"KR",confirmed:true,
    accessToken:"owner-confirmed-in-api",
    expectedRevision:snapshot.revision,requestId:proposal.id,
    execution:{
      id:"",date:trade.date,name:trade.name,side:"BUY",
      market:trade.market,symbol:trade.symbol,shares:trade.shares,
      price:trade.price,fee:trade.fee,
      note:`${trade.accountLabel} 실제매수 · ChatGPT 제안 / Notion 증빙 소유자 확인`,
    },
    allocation:{
      quantity:trade.shares,gross:trade.price*trade.shares,fee:trade.fee,
      brokerReference:`notion:${trade.sourcePageId}`,
    },
  });
  const {data:updated,error:updateError}=await service.from("assistant_trade_proposals")
    .update({status:"RECORDED",ledger_execution_id:expectedId,reviewed_at:new Date().toISOString()})
    .eq("id",proposal.id).eq("user_id",auth.userId).eq("status","PENDING").select("id").maybeSingle();
  if (updateError || !updated)
    // Ledger write may have succeeded. Do not suggest making a fresh proposal.
    return reply({ok:false,status:"VERIFY_LEDGER",error:"체결 저장 후 승인함 상태 확인이 실패했습니다. 동일 요청만 재확인하세요."},503);
  return reply({ok:true,status:"RECORDED",proposalId:proposal.id,executionId:expectedId,revision:saved.revision,reused:saved.reused});
}

export const Route=createFileRoute("/api/assistant-trades")({
  server:{handlers:{
    GET:async ({request})=>{
      try {
        const authenticated=await owner(request);
        if (!authenticated) return reply({error:"소유자 로그인이 필요합니다."},401);
        return reply({ok:true,proposals:await list(authenticated.userId)});
      } catch {return reply({error:"승인 대기내역을 불러오지 못했습니다."},503);}
    },
    POST:async ({request})=>{
      try {
        const authenticated=await owner(request);
        if (!authenticated) return reply({error:"소유자 로그인이 필요합니다."},401);
        if (!(request.headers.get("content-type")??"").includes("application/json"))
          return reply({error:"JSON 요청이 필요합니다."},415);
        return await apply(request,authenticated);
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          return reply({error:"입력값의 형식을 확인하세요."},400);
        // May be a conflict or transient journal error. Do not expose private internals.
        return reply({error:"원장 승인 기록을 확인할 수 없습니다. 새로고침 후 기존 기록을 먼저 대조하세요."},409);
      }
    },
  }},
});
