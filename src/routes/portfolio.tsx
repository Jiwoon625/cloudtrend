import {
  projectExecutionMemo,
  rejectExecutionMemoUrls,
  splitExecutionMemo,
} from "@/lib/ledger/executionMemo";
import { createFileRoute, Link, type SearchSchemaInput } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BriefcaseBusiness, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { PortfolioAssetHub, type PortfolioAsset } from "@/components/PortfolioAssetHub";
import { useDashboardOperations } from "@/components/DashboardOperations";
import { DomesticAssessmentPanel } from "@/components/DomesticAssessmentPanel";
import { StrategyDescription } from "@/components/StrategyDescription";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatWon, formatPercent, formatPrice } from "@/lib/format";
import { supabase } from "@/lib/cloud";
import { portfolioLedgersServer } from "@/lib/portfolioLedgers.functions";
import type { ActualExecution, Candidate, DualPortfolioState } from "@/lib/portfolioLedgers";
import { buildKrPendingEntryPreview } from "@/lib/portfolioPendingEntries";
import { domesticPortfolioQueryOptions } from "@/lib/portfolioPositionContext";
import { waitForPortfolioSync } from "@/lib/portfolioSyncRequest";
import type { LedgerRequest } from "@/lib/portfolioLedgers.server";
import {
  acknowledgeLedgerReload,
  createLedgerEditSession,
  createLedgerWriteGuard,
  LEDGER_CASH_NOTE,
  LEDGER_RECONCILE_MESSAGE,
  runLedgerWrite,
  type LedgerEditSession,
} from "@/lib/ledgerUiMutation";

export const Route = createFileRoute("/portfolio")({
  ssr: false,
  validateSearch: (
    search: Record<string, unknown> & SearchSchemaInput,
  ): { asset: PortfolioAsset } => ({
    asset: search["asset"] === "US" || search["asset"] === "ETF" ? search["asset"] : "KR",
  }),
  head: () => ({ meta: [{ title: "포트폴리오 | 실제 보유·체결" }] }),
  component: PortfolioPage,
});
const QUERY = ["portfolio-ledgers"];
async function request(input: LedgerRequest): Promise<DualPortfolioState> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("먼저 로그인해 주세요.");
  return portfolioLedgersServer({ data: { ...input, accessToken: data.session.access_token } });
}
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const calculatedAtLabel = (value: string | undefined) =>
  value && Number.isFinite(Date.parse(value))
    ? `${new Date(value).toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })} KST`
    : "미확인";
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
  sourceLinks?: ActualExecution["sourceLinks"];
};

function PortfolioPage() {
  const { asset } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PortfolioAssetHub
      domestic={<KoreaPortfolioContent />}
      selectedAsset={asset}
      onAssetChange={(next) => {
        void navigate({ search: { asset: next } });
      }}
    />
  );
}

