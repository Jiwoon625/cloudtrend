import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/cloud";
import type { AssistantTradeProposal } from "@/lib/assistantActualTrade";

export const Route = createFileRoute("/assistant-trades")({
  ssr: false,
  head: () => ({ meta: [{ title: "ChatGPT 실제거래 승인 | CloudTrend" }] }),
  component: AssistantTrades,
});

function money(n: number) {
  return n.toLocaleString("ko-KR") + "원";
}
function AssistantTrades() {
  const [items, setItems] = useState<AssistantTradeProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const authHeader = async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) throw new Error("CloudTrend 소유자 계정으로 로그인하세요.");
    return { Authorization: `Bearer ${data.session.access_token}` };
  };
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/assistant-trades", {
        headers: await authHeader(),
        cache: "no-store",
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        proposals?: AssistantTradeProposal[];
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "조회 실패");
      setItems(data.proposals ?? []);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "승인대기함을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);
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
      await refresh();
      setMessage(
        action === "CONFIRM"
          ? "기존 실제보유원장에 기록했습니다."
          : "제안만 반려했습니다. 원장은 변경되지 않았습니다.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "승인 결과 확인이 필요합니다.");
    } finally {
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
        ChatGPT가 작성한 거래는 승인 전에는 원장·현금·Shadow·과거 성과에 영향을 주지 않습니다. 실제
        체결일, 수량, 단가, 수수료 및 Notion 증빙을 직접 대조한 뒤 종목별로 승인하세요. 계좌
        입출금은 자동 생성하지 않습니다.
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
      {items.length === 0 && !loading && (
        <p className="rounded border p-6 text-sm">현재 표시할 제안이 없습니다.</p>
      )}
      <div className="space-y-3">
        {items.map((p) => {
          const t = p.trade;
          return (
            <section key={p.id} className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex flex-wrap justify-between gap-2">
                <h2 className="font-semibold">
                  {t.name} ({t.symbol})
                </h2>
                <span className="text-xs text-muted-foreground">
                  {p.status === "PENDING"
                    ? "승인대기"
                    : p.status === "RECORDED"
                      ? "원장 기록됨"
                      : "반려됨"}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">실제 거래일</dt>
                  <dd>{t.date}</dd>
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
                  <dt className="text-muted-foreground">평균 매수단가</dt>
                  <dd>{money(t.price)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">매수금액</dt>
                  <dd>{money(t.price * t.shares)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">증빙 수수료</dt>
                  <dd>{money(t.fee)}</dd>
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
              {p.status === "PENDING" && (
                <div className="space-y-2 border-t pt-3">
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!approved[p.id]}
                      onChange={(e) => setApproved((v) => ({ ...v, [p.id]: e.target.checked }))}
                    />
                    증빙과 기존 실제보유원장을 대조했으며 위 수량·가격·수수료가 실제 체결 내역과
                    일치합니다.
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
                      disabled={!!busy}
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
