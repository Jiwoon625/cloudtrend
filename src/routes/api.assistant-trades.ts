import process from "node:process";
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  existingTradeMatches,
  sourceEvidenceMatches,
  parseAssistantActualTrade,
  assistantTradeGross,
  type AssistantTradeProposal,
} from "../lib/assistantActualTrade";
import { newActualAsset, projectNewActualPool } from "../lib/newActualPortfolio";
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

class AssistantTradesError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function configuredOwner() {
  // This single-owner app's verified Supabase auth user. Vercel production did
  // not set SUPABASE_USER_ID; a missing optional override must not disable the
  // exact owner check. A configured but invalid override still fails closed.
  const id = process.env["SUPABASE_USER_ID"]?.trim() || "bdfc8818-33a7-4030-9dbd-ecad39f223ac";
  if (!id || !z.string().uuid().safeParse(id).success)
    throw new AssistantTradesError(
      503,
      "SERVER_CONFIG",
      "거래 승인 서비스의 소유자 설정을 확인하세요.",
    );
  return id.toLowerCase();
}

async function owner(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token)
    throw new AssistantTradesError(401, "LOGIN_REQUIRED", "CloudTrend 소유자 로그인이 필요합니다.");
  const url = import.meta.env["VITE_SUPABASE_URL"] || "https://ahbvrtugugwnbrfnbxzp.supabase.co";
  if (new URL(url).hostname !== "ahbvrtugugwnbrfnbxzp.supabase.co")
    throw new AssistantTradesError(503, "SERVER_CONFIG", "Supabase 프로젝트 연결을 확인하세요.");
  const client = createClient(
    url,
    import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
      "sb_publishable_j1o5NMjbXz7UA1CsbCj1dA_hiMBgBlE",
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );
  const { data, error } = await client.auth.getUser(token);
  if (error?.status && error.status >= 500)
    throw new AssistantTradesError(503, "SUPABASE_CONNECTION", "Supabase 인증 연결을 확인하세요.");
  if (error || !data.user)
    throw new AssistantTradesError(
      401,
      "LOGIN_REQUIRED",
      "로그인 세션이 만료되었습니다. 다시 로그인하세요.",
    );
  if (data.user.id.toLowerCase() !== configuredOwner())
    throw new AssistantTradesError(
      403,
      "OWNER_MISMATCH",
      "현재 로그인 계정은 거래 승인 소유자가 아닙니다.",
    );
  return { client, userId: data.user.id, accessToken: token };
}

const PAGE_SIZE = 50;

/** Active proposals always come first; history is separate and cannot hide them. */
async function list(db: AuthenticatedOwner["client"], ownerId: string, page: number) {
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
  if (error)
    throw new AssistantTradesError(502, "QUERY_FAILED", "승인 대기내역 조회에 실패했습니다.");
  const { data: history, error: historyError } = await db
    .from("assistant_trade_proposals")
    .select("id,user_id,source_page_id,trade,status,ledger_execution_id,created_at")
    .eq("user_id", ownerId)
    .in("status", ["RECORDED", "REJECTED"])
    .order("created_at", { ascending: false })
    .limit(25);
  if (historyError)
    throw new AssistantTradesError(502, "QUERY_FAILED", "승인 처리내역 조회에 실패했습니다.");
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
  const trade = parseAssistantActualTrade(proposal.trade);
  return (
    existingTradeMatches(trade, execution) &&
    allocation?.quantity === trade.shares &&
    allocation.gross === assistantTradeGross(trade) &&
    allocation.fee === trade.fee &&
    allocation.brokerReference.toLowerCase() === "notion:" + proposal.source_page_id.toLowerCase()
  );
}

async function claimProposal(
  client: AuthenticatedOwner["client"],
  proposal: ProposalRow,
): Promise<string | null> {
  if (proposal.status !== "PENDING" && proposal.status !== "PROCESSING") return null;
  const { data, error } = await client.rpc("assistant_trade_claim", { p_id: proposal.id });
  if (error) throw transitionError(error);
  return data as string | null;
}

function transitionError(error: { code?: string }) {
  if (error.code === "PGRST202" || error.code === "42883")
    return new AssistantTradesError(
      503,
      "SERVER_CONFIG",
      "승인 상태 전환 설정을 확인하세요. 원장 기록은 시작되지 않았습니다.",
    );
  return new AssistantTradesError(
    502,
    "QUERY_FAILED",
    "승인 상태 변경에 실패했습니다. 다시 조회하세요.",
  );
}

