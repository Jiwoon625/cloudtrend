import process from "node:process";
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { trustedSupabaseClient } from "../../scripts/analysis-run-store";
import {
  existingTradeMatches,
  sourceEvidenceMatches,
  parseAssistantActualBuy,
  type AssistantTradeProposal,
} from "../lib/assistantActualTrade";
import { readWebsiteDocument } from "../lib/ledger/websiteRepository.server";
import { saveNewActualPortfolio, type NewActualDocument } from "../lib/newActualPortfolio.server";

const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers });
const actionSchema = z
  .object({
    action: z.enum(["CONFIRM", "REJECT"]),
    proposalId: z.string().uuid(),
    confirmed: z.literal(true),
  })
  .strict();

function configuredOwner() {
  const id = process.env["SUPABASE_USER_ID"]?.trim();
  if (!id || !z.string().uuid().safeParse(id).success)
    throw new Error("거래 승인 서비스의 소유자 설정이 누락되었습니다.");
  return id;
}

async function owner(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token) return null;
  const client = createClient(
    import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co",
    import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
      "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user || data.user.id !== configuredOwner()) return null;
  return { client, userId: data.user.id, accessToken: token };
}

const PAGE_SIZE = 50;
const RECOVERY_LEASE_MS = 120_000;

/** Active proposals always come first; history is separate and cannot hide them. */
async function list(ownerId: string, page: number) {
  const db = trustedSupabaseClient();
  const {
    data: active,
    count,
    error,
  } = await db
    .from("assistant_trade_proposals")
    .select(
      "id,user_id,source_page_id,trade,status,ledger_execution_id,created_at,processing_started_at",
      { count: "exact" },
    )
    .eq("user_id", ownerId)
    .in("status", ["PENDING", "PROCESSING"])
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
  if (error) throw new Error("승인 대기내역을 조회하지 못했습니다.");
  const { data: history, error: historyError } = await db
    .from("assistant_trade_proposals")
    .select("id,user_id,source_page_id,trade,status,ledger_execution_id,created_at")
    .eq("user_id", ownerId)
    .in("status", ["RECORDED", "REJECTED"])
    .order("created_at", { ascending: false })
    .limit(25);
  if (historyError) throw new Error("승인 처리내역을 조회하지 못했습니다.");
  return {
    proposals: [
      ...(active ?? []),
      ...(page === 0 ? (history ?? []) : []),
    ] as AssistantTradeProposal[],
    pendingPage: page,
    pendingTotal: count ?? 0,
    hasMorePending: (page + 1) * PAGE_SIZE < (count ?? 0),
  };
}

type AuthenticatedOwner = NonNullable<Awaited<ReturnType<typeof owner>>>;
type ProposalRow = AssistantTradeProposal;
function sameSource(
  proposal: ProposalRow,
  execution: NewActualDocument["executions"][number],
  assignments: NonNullable<NewActualDocument["newActualPortfolio"]>["assignments"],
) {
  const allocation = assignments[execution.id];
  const trade = parseAssistantActualBuy(proposal.trade);
  return (
    existingTradeMatches(trade, execution) &&
    allocation?.quantity === trade.shares &&
    allocation.gross === trade.shares * trade.price &&
    allocation.fee === trade.fee &&
    allocation.brokerReference.toLowerCase() === "notion:" + proposal.source_page_id.toLowerCase()
  );
}

async function claimProposal(
  service: ReturnType<typeof trustedSupabaseClient>,
  proposal: ProposalRow,
  userId: string,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const now = new Date();
  const change = {
    status: "PROCESSING",
    processing_token: token,
    processing_started_at: now.toISOString(),
    reviewed_at: now.toISOString(),
  };
  let query = service
    .from("assistant_trade_proposals")
    .update(change)
    .eq("id", proposal.id)
    .eq("user_id", userId);
  if (proposal.status === "PENDING") {
    query = query.eq("status", "PENDING");
  } else if (proposal.status === "PROCESSING") {
    // Recover only after the original in-flight request is no longer live.
    // A retry still reconciles the immutable journal before any attempted write.
    const cutoff = new Date(now.getTime() - RECOVERY_LEASE_MS).toISOString();
    query = query.eq("status", "PROCESSING").lt("processing_started_at", cutoff);
  } else return null;
  const { data, error } = await query.select("id").maybeSingle();
  if (error) throw new Error("원장 승인 요청의 원자적 선점에 실패했습니다.");
  return data ? token : null;
}

