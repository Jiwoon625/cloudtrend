import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/cloud";
import { invalidateActualPositionViews } from "@/lib/dashboardActualRefresh";
import { cancelLedgerReads, invalidateLedgerReads } from "@/lib/ledgerUiMutation";
import type { AssistantTradeProposal } from "@/lib/assistantActualTrade";
import { assistantTradeGross, formatAssistantTradeMoney } from "@/lib/assistantActualTrade";

export const Route = createFileRoute("/assistant-trades")({
  ssr: false,
  head: () => ({ meta: [{ title: "ChatGPT 실제거래 승인 | CloudTrend" }] }),
  component: AssistantTrades,
});

function AssistantTrades() {
  const qc = useQueryClient();
  const [items, setItems] = useState<AssistantTradeProposal[]>([]);
  const [pendingPage, setPendingPage] = useState(0);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [hasMorePending, setHasMorePending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const authHeader = async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session)
      throw Object.assign(new Error("CloudTrend 소유자 계정으로 로그인하세요."), {
        code: "LOGIN_REQUIRED",
      });
    return { Authorization: `Bearer ${data.session.access_token}` };
  };
  const refresh = useCallback(async () => {
    setLoading(true);
    setLoaded(false);
    setLoadError(null);
    try {
      const fetchPage = async () =>
        fetch(`/api/assistant-trades?pendingPage=${pendingPage}`, {
          headers: await authHeader(),
          cache: "no-store",
        });
      let res = await fetchPage();
      if (res.status === 401) {
        const { error } = await supabase.auth.refreshSession();
        if (!error) res = await fetchPage();
      }
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        code?: string;
        proposals?: AssistantTradeProposal[];
        pendingTotal?: number;
        hasMorePending?: boolean;
      };
      if (!res.ok || !data.ok)
        throw Object.assign(new Error(data.error ?? "조회 실패"), {
          code: data.code ?? (res.status === 401 ? "LOGIN_REQUIRED" : "QUERY_FAILED"),
        });
      setItems(data.proposals ?? []);
      setPendingTotal(data.pendingTotal ?? 0);
      setHasMorePending(data.hasMorePending === true);
      setMessage("");
      setLoaded(true);
    } catch (error) {
      setItems([]);
      setLoadError({
        code:
          error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : "SERVER_ERROR",
        message: error instanceof Error ? error.message : "승인대기함을 불러오지 못했습니다.",
      });
    } finally {
      setLoading(false);
    }
  }, [pendingPage]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function act(id: string, action: "CONFIRM" | "REJECT") {
    if (busy || (action === "CONFIRM" && !approved[id])) return;
    setBusy(id);
    setMessage("");
    try {
      const res = await fetch("/api/assistant-trades", {
        method: "POST",
        headers: { ...(await authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify({ action, proposalId: id, confirmed: true }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; status?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "처리 결과를 확인하지 못했습니다.");
      setApproved((v) => ({ ...v, [id]: false }));
      // Offset pages shift when an active item leaves the list; always restart.
      if (pendingPage === 0) await refresh();
      else setPendingPage(0);
      setMessage(
        action === "CONFIRM"
          ? "기존 실제보유원장에 기록했습니다."
          : "제안만 반려했습니다. 원장은 변경되지 않았습니다.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "승인 결과 확인이 필요합니다.");
    } finally {
      // A lost response can still mean the fill committed. Reload on return to
      // either currency's portfolio, without triggering a hidden screening.
      if (action === "CONFIRM") {
        await Promise.all([
          qc.cancelQueries({ queryKey: ["new-actual-portfolio"] }),
          cancelLedgerReads(qc),
        ]);
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["new-actual-portfolio"], refetchType: "none" }),
          invalidateLedgerReads(qc, "none"),
          invalidateActualPositionViews(qc),
        ]);
      }
      setBusy(null);
    }
  }
  return (
    <main className="mx-auto max-w-4xl space-y-5 p-4 md:p-7">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold">ChatGPT 실제거래 승인대기함</h1>
        <Link to="/portfolio" search={{ asset: "KR" }} className="text-sm underline">
          실제보유원장으로 이동
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        한국·미국주식 매수·매도 모두 현재 홈페이지 계정으로 확인·반영합니다. 별도 서비스 로그인이나
        API 키는 필요하지 않습니다. 미국주식은 미국 현지 체결일과 USD 금액을 확인하세요. ChatGPT가
        작성한 거래는 승인 전에는 원장·현금·Shadow·과거 성과에 영향을 주지 않습니다. 실제 체결일,
        수량, 단가, 수수료 및 Notion 증빙을 직접 대조한 뒤 종목별로 승인하세요. 계좌 입출금은 자동
        생성하지 않습니다.
      </p>
      <button
        type="button"
        className="rounded border px-3 py-2 text-sm"
        onClick={() => void refresh()}
        disabled={loading || !!busy}
      >
        {loading ? "조회 중…" : "목록 새로고침"}
      </button>
      {message && (
        <p role="status" className="rounded border p-3 text-sm">
          {message}
        </p>
      )}
      {loadError && (
        <p role="alert" className="rounded border border-destructive p-3 text-sm">
          {loadError.code === "LOGIN_REQUIRED"
            ? "로그인 필요"
            : loadError.code === "OWNER_MISMATCH"
              ? "소유자 권한 불일치"
              : loadError.code === "QUERY_FAILED"
                ? "데이터 조회 실패"
                : "Supabase 연결 또는 서버 설정 오류"}{" "}
          · {loadError.message}
          {loadError.code === "LOGIN_REQUIRED" && (
            <>
              {" "}
              <Link to="/" className="underline">
                로그인 화면으로 이동
              </Link>
            </>
          )}
        </p>
      )}
      {loaded && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            승인대기·처리중 전체 {pendingTotal}건 · {pendingPage + 1}페이지
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded border px-3 py-1"
              disabled={pendingPage === 0 || loading || !!busy}
              onClick={() => setPendingPage((page) => Math.max(0, page - 1))}
            >
              이전
            </button>
            <button
              type="button"
              className="rounded border px-3 py-1"
              disabled={!hasMorePending || loading || !!busy}
              onClick={() => setPendingPage((page) => page + 1)}
            >
              다음
            </button>
          </div>
        </div>
      )}
      {loaded && items.length === 0 && (
        <p className="rounded border p-6 text-sm">
          정상 조회됐습니다. 현재 승인대기 거래가 없습니다.
        </p>
      )}
      <div className="space-y-3">
        {items.map((p) => {
          const t = p.trade;
          return (
            <section key={p.id} className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex flex-wrap justify-between gap-2">
                <h2 className="font-semibold">
                  {t.name} ({t.symbol}) · {t.side === "SELL" ? "매도" : "매수"}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {p.status === "PENDING"
                    ? "승인대기"
                    : p.status === "PROCESSING"
                      ? "승인 처리 중 · 원장 상태 확인 필요"
                      : p.status === "RECORDED"
                        ? "원장 기록됨"
                        : "반려됨"}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">실제 거래일</dt>
                  <dd>
                    {t.date}
                    {t.market === "US" ? " (미국 현지)" : " (한국)"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">시장·계좌</dt>
                  <dd>
                    {t.market} · {t.accountLabel}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">수량</dt>
                  <dd>{t.shares.toLocaleString("ko-KR")}주</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    평균 {t.side === "SELL" ? "매도" : "매수"}단가
                  </dt>
                  <dd>{formatAssistantTradeMoney(t.price, t.market)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t.side === "SELL" ? "매도금액" : "매수금액"}
                  </dt>
                  <dd>{formatAssistantTradeMoney(assistantTradeGross(t), t.market)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">증빙 수수료·세금 등 총비용</dt>
                  <dd>{formatAssistantTradeMoney(t.fee, t.market)}</dd>
                </div>
              </dl>
              <a
                href={`https://app.notion.com/p/${p.source_page_id.replace(/-/g, "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm underline"
              >
                Notion 거래 증빙 확인
              </a>
              <Link
                to="/portfolio"
                search={{ asset: t.market === "US" ? "US" : "KR" }}
                className="ml-4 text-sm underline"
              >
                {t.market === "US" ? "미국 실제보유원장 확인" : "한국 실제보유원장 확인"}
              </Link>
              {p.status === "PROCESSING" && (
                <p role="status" className="rounded border p-3 text-sm">
                  중복 저장 방지를 위해 처리 중입니다. 2분 이상 지속되면 목록을 새로고침하고 기존
                  원장을 대조한 뒤 같은 요청으로 승인 처리를 재시도할 수 있습니다.
                </p>
              )}
              {(p.status === "PENDING" || p.status === "PROCESSING") && (
                <div className="space-y-2 border-t pt-3">
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!approved[p.id]}
                      onChange={(e) => setApproved((v) => ({ ...v, [p.id]: e.target.checked }))}
                    />
                    {t.side === "SELL"
                      ? "증빙과 기존 실제보유원장을 대조했습니다. 매도 가능 보유수량 및 총 매매비용(수수료·세금 포함)을 확인했고, 매도 후 잔여수량이 맞습니다."
                      : "증빙과 기존 실제보유원장을 대조했습니다. 동일 종목·일자·가격의 별도 매수가 있더라도 실제 증빙이 구분되고 수량·가격·매매비용이 일치합니다."}
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void act(p.id, "CONFIRM")}
                      disabled={!approved[p.id] || !!busy}
                      className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-40"
                    >
                      {busy === p.id ? "처리 중…" : "실제보유원장에 반영"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void act(p.id, "REJECT")}
                      disabled={!!busy || p.status !== "PENDING"}
                      className="rounded border px-4 py-2 text-sm disabled:opacity-40"
                    >
                      반려
                    </button>
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                요청 ID: {p.id} · 소유자 승인 시 2026-10-12 신규 시리즈만 반영
              </p>
            </section>
          );
        })}
      </div>
    </main>
  );
}