async function markRecorded(
  client: AuthenticatedOwner["client"],
  proposal: ProposalRow,
  token: string,
) {
  const { data, error } = await client.rpc("assistant_trade_record", {
    p_id: proposal.id,
    p_token: token,
  });
  if (error) throw transitionError(error);
  if (!data)
    throw new Error("원장 체결 후 승인 상태 확인이 실패했습니다. 동일 요청을 재조회하세요.");
}

/** Deterministic pre-write conflicts must not leave the proposal locked forever. */
async function releaseClaim(
  client: AuthenticatedOwner["client"],
  proposal: ProposalRow,
  token: string,
) {
  const { data, error } = await client.rpc("assistant_trade_release", {
    p_id: proposal.id,
    p_token: token,
  });
  if (error) throw transitionError(error);
  if (!data)
    throw new Error(
      "원장 검토요청의 선점 해제를 확인하지 못했습니다. 기존 요청 상태를 재조회하세요.",
    );
}

/** A write is only attempted after exclusive proposal reservation. */
async function apply(request: Request, auth: AuthenticatedOwner) {
  const raw = await request.text();
  if (raw.length > 4096) return reply({ error: "요청 본문이 너무 큽니다." }, 413);
  const input = actionSchema.parse(JSON.parse(raw));
  const { data, error } = await auth.client
    .from("assistant_trade_proposals")
    .select(
      "id,user_id,source_page_id,trade,status,ledger_execution_id,created_at,processing_started_at",
    )
    .eq("user_id", auth.userId)
    .eq("id", input.proposalId)
    .maybeSingle();
  if (error) throw new AssistantTradesError(502, "QUERY_FAILED", "승인 요청 조회에 실패했습니다.");
  if (!data) return reply({ error: "소유자의 승인 요청을 찾을 수 없습니다." }, 404);
  const proposal = data as ProposalRow;
  if (input.action === "REJECT") {
    // REJECT cannot override PROCESSING: compare-and-set with the same PENDING row.
    if (proposal.status !== "PENDING")
      return reply({ error: "승인 처리 중이거나 이미 완료된 거래입니다." }, 409);
    const { data: updated, error: updateError } = await auth.client.rpc("assistant_trade_reject", {
      p_id: proposal.id,
    });
    if (updateError) throw transitionError(updateError);
    if (!updated)
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

  const trade = parseAssistantActualTrade(proposal.trade);
  if (trade.sourcePageId !== proposal.source_page_id.toLowerCase())
    return reply({ error: "거래 증빙 식별자가 일치하지 않습니다." }, 409);
  const token = await claimProposal(auth.client, proposal);
  if (!token)
    return reply(
      { error: "승인 처리 중입니다. 잠시 후 새로고침하고 기존 원장을 확인하세요." },
      409,
    );
  // Keep PROCESSING on ambiguous failures, so retries cannot race the original.
  const target = trade.market === "US" ? "us_actual_portfolio_ledgers" : "portfolio_ledgers";
  const [snapshot, other] = await Promise.all([
    readWebsiteDocument<NewActualDocument>(auth.client, auth.userId, target),
    readWebsiteDocument<NewActualDocument>(
      auth.client,
      auth.userId,
      target === "portfolio_ledgers" ? "us_actual_portfolio_ledgers" : "portfolio_ledgers",
    ),
  ]);
  if (
    other?.payload.executions.some((e) =>
      sourceEvidenceMatches(
        proposal.source_page_id,
        e,
        other.payload.newActualPortfolio?.assignments?.[e.id],
      ),
    )
  ) {
    await releaseClaim(auth.client, proposal, token);
    return reply({ error: "다른 시장 원장에 동일한 Notion 증빙이 이미 있습니다." }, 409);
  }
  if (!snapshot) {
    await releaseClaim(auth.client, proposal, token);
    return reply({ error: "실제 원장 준비 상태를 확인할 수 없습니다." }, 409);
  }
  const expectedId = "new-actual:" + proposal.id;
  const existing = snapshot.payload.executions.find((e) => e.id === expectedId);
  if (existing) {
    if (!sameSource(proposal, existing, snapshot.payload.newActualPortfolio?.assignments ?? {})) {
      await releaseClaim(auth.client, proposal, token);
      return reply(
        { error: "같은 거래 ID에 다른 체결이 있습니다. 자동 정합성 복구를 중지했습니다." },
        409,
      );
    }
    await markRecorded(auth.client, proposal, token);
    return reply({
      ok: true,
      status: "RECORDED",
      proposalId: proposal.id,
      executionId: expectedId,
      reused: true,
    });
  }
  // Fail before a ledger write and release the claim on a deterministic
  // symbol/market conflict, rather than stranding the item in PROCESSING.
  const marketConflict = snapshot.payload.executions.some(
    (execution) => execution.symbol === trade.symbol && execution.market !== trade.market,
  );
  if (marketConflict) {
    await releaseClaim(auth.client, proposal, token);
    return reply(
      {
        error:
          "기존 원장에 같은 종목이 다른 시장 분류로 등록되어 있습니다. ETF는 KOSPI가 아닌 ETF 분류로 정정한 후 재승인하세요.",
        code: "MARKET_MISMATCH",
      },
      409,
    );
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
    await releaseClaim(auth.client, proposal, token);
    return reply(
      { error: "동일한 Notion 증빙으로 이미 거래가 반영되어 있습니다. 제안을 반려할 수 있습니다." },
      409,
    );
  }

  // An approved sell must consume only documented post-start holdings in its
  // own currency pool. Reject over-sales BEFORE touching the canonical ledger.
  // Legacy inventory and Shadow positions are never an implicit source of shares.
  if (trade.side === "SELL") {
    let available = 0;
    try {
      const currency = trade.market === "US" ? "USD" : "KRW";
      const now = new Date();
      const day = now.toLocaleDateString("en-CA", {
        timeZone: currency === "USD" ? "America/New_York" : "Asia/Seoul",
      });
      const pool = projectNewActualPool({
        currency,
        executions: snapshot.payload.executions,
        metadata: snapshot.payload.newActualPortfolio ?? null,
        quotes: {},
        valuationDate: null,
        today: day,
        cashToday: now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }),
      });
      const holding = pool.positions.find(
        (position) => position.symbol === trade.symbol && position.market === trade.market,
      );
      available = holding ? Number(holding.quantity) : 0;
      if (!Number.isSafeInteger(available) || available < 0)
        throw new Error("Invalid actual position quantity");
    } catch {
      await releaseClaim(auth.client, proposal, token);
      return reply(
        { error: "매도 전 실제 보유수량을 확인하지 못했습니다. 원장을 점검하세요.", code: "HOLDINGS_CHECK_FAILED" },
        409,
      );
    }
    if (trade.shares > available) {
      await releaseClaim(auth.client, proposal, token);
      return reply(
        { error: `실제 보유수량 ${available}주보다 매도수량 ${trade.shares}주가 많습니다.`, code: "INSUFFICIENT_HOLDINGS" },
        409,
      );
    }
  }

  const saved = await saveNewActualPortfolio(
    auth.client,
    auth.userId,
    {
      action: "execution",
      asset: newActualAsset(trade.market),
      confirmed: true,
      accessToken: auth.accessToken,
      expectedRevision: snapshot.revision,
      requestId: proposal.id,
      execution: {
        id: "",
        date: trade.date,
        name: trade.name,
        side: trade.side,
        market: trade.market,
        symbol: trade.symbol,
        shares: trade.shares,
        price: trade.price,
        fee: trade.fee,
        note: `${trade.accountLabel} 실제${trade.side === "BUY" ? "매수" : "매도"} · ChatGPT 제안 / Notion 증빙 소유자 확인`,
      },
      allocation: {
        quantity: trade.shares,
        gross: assistantTradeGross(trade),
        fee: trade.fee,
        brokerReference: "notion:" + trade.sourcePageId,
      },
    },
    undefined,
    { proposalId: proposal.id, token },
  );
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
          const page = Number(new URL(request.url).searchParams.get("pendingPage") ?? "0");
          if (!Number.isSafeInteger(page) || page < 0 || page > 10000)
            return reply({ error: "페이지 번호가 올바르지 않습니다." }, 400);
          // The owner's JWT is used for the SELECT RLS policy. No server secret is
          // needed for a read, and an absent service key cannot hide real rows.
          return reply({
            ok: true,
            ...(await list(authenticated.client, authenticated.userId, page)),
          });
        } catch (error) {
          if (error instanceof AssistantTradesError)
            return reply({ error: error.message, code: error.code }, error.status);
          console.error("assistant-trades GET failed", error);
          return reply(
            { error: "Supabase 연결 또는 서버 설정을 확인하세요.", code: "SERVER_ERROR" },
            503,
          );
        }
      },
      POST: async ({ request }) => {
        try {
          const authenticated = await owner(request);
          if (!(request.headers.get("content-type") ?? "").includes("application/json"))
            return reply({ error: "JSON 요청이 필요합니다." }, 415);
          return await apply(request, authenticated);
        } catch (error) {
          if (error instanceof AssistantTradesError)
            return reply({ error: error.message, code: error.code }, error.status);
          if (error instanceof z.ZodError || error instanceof SyntaxError)
            return reply({ error: "입력값의 형식을 확인하세요." }, 400);
          // May be a conflict or transient journal error. Do not expose private internals.
          console.error("assistant-trades POST failed", error);
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