export function KoreaPortfolioContent() {
  const qc = useQueryClient();
  const query = useQuery({
    ...domesticPortfolioQueryOptions,
  });
  const state = query.data,
    doc = state?.document,
    strategy = doc?.strategy;
  const assessments = useDashboardOperations(Boolean(state), state?.revision?.toString());
  const [tab, setTab] = useState<"strategy" | "actual" | "signals">("actual");
  const [busy, setBusy] = useState(false),
    [edit, setEdit] = useState<Edit | null>(null);
  const [capitals, setCapitals] = useState<{ strategy: string; actual: string } | null>(null);
  const [filter, setFilter] = useState("");
  const editPanel = useRef<HTMLElement>(null);
  const editorOpen = edit !== null;
  useEffect(() => {
    if (!editorOpen) return;
    editPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    editPanel.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [editorOpen, edit?.id, edit?.symbol, edit?.side]);
  const writeGuard = useRef(createLedgerWriteGuard());
  const editSession = useRef<LedgerEditSession | null>(null);
  const capitalSession = useRef<LedgerEditSession | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  function openEditor(next: Edit) {
    if (writeGuard.current.pending || writeGuard.current.needsReload) return;
    if (edit && editSession.current?.needsReview) {
      toast.error("저장 내용을 확인한 뒤 현재 입력을 닫고 다시 열어 주세요.");
      return;
    }
    editSession.current = createLedgerEditSession(state?.revision);
    setEdit(projectExecutionMemo(next));
  }
  function closeEditor() {
    if (writeGuard.current.pending) return;
    setEdit(null);
    editSession.current = null;
  }
  async function refresh() {
    if (writeGuard.current.pending) return;
    const result = await query.refetch();
    acknowledgeLedgerReload(writeGuard.current, !result.isError);
    if (!result.isError) setWriteError(null);
  }
  async function mutate(input: LedgerRequest, session = createLedgerEditSession(state?.revision)) {
    return runLedgerWrite({
      guard: writeGuard.current,
      session,
      client: qc,
      queryKey: QUERY,
      waitForReadRefresh: input.action !== "sync",
      request: (revision) =>
        input.action === "sync"
          ? waitForPortfolioSync(() => request({ ...input, revision }))
          : request({ ...input, revision }),
      onBusy: setBusy,
      onError: (message) => {
        setWriteError(message);
        toast.error(message);
      },
    });
  }
  async function synchronize() {
    if (writeGuard.current.pending || writeGuard.current.needsReload) return;
    setSyncing(true);
    try {
      if (await mutate({ action: "sync" })) {
        const latest = qc.getQueryData<DualPortfolioState>(QUERY)?.document.strategy;
        toast.success(
          `전략·시세 확인 완료 · 데이터 기준 ${latest?.summary.latestDate ?? "미확인"} · 계산 ${calculatedAtLabel(latest?.calculatedAt)}`,
        );
      }
    } finally {
      setSyncing(false);
    }
  }
  function beginBuy(c: Candidate) {
    openEditor({
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
      sourceLinks: doc?.excludedSourceLinks?.[c.key],
    });
  }
  async function saveExecution() {
    if (!edit || !editSession.current || writeGuard.current.pending) return;
    try {
      rejectExecutionMemoUrls(edit.note);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "메모를 확인해 주세요.");
      return;
    }
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
        await mutate(
          {
            action: "exclude",
            signalKey: edit.signalKey,
            executionId: edit.id || undefined,
            note: edit.note || "미매수 · 0주",
            sourceLinks: edit.sourceLinks,
          },
          editSession.current,
        )
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
    if (
      await mutate(
        { action: "execution", execution: { ...edit, shares, price, fee } },
        editSession.current,
      )
    ) {
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
  const pendingEntries = buildKrPendingEntryPreview(strategy, {
    actualExecutions: doc?.executions ?? [],
  });
  const pendingByKey = new Map(pendingEntries.rows.map((row) => [row.key, row]));
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
            실제 보유와 체결을 확인합니다. 모델 성과는 Shadow에서 조회합니다.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching || busy || writeGuard.current.needsReload}
          onClick={() => void synchronize()}
        >
          {query.isFetching || syncing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          {syncing ? "전략·시세 동기화 중…" : "전략·시세 동기화"}
        </Button>
      </div>
      {syncing ? (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          전략·시세 동기화 중… 입력이 바뀐 경우 첫 갱신은 시간이 걸릴 수 있습니다.
        </p>
      ) : null}
      <p className="mb-3 text-xs text-muted-foreground">
        통합 원장 · 실제 체결을 기준으로 보유·원가를 조회합니다. {LEDGER_CASH_NOTE}
      </p>
      {state?.strategyRefresh?.status === "FAILED" ? (
        <p role="alert" className="mb-3 text-sm text-warn">
          실제 체결·설정은 저장됐지만 전략·시세 갱신에 실패했습니다. 표시된 평가는 이전 자료
          기준입니다.
        </p>
      ) : null}
      {writeError ? (
        <div role="alert" className="mb-3 rounded border border-destructive p-3 text-sm">
          {writeError}
          <Button
            className="ml-2"
            variant="outline"
            disabled={busy || query.isFetching}
            onClick={() => void refresh()}
          >
            실제 원장 새로고침
          </Button>
        </div>
      ) : null}
      {query.error ? (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/30 p-4 text-sm">
          {query.error instanceof Error ? query.error.message : "원장을 불러오지 못했습니다."}
          <Button className="ml-3" variant="outline" disabled={busy} onClick={() => void refresh()}>
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
            <Link
              to="/shadow"
              className="rounded-lg border p-4 text-sm text-primary hover:underline"
            >
              10월 12일 이후 독립 모델 기록은 Shadow에서 확인
            </Link>
            <p className="rounded-lg border p-4 text-sm text-muted-foreground">
              원본 실제 보유·체결 관리 · 성과는 상단의 10월 12일 신규 구간에서만 확인합니다.
            </p>
          </div>
          {pendingEntries.rows.length > 0 ? (
            <LedgerTable
              title={`전략 진입 예정 · ${pendingEntries.rows.length}건 (오늘 ${pendingEntries.todayCount}건)`}
              caption="저장된 신호와 검증된 한국 거래일 기준의 예정 후보입니다. 시가·수량·한도 등 실행 조건 확인 전이며, 전략 보유·현금과 실제 체결에는 반영하지 않습니다."
              headers={["종목", "신호일", "진입 예정일", "전략 상태", "실제 체결"]}
            >
              {pendingEntries.rows.map((row) => (
                <tr key={row.key} className="border-t">
                  <td className={td}>
                    <StockLink symbol={row.symbol} name={row.name} />
                  </td>
                  <td className={td}>{row.signalDate}</td>
                  <td className={td}>{row.expectedEntryDate ?? "미확인 · 거래일 자료 없음"}</td>
                  <td className={td}>
                    {row.label}
                    <br />
                    <span className="text-muted-foreground">{row.decision}</span>
                  </td>
                  <td className={td}>{row.actualLabel}</td>
                </tr>
              ))}
            </LedgerTable>
          ) : null}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              저장된 스크리닝 이력 {strategy.firstSignalDate ?? "-"}부터 · 평가 기준{" "}
              {strategy.summary.latestDate ?? "-"} · 전략 계산{" "}
              {calculatedAtLabel(strategy.calculatedAt)} · 두 원장 각각 최대 30종목
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (writeGuard.current.pending || writeGuard.current.needsReload) return;
                capitalSession.current = createLedgerEditSession(state.revision);
                setCapitals({
                  strategy: String(doc.settings.initialCapital),
                  actual: String(doc.actualCapital),
                });
              }}
            >
              운용자금 설정
            </Button>
          </div>
          {capitals ? (
            <section className="mb-4 rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs">
                  실제 운용자금
                  <Input
                    className="mt-1"
                    type="number"
                    min="1"
                    disabled={busy}
                    value={capitals.actual}
                    onChange={(e) => setCapitals({ ...capitals, actual: e.target.value })}
                  />
                </label>
                <Button
                  disabled={
                    busy || writeGuard.current.needsReload || capitalSession.current?.needsReview
                  }
                  onClick={async () => {
                    if (
                      capitalSession.current &&
                      (await mutate(
                        {
                          action: "capital",
                          actualCapital: Number(capitals.actual),
                        },
                        capitalSession.current,
                      ))
                    )
                      setCapitals(null);
                  }}
                >
                  저장
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (!writeGuard.current.pending) setCapitals(null);
                  }}
                >
                  취소
                </Button>
              </div>
              {capitalSession.current?.needsReview ? (
                <p role="alert" className="mt-2 text-sm text-down">
                  {LEDGER_RECONCILE_MESSAGE}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-muted-foreground">
                운용자금은 실제 원장과 대조해 입력합니다. 모델 초기자금은 Shadow의 고정 계약에서
                관리합니다.
              </p>
            </section>
          ) : null}
          {assessments.data ? (
            <DomesticAssessmentPanel markets={assessments.data.markets} heldOnly />
          ) : assessments.isError ? (
            <p className="text-xs text-warn">
              보유종목 조건별 판단 조회 실패 ·{" "}
              <button onClick={() => void assessments.refetch()}>다시 조회</button>
            </p>
          ) : null}
          {state.actual.summary.cash < 0 ? (
            <p className="mb-3 text-sm text-down">
              운용자금 기준 계산 현금이 음수입니다. 기초 현금·입출금과 설정 자금을 확인하세요.
              증권사 잔고 부족을 뜻하지는 않습니다.
            </p>
          ) : null}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div
              className="flex gap-1 rounded-lg bg-muted p-1"
              role="tablist"
              aria-label="포트폴리오 원장"
            >
              {[
                ["actual", "실제 보유·거래"],
                ["signals", "진입 신호 · 미매수"],
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
                  disabled={busy}
                  onClick={closeEditor}
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
                      disabled={busy}
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
                  disabled={busy}
                  value={edit.note}
                  onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                />
              </label>
              {editSession.current?.needsReview ? (
                <p role="alert" className="mt-3 text-sm text-down">
                  {LEDGER_RECONCILE_MESSAGE}
                </p>
              ) : null}
              <div className="mt-3 flex items-center gap-3">
                <Button
                  disabled={
                    busy || writeGuard.current.needsReload || editSession.current?.needsReview
                  }
                  onClick={() => void saveExecution()}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}실제 원장에 저장
                </Button>
                <p className="text-xs text-muted-foreground">
                  매수 수량을 0주로 저장하면 미매수로 남고 전략 성과에는 영향을 주지 않습니다.
                </p>
              </div>
            </section>
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
                          openEditor({
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
              title="전체 진입 신호 · 실제 매수 여부"
              caption="KOSPI 하루·RS·시장국면 진입 준비와 KOSDAQ 원신호 진입 신호를 전략 한도와 관계없이 보여줍니다. 새 신호는 실제 수량 0주로 시작하며, 매수한 경우에만 체결을 입력하세요."
              headers={[
                "종목",
                "신호일",
                "전략 판단",
                "전략 진입일 / 예정일",
                "실제 매수 누계",
                "실제 상태 / 사유",
                "체결 입력",
              ]}
              empty={!candidates.filter(matches).length}
            >
              {candidates.filter(matches).map((c) => (
                <tr key={c.key} className="border-t">
                  <td className={td}>
                    <StockLink symbol={c.symbol} name={c.name} />
                  </td>
                  <td className={td}>{c.signalDate}</td>
                  <td className={td}>{c.decision}</td>
                  <td className={td}>
                    {c.entryDate ?? pendingByKey.get(c.key)?.expectedEntryDate ?? "미확인"}
                    {pendingByKey.has(c.key) ? (
                      <>
                        <br />
                        <span className="text-muted-foreground">
                          {pendingByKey.get(c.key)?.label}
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td className={td}>{bought.get(c.key) ?? 0}주</td>
                  <td className={td}>
                    {bought.has(c.key)
                      ? "실제 체결 기록됨"
                      : splitExecutionMemo(doc.excluded[c.key] ?? "미체결 · 확인 대기").note}
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