async function markRecorded(
  service: ReturnType<typeof trustedSupabaseClient>,
  proposal: ProposalRow,
  userId: string,
  token: string,
  executionId: string,
) {
  const { data, error } = await service
    .from("assistant_trade_proposals")
    .update({
      status: "RECORDED",
      ledger_execution_id: executionId,
      processing_token: null,
      processing_started_at: null,
      reviewed_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("id", proposal.id)
    .eq("status", "PROCESSING")
    .eq("processing_token", token)
    .select("id")
    .maybeSingle();
  if (error || !data)
    throw new Error("원장 체결 후 승인 상태 확인이 실패했습니다. 동일 요청을 재조회하세요.");
}

/** Deterministic pre-write conflicts must not leave the proposal locked forever. */
async function releaseClaim(
  service: ReturnType<typeof trustedSupabaseClient>,
  proposal: ProposalRow,
  userId: string,
  token: string,
) {
  const {data,error}=await service.from("assistant_trade_proposals")
    .update({
      status:"PENDING", reviewed_at:null,
      processing_token:null, processing_started_at:null,
    })
    .eq("id",proposal.id).eq("user_id",userId)
    .eq("status","PROCESSING").eq("processing_token",token)
    .select("id").maybeSingle();
  if(error || !data)
    throw new Error("원장 검토요청의 선점 해제를 확인하지 못했습니다. 기존 요청 상태를 재조회하세요.");
}

/** A write is only attempted after exclusive proposal reservation. */
async function apply(request: Request, auth: AuthenticatedOwner) {
  const raw = await request.text();
  if (raw.length > 4096) return reply({ error: "요청 본문이 너무 큽니다." }, 413);
  const input = actionSchema.parse(JSON.parse(raw));
  const service = trustedSupabaseClient();
  const { data, error } = await service
    .from("assistant_trade_proposals")
    .select(
      "id,user_id,source_page_id,trade,status,ledger_execution_id,created_at,processing_started_at",
    )
    .eq("user_id", auth.userId)
    .eq("id", input.proposalId)
    .maybeSingle();
  if (error || !data) return reply({ error: "소유자의 승인 요청을 찾을 수 없습니다." }, 404);
  const proposal = data as ProposalRow;
  if (input.action === "REJECT") {
    // REJECT cannot override PROCESSING: compare-and-set with the same PENDING row.
    if (proposal.status !== "PENDING")
      return reply({ error: "승인 처리 중이거나 이미 완료된 거래입니다." }, 409);
    const { data: updated, error: updateError } = await service
      .from("assistant_trade_proposals")
      .update({ status: "REJECTED", reviewed_at: new Date().toISOString() })
      .eq("id", proposal.id)
      .eq("user_id", auth.userId)
      .eq("status", "PENDING")
      .select("id")
      .maybeSingle();
    if (updateError || !updated)
      return reply({ error: "승인과 반려가 동시에 처리됐습니다. 목록을 새로고침하세요." }, 409);
    return reply({ ok: true, status: "REJECTED", proposalId: proposal.id });
  }
  if (proposal.status === "RECORDED")
    return reply({
      ok: true,
      status: "RECORDED",
      proposalId: proposal.id,
      executionId: proposal.ledger_execution_id,
      reused: true,
    });
  if (proposal.status === "REJECTED") return reply({ error: "이미 반려된 요청입니다." }, 409);

  const trade = parseAssistantActualBuy(proposal.trade);
  if (trade.sourcePageId !== proposal.source_page_id.toLowerCase())
    return reply({ error: "거래 증빙 식별자가 일치하지 않습니다." }, 409);
  const token = await claimProposal(service, proposal, auth.userId);
  if (!token)
    return reply(
      { error: "승인 처리 중입니다. 잠시 후 새로고침하고 기존 원장을 확인하세요." },
      409,
    );
  // Keep PROCESSING on ambiguous failures, so retries cannot race the original.
  const snapshot = await readWebsiteDocument<NewActualDocument>(
    auth.client,
    auth.userId,
    "portfolio_ledgers",
  );
  if (!snapshot) {
    await releaseClaim(service,proposal,auth.userId,token);
    return reply({ error: "실제 원장 준비 상태를 확인할 수 없습니다." }, 409);
  }
  const expectedId = "new-actual:" + proposal.id;
  const existing = snapshot.payload.executions.find((e) => e.id === expectedId);
  if (existing) {
    if (!sameSource(proposal, existing, snapshot.payload.newActualPortfolio?.assignments ?? {})) {
      await releaseClaim(service,proposal,auth.userId,token);
      return reply(
        { error: "같은 거래 ID에 다른 체결이 있습니다. 자동 정합성 복구를 중지했습니다." },
        409,
      );
    }
    await markRecorded(service, proposal, auth.userId, token, expectedId);
    return reply({
      ok: true,
      status: "RECORDED",
      proposalId: proposal.id,
      executionId: expectedId,
      reused: true,
    });
  }
  // Reject the same evidence ID, not identical economic terms from a different
  // Notion record: two separate ISA/GENERAL fills can have identical amounts.
  const duplicateSource = snapshot.payload.executions.some((e) =>
    sourceEvidenceMatches(
      proposal.source_page_id,
      e,
      snapshot.payload.newActualPortfolio?.assignments?.[e.id],
    ),
  );
  if (duplicateSource) {
    await releaseClaim(service,proposal,auth.userId,token);
    return reply({ error: "동일한 Notion 증빙으로 이미 매수가 반영되어 있습니다. 제안을 반려할 수 있습니다." }, 409);
  }

  const saved = await saveNewActualPortfolio(auth.client, auth.userId, {
    action: "execution",
    asset: "KR",
    confirmed: true,
    accessToken: auth.accessToken,
    expectedRevision: snapshot.revision,
    requestId: proposal.id,
    execution: {
      id: "",
      date: trade.date,
      name: trade.name,
      side: "BUY",
      market: trade.market,
      symbol: trade.symbol,
      shares: trade.shares,
      price: trade.price,
      fee: trade.fee,
      note: `${trade.accountLabel} 실제매수 · ChatGPT 제안 / Notion 증빙 소유자 확인`,
    },
    allocation: {
      quantity: trade.shares,
      gross: trade.price * trade.shares,
      fee: trade.fee,
      brokerReference: "notion:" + trade.sourcePageId,
    },
  });
  await markRecorded(service, proposal, auth.userId, token, expectedId);
  return reply({
    ok: true,
    status: "RECORDED",
    proposalId: proposal.id,
    executionId: expectedId,
    revision: saved.revision,
    reused: saved.reused,
  });
}

export const Route = createFileRoute("/api/assistant-trades")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const authenticated = await owner(request);
          if (!authenticated) return reply({ error: "소유자 로그인이 필요합니다." }, 401);
          const page = Number(new URL(request.url).searchParams.get("pendingPage") ?? "0");
          if (!Number.isSafeInteger(page) || page < 0 || page > 10000)
            return reply({ error: "페이지 번호가 올바르지 않습니다." }, 400);
          return reply({ ok: true, ...(await list(authenticated.userId, page)) });
        } catch {
          return reply({ error: "승인 대기내역을 불러오지 못했습니다." }, 503);
        }
      },
      POST: async ({ request }) => {
        try {
          const authenticated = await owner(request);
          if (!authenticated) return reply({ error: "소유자 로그인이 필요합니다." }, 401);
          if (!(request.headers.get("content-type") ?? "").includes("application/json"))
            return reply({ error: "JSON 요청이 필요합니다." }, 415);
          return await apply(request, authenticated);
        } catch (error) {
          if (error instanceof z.ZodError || error instanceof SyntaxError)
            return reply({ error: "입력값의 형식을 확인하세요." }, 400);
          // May be a conflict or transient journal error. Do not expose private internals.
          return reply(
            {
              error:
                "원장 승인 기록을 확인할 수 없습니다. 새로고침 후 기존 기록을 먼저 대조하세요.",
            },
            409,
          );
        }
      },
    },
  },
});
