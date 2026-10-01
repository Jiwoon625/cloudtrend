import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BriefcaseBusiness, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { PortfolioAssetHub } from "@/components/PortfolioAssetHub";
import { StrategyDescription } from "@/components/StrategyDescription";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatWon, formatPercent, formatPrice } from "@/lib/format";
import { supabase } from "@/lib/cloud";
import { portfolioLedgersServer } from "@/lib/portfolioLedgers.functions";
import type { ActualExecution, Candidate, DualPortfolioState } from "@/lib/portfolioLedgers";
import type { PortfolioSummary } from "@/lib/portfolioStoreCore";
import type { LedgerRequest } from "@/lib/portfolioLedgers.server";

export const Route = createFileRoute("/portfolio")({
  ssr: false,
  head: () => ({ meta: [{ title: "포트폴리오 | 전략 성과 · 실제 투자" }] }),
  component: PortfolioPage,
});
const QUERY = ["portfolio-ledgers"];
async function request(input: LedgerRequest): Promise<DualPortfolioState> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("먼저 로그인해 주세요.");
  return portfolioLedgersServer({ data: { ...input, accessToken: data.session.access_token } });
}
const pnlClass = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-muted-foreground");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
function SummaryCard({
  title,
  caption,
  s,
  capital,
}: {
  title: string;
  caption: string;
  s: PortfolioSummary;
  capital: number;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <span className="rounded-full bg-muted px-2 py-1 text-xs">보유 {s.openPositions} / 30</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{caption}</p>
      <p className={`num mt-4 text-2xl font-bold ${pnlClass(s.totalPnl)}`}>
        {formatWon(s.totalPnl)}{" "}
        <span className="text-base">({formatPercent(s.totalReturn, 2)})</span>
      </p>
      <p className="text-xs text-muted-foreground">누적손익 · 기준자금 {formatWon(capital)}</p>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        {[
          ["총 평가자산", s.equity],
          ["현금", s.cash],
          ["실현손익", s.realizedPnl],
          ["평가손익", s.unrealizedPnl],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="num mt-1 font-medium">{formatWon(Number(value))}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
function StockLink({ symbol, name }: { symbol: string; name: string }) {
  return (
    <Link to="/instrument/$symbol" params={{ symbol }} className="font-medium hover:underline">
      {name}
      <span className="ml-1 text-[10px] text-muted-foreground">{symbol}</span>
    </Link>
  );
}
function LedgerTable({
  title,
  caption,
  headers,
  children,
  empty,
}: {
  title: string;
  caption?: string;
  headers: string[];
  children: ReactNode;
  empty?: boolean;
}) {
  return (
    <section className="mb-4 overflow-hidden rounded-lg border bg-card" aria-label={title}>
      <div className="border-b p-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {caption ? <p className="mt-1 text-xs text-muted-foreground">{caption}</p> : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr>
              {headers.map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {empty ? (
              <tr>
                <td colSpan={headers.length} className="p-8 text-center text-muted-foreground">
                  표시할 기록이 없습니다.
                </td>
              </tr>
            ) : (
              children
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
const td = "whitespace-nowrap px-3 py-3";
type Edit = {
  id: string;
  symbol: string;
  name: string;
  market: ActualExecution["market"];
  signalKey: string | null;
  side: "BUY" | "SELL";
  date: string;
  price: string;
  shares: string;
  fee: string;
  note: string;
};

function PortfolioPage() {
  return <PortfolioAssetHub domestic={<KoreaPortfolioContent />} />;
}

function KoreaPortfolioContent() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: QUERY,
    queryFn: () => request({ action: "sync" }),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const state = query.data,
    doc = state?.document,
    strategy = doc?.strategy;
  const [tab, setTab] = useState<"strategy" | "actual" | "signals">("actual");
  const [busy, setBusy] = useState(false),
    [edit, setEdit] = useState<Edit | null>(null);
  const [capitals, setCapitals] = useState<{ strategy: string; actual: string } | null>(null);
  const [filter, setFilter] = useState("");
  const editPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!edit) return;
    editPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    editPanel.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [edit?.id, edit?.symbol, edit?.side]);
  async function mutate(input: LedgerRequest) {
    setBusy(true);
    try {
      const next = await request({ ...input, revision: state?.revision });
      qc.setQueryData(QUERY, next);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "저장에 실패했습니다.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  function beginBuy(c: Candidate) {
    setEdit({
      id: "",
      symbol: c.symbol,
      name: c.name,
      market: c.market,
      signalKey: c.key,
      side: "BUY",
      date: c.entryDate ?? today(),
      price: String(c.price ?? strategy?.quotes[c.symbol]?.price ?? ""),
      shares: "0",
      fee: "0",
      note: doc?.excluded[c.key] ?? "",
    });
  }
  async function saveExecution() {
    if (!edit) return;
    const shares = Number(edit.shares),
      price = Number(edit.price),
      fee = Number(edit.fee);
    if (edit.shares.trim() === "" || !Number.isInteger(shares) || shares < 0) {
      toast.error("수량은 0 이상의 정수로 입력하세요.");
      return;
    }
    if (shares === 0) {
      if (edit.side === "SELL" || !edit.signalKey) {
        toast.error("매도수량은 1주 이상이어야 합니다.");
        return;
      }
      if (
        await mutate({
          action: "exclude",
          signalKey: edit.signalKey,
          executionId: edit.id || undefined,
          note: edit.note || "미매수 · 0주",
        })
      ) {
        setEdit(null);
        toast.success("미매수 0주로 저장했습니다. 전략 원장은 유지됩니다.");
      }
      return;
    }
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(fee) || fee < 0) {
      toast.error("체결가격과 수수료·세금을 확인하세요.");
      return;
    }
    if (await mutate({ action: "execution", execution: { ...edit, shares, price, fee } })) {
      setEdit(null);
      toast.success("실제 체결만 반영했습니다. 전략 원장은 변경되지 않습니다.");
    }
  }
  const matches = (v: { symbol: string; name: string }) =>
    !filter || `${v.symbol} ${v.name}`.toLowerCase().includes(filter.toLowerCase());
  const modelTrades = [...(strategy?.trades ?? [])].sort(
    (a, b) =>
      Number(a.status === "CLOSED") - Number(b.status === "CLOSED") ||
      b.entryDate.localeCompare(a.entryDate),
  );
  const candidates = [...(strategy?.candidates ?? [])].sort((a, b) =>
    b.signalDate.localeCompare(a.signalDate),
  );
  const bought = new Map<string, number>();
  for (const e of doc?.executions ?? [])
    if (e.side === "BUY" && e.signalKey)
      bought.set(e.signalKey, (bought.get(e.signalKey) ?? 0) + e.shares);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <BriefcaseBusiness className="size-5 text-primary" />
            한국주식 포트폴리오
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            전략대로 운용한 성과와 내가 실제로 투자한 손익을 따로 확인합니다.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching || busy}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          이력 동기화
        </Button>
      </div>
      {query.error ? (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/30 p-4 text-sm">
          {query.error instanceof Error ? query.error.message : "원장을 불러오지 못했습니다."}
          <Button className="ml-3" variant="outline" onClick={() => void query.refetch()}>
            다시 시도
          </Button>
        </div>
      ) : null}
      {!state && query.isPending ? (
        <div className="p-10 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto mb-3 animate-spin" />두 원장을 준비하고 있습니다. 첫 동기화는
          저장된 신호를 순서대로 계산합니다.
        </div>
      ) : null}
      {state && doc && strategy ? (
        <>
          <div className="mb-4 grid gap-3 lg:grid-cols-2">
            <SummaryCard
              title="전략 포트폴리오"
              caption="Onset 자동 진입 · 규칙에 따른 자동 청산 · 개인 미매수와 독립"
              s={strategy.summary}
              capital={doc.settings.initialCapital}
            />
            <SummaryCard
              title="실제 투자"
              caption="입력한 매수·매도 체결만 반영 · 미매수 0주는 보유 상한에서 제외"
              s={state.actual.summary}
              capital={doc.actualCapital}
            />
          </div>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              저장된 스크리닝 이력 {strategy.firstSignalDate ?? "-"}부터 · 평가 기준{" "}
              {strategy.summary.latestDate ?? "-"} · 두 원장 각각 최대 30종목
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setCapitals({
                  strategy: String(doc.settings.initialCapital),
                  actual: String(doc.actualCapital),
                })
              }
            >
              운용자금 설정
            </Button>
          </div>
          {capitals ? (
            <section className="mb-4 rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs">
                  전략 기준자금
                  <Input
                    className="mt-1"
                    type="number"
                    min="1"
                    value={capitals.strategy}
                    onChange={(e) => setCapitals({ ...capitals, strategy: e.target.value })}
                  />
                </label>
                <label className="text-xs">
                  실제 운용자금
                  <Input
                    className="mt-1"
                    type="number"
                    min="1"
                    value={capitals.actual}
                    onChange={(e) => setCapitals({ ...capitals, actual: e.target.value })}
                  />
                </label>
                <Button
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await mutate({
                        action: "capital",
                        strategyCapital: Number(capitals.strategy),
                        actualCapital: Number(capitals.actual),
                      })
                    )
                      setCapitals(null);
                  }}
                >
                  저장
                </Button>
                <Button variant="ghost" onClick={() => setCapitals(null)}>
                  취소
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                전략 기준자금 변경 시 저장된 신호부터 전략 수량을 다시 계산합니다. 실제 체결 수량은
                유지됩니다.
              </p>
            </section>
          ) : null}
          <details className="mb-4 rounded-lg border bg-card p-3 text-xs">
            <summary className="cursor-pointer font-medium">운용 규칙과 손익 기준</summary>
            <div className="mt-3">
              <StrategyDescription />
              <p className="mt-2 leading-relaxed text-muted-foreground">
                전략은 다음 거래일 시가 진입·신호 청산, 60거래일 종가 만기, 왕복 0.30% 비용을
                적용합니다. 같은 날 후보는 기술점수 → 우선순위점수 → 종목코드 순입니다. 실제 원장은
                입력한 체결만 반영하며 청산 신호로 자동 매도하지 않습니다. 실제 손익은 입력한
                수수료·세금과 이동평균 매입원가를 사용합니다. 미체결 매도비용과 배당은 포함하지
                않습니다. 과거 이관 기록은 기존 비용을 유지합니다.
              </p>
            </div>
          </details>
          {state.actual.summary.cash < 0 ? (
            <p className="mb-3 text-sm text-down">
              실제 체결금액이 운용자금을 초과했습니다. 추가 입금이 있었다면 실제 운용자금을 맞춰
              주세요.
            </p>
          ) : null}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div
              className="flex gap-1 rounded-lg bg-muted p-1"
              role="tablist"
              aria-label="포트폴리오 원장"
            >
              {[
                ["strategy", "전략 원장"],
                ["actual", "실제 보유·거래"],
                ["signals", "Onset · 미매수"],
              ].map(([value, label]) => (
                <Button
                  key={value}
                  role="tab"
                  aria-selected={tab === value}
                  variant={tab === value ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setTab(value as typeof tab)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <Input
              aria-label="원장 종목 검색"
              placeholder="종목명 / 종목코드 검색"
              className="max-w-xs"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          {edit ? (
            <section
              className="mb-4 rounded-lg border border-primary/40 bg-card p-4"
              ref={editPanel}
              aria-label="실제 체결 입력"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="font-semibold">
                    {edit.side === "BUY" ? "실제 매수" : "실제 매도"} · {edit.name}
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    실제 체결한 값을 입력하세요. 같은 날짜의 체결은 입력 순서대로 계산합니다.
                  </p>
                </div>
                <Button
                  aria-label="체결 입력 닫기"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEdit(null)}
                >
                  <X className="size-4" />
                </Button>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-4">
                {[
                  ["date", "체결일", "date"],
                  ["price", "체결가격", "number"],
                  ["shares", "체결수량", "number"],
                  ["fee", "수수료·세금 합계", "number"],
                ].map(([field, label, type]) => (
                  <label key={field} className="text-xs">
                    {label}
                    <Input
                      className="mt-1"
                      type={type}
                      min={type === "number" ? "0" : undefined}
                      value={edit[field as "date" | "price" | "shares" | "fee"]}
                      onChange={(e) => setEdit({ ...edit, [field!]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
              <label className="mt-3 block text-xs">
                메모 / 미매수 사유
                <Input
                  className="mt-1"
                  placeholder="예: 독립성 정책으로 미매수"
                  value={edit.note}
                  onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                />
              </label>
              <div className="mt-3 flex items-center gap-3">
                <Button disabled={busy} onClick={() => void saveExecution()}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}실제 원장에 저장
                </Button>
                <p className="text-xs text-muted-foreground">
                  매수 수량을 0주로 저장하면 미매수로 남고 전략 성과에는 영향을 주지 않습니다.
                </p>
              </div>
            </section>
          ) : null}
          {tab === "strategy" ? (
            <LedgerTable
              title="전략 원장 · 가상 매수·매도"
              caption={`전체 Onset ${candidates.length}건 중 전략 진입 ${modelTrades.length}건. 한도 초과와 체결 대기는 Onset 탭에서 확인합니다.`}
              headers={[
                "종목",
                "신호일",
                "진입일",
                "진입가 / 수량",
                "상태",
                "현재가 / 청산가",
                "청산일 · 사유",
                "손익",
                "수익률",
              ]}
              empty={!modelTrades.filter(matches).length}
            >
              {modelTrades.filter(matches).map((t) => {
                const pnl =
                  t.status === "CLOSED"
                    ? (t.realizedPnl ?? 0)
                    : t.shares * (t.currentPrice ?? t.entryPrice) - t.buyAmount - t.entryFee;
                return (
                  <tr key={t.id} className="border-t">
                    <td className={td}>
                      <StockLink {...t} />
                    </td>
                    <td className={td}>{t.signalDate}</td>
                    <td className={td}>{t.entryDate}</td>
                    <td className={td}>
                      {formatPrice(t.entryPrice)} / {t.shares}주
                    </td>
                    <td className={td}>{t.currentStatus}</td>
                    <td className={td}>
                      {formatPrice(t.status === "CLOSED" ? t.exitPrice : t.currentPrice)}
                    </td>
                    <td className={td}>
                      {t.exitDate ?? "-"}
                      <br />
                      {t.exitReason}
                    </td>
                    <td className={`${td} ${pnlClass(pnl)}`}>{formatWon(pnl)}</td>
                    <td className={`${td} ${pnlClass(pnl)}`}>
                      {formatPercent((pnl / (t.buyAmount + t.entryFee)) * 100, 2)}
                    </td>
                  </tr>
                );
              })}
            </LedgerTable>
          ) : null}
          {tab === "actual" ? (
            <>
              <LedgerTable
                title={`실제 보유 종목 · ${state.actual.positions.length} / 30`}
                headers={[
                  "종목",
                  "보유수량",
                  "평균원가",
                  "현재가",
                  "평가금액",
                  "평가손익",
                  "전략 청산 신호",
                  "실제 체결",
                ]}
                empty={!state.actual.positions.filter(matches).length}
              >
                {state.actual.positions.filter(matches).map((p) => (
                  <tr key={p.symbol} className="border-t">
                    <td className={td}>
                      <StockLink {...p} />
                    </td>
                    <td className={td}>{p.shares}주</td>
                    <td className={td}>{formatPrice(p.averagePrice)}</td>
                    <td className={td}>
                      {formatPrice(p.currentPrice)}
                      <br />
                      <span className="text-muted-foreground">{p.markDate ?? "체결가 기준"}</span>
                    </td>
                    <td className={td}>{formatWon(p.marketValue)}</td>
                    <td className={`${td} ${pnlClass(p.unrealizedPnl)}`}>
                      {formatWon(p.unrealizedPnl)}
                    </td>
                    <td className={td}>
                      {p.exitSignal ?? "없음"}
                      <br />
                      <span className="text-muted-foreground">실제 매도는 직접 기록</span>
                    </td>
                    <td className={td}>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          setEdit({
                            id: "",
                            symbol: p.symbol,
                            name: p.name,
                            market: p.market,
                            signalKey: null,
                            side: "SELL",
                            date: today(),
                            price: String(p.currentPrice),
                            shares: String(p.shares),
                            fee: "0",
                            note: "",
                          })
                        }
                      >
                        매도 기록
                      </Button>
                    </td>
                  </tr>
                ))}
              </LedgerTable>
            </>
          ) : null}
          {tab === "signals" ? (
            <LedgerTable
              title="전체 Onset · 실제 매수 여부"
              caption="전략 한도와 관계없이 모든 신호를 보여줍니다. 새 신호는 실제 수량 0주로 시작하며, 매수한 경우에만 체결을 입력하세요."
              headers={[
                "종목",
                "신호일",
                "전략 판단",
                "전략 진입일",
                "실제 매수 누계",
                "실제 상태 / 사유",
                "체결 입력",
              ]}
              empty={!candidates.filter(matches).length}
            >
              {candidates.filter(matches).map((c) => (
                <tr key={c.key} className="border-t">
                  <td className={td}>
                    <StockLink {...c} />
                  </td>
                  <td className={td}>{c.signalDate}</td>
                  <td className={td}>{c.decision}</td>
                  <td className={td}>{c.entryDate ?? "다음 거래일 대기"}</td>
                  <td className={td}>{bought.get(c.key) ?? 0}주</td>
                  <td className={td}>
                    {bought.has(c.key)
                      ? "실제 체결 기록됨"
                      : (doc.excluded[c.key] ?? "미체결 · 확인 대기")}
                  </td>
                  <td className={td}>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => beginBuy(c)}>
                      매수 / 미매수 기록
                    </Button>
                  </td>
                </tr>
              ))}
            </LedgerTable>
          ) : null}
        </>
      ) : null}
    </>
  );
}
