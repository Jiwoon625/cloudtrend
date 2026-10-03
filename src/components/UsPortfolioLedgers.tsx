import {
  projectExecutionMemo,
  rejectExecutionMemoUrls,
  splitExecutionMemo,
} from "@/lib/ledger/executionMemo";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { UsTaxEstimatePanel } from "./UsTaxEstimatePanel";
import { UsModelTaxEstimatePanel } from "./UsModelTaxEstimatePanel";
import { supabase } from "@/lib/cloud";
import { usActualLedgerServer } from "@/lib/usActualLedger.functions";
import type {
  UsActualRequest,
  UsActualState,
  UsCandidate,
  UsExecution,
} from "@/lib/usActualLedger";
import type { UsPortfolioSnapshotRecord } from "@/lib/usProspectiveCloud";
import { actualUsTaxOverlay } from "@/lib/usTaxOverlay";
import {
  acknowledgeLedgerReload,
  createLedgerEditSession,
  createLedgerWriteGuard,
  LEDGER_CASH_NOTE,
  LEDGER_RECONCILE_MESSAGE,
  runLedgerWrite,
  type LedgerEditSession,
} from "@/lib/ledgerUiMutation";

const QUERY = ["us-actual-ledger"];
const usd = (v: number) =>
  `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const taxToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const td = "whitespace-nowrap px-3 py-2";
type Editor = Omit<UsExecution, "price" | "shares" | "fee"> & {
  price: string;
  shares: string;
  fee: string;
};
async function request(input: UsActualRequest): Promise<UsActualState> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("먼저 로그인해 주세요.");
  return usActualLedgerServer({ data: { ...input, accessToken: data.session.access_token } });
}
function Table({
  title,
  heads,
  children,
  empty,
}: {
  title: string;
  heads: string[];
  children: ReactNode;
  empty: boolean;
}) {
  return (
    <section className="rounded-lg border bg-card" aria-label={title}>
      <h3 className="border-b p-3 text-sm font-semibold">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr>
              {heads.map((h) => (
                <th key={h} className={`${td} text-left font-medium`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {empty ? (
              <tr>
                <td colSpan={heads.length} className="p-6 text-center text-muted-foreground">
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
export function UsPortfolioLedgers({
  children,
  model,
  hideHistory = false,
  initialTab = "model",
}: {
  hideHistory?: boolean;
  initialTab?: "model" | "actual" | "signals";
  children: ReactNode;
  model: UsPortfolioSnapshotRecord | undefined;
}) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: QUERY,
    queryFn: () => request({ action: "load" }),
    staleTime: 60000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const data = query.data,
    doc = data?.document,
    actual = data?.actual;
  const actualTaxEstimate = actualUsTaxOverlay({
    document: doc,
    revision: data?.revision,
    navUsd: actual?.summary.equity,
    capitalUsd: doc?.capital,
    // Tax coverage is current through the Korean observation date, even if quotes are stale.
    asOf: taxToday(),
  });
  const [tab, setTab] = useState<"model" | "actual" | "signals">(initialTab);
  const [edit, setEdit] = useState<Editor | null>(null),
    [busy, setBusy] = useState(false),
    [capital, setCapital] = useState<string | null>(null),
    [filter, setFilter] = useState("");
  const editPanel = useRef<HTMLElement>(null);
  const editorOpen = edit !== null;
  useEffect(() => {
    if (!editorOpen) return;
    editPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    editPanel.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [editorOpen, edit?.id, edit?.symbol, edit?.side]);
  const matches = (x: { symbol: string; name: string }) =>
    `${x.symbol} ${x.name}`.toLowerCase().includes(filter.toLowerCase());
  const buys = new Map<string, number>();
  for (const e of doc?.executions ?? [])
    if (e.side === "BUY" && e.signalKey)
      buys.set(e.signalKey, (buys.get(e.signalKey) ?? 0) + e.shares);
  const writeGuard = useRef(createLedgerWriteGuard());
  const editSession = useRef<LedgerEditSession | null>(null);
  const capitalSession = useRef<LedgerEditSession | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  function openEditor(next: Editor) {
    if (writeGuard.current.pending || writeGuard.current.needsReload) return;
    if (edit && editSession.current?.needsReview) {
      toast.error("저장 내용을 확인한 뒤 현재 입력을 닫고 다시 열어 주세요.");
      return;
    }
    editSession.current = createLedgerEditSession(data?.revision);
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
  async function mutate(input: UsActualRequest, session = createLedgerEditSession(data?.revision)) {
    return runLedgerWrite({
      guard: writeGuard.current,
      session,
      client: qc,
      queryKey: QUERY,
      request: (revision) => request({ ...input, revision }),
      onBusy: setBusy,
      onError: (message) => {
        setWriteError(message);
        toast.error(message);
      },
    });
  }
  function beginBuy(c: UsCandidate) {
    openEditor({
      id: "",
      symbol: c.symbol,
      name: c.name,
      market: "US",
      signalKey: c.key,
      side: "BUY",
      date: today(),
      price: String(data?.quotes[c.symbol]?.price ?? ""),
      shares: "0",
      fee: "0",
      note: doc?.excluded[c.key] ?? "",
      sourceLinks: doc?.excludedSourceLinks?.[c.key],
      order: 0,
    });
  }
  async function save() {
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
    if (!edit.shares.trim() || !Number.isInteger(shares) || shares < 0) {
      toast.error("수량은 0 이상의 정수로 입력하세요.");
      return;
    }
    if (shares === 0) {
      if (edit.side !== "BUY" || !edit.signalKey) {
        toast.error("매도수량은 1주 이상으로 입력하세요.");
        return;
      }
      if (
        await mutate(
          {
            action: "exclude",
            executionId: edit.id || undefined,
            signalKey: edit.signalKey,
            note: edit.note || "미매수 · 0주",
            sourceLinks: edit.sourceLinks,
          },
          editSession.current,
        )
      ) {
        setEdit(null);
        toast.success("미매수로 저장했습니다. 모델 성과는 유지됩니다.");
      }
      return;
    }
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(fee) || fee < 0) {
      toast.error("실제 가격·수수료를 확인하세요.");
      return;
    }
    if (
      await mutate(
        { action: "execution", execution: { ...edit, price, shares, fee } },
        editSession.current,
      )
    ) {
      setEdit(null);
      toast.success("실제 원장에 저장했습니다. 모델 체결은 유지됩니다.");
    }
  }
  return (
    <section className="space-y-4" aria-label="US 모델·실제 투자 원장">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">모델 성과와 실제 투자</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || query.isFetching}
          onClick={() => void refresh()}
        >
          실제 원장 새로고침
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <section className="rounded-lg border bg-card p-4" aria-label="A0 모델 성과">
          <h3 className="text-sm font-semibold">A0 모델 포트폴리오 · 최대 20종목</h3>
          <p className="mt-3 text-xl font-bold">
            {model ? usd(Number(model.nav_usd) - 100000) : "-"}{" "}
            <span className="text-sm">
              (
              {model?.cumulative_return == null
                ? "-"
                : `${(model.cumulative_return * 100).toFixed(2)}%`}
              )
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            모델 누적손익 · 기준자금 $100,000.00 · 보유 {model?.positions_count ?? 0}/20
          </p>
          <p className="mt-2 text-xs">Onset 진입 · 분기 조정 · A0/Beta Anchor 청산 규칙 유지</p>
        </section>
        <section className="rounded-lg border bg-card p-4" aria-label="US 실제 투자">
          <h3 className="text-sm font-semibold">실제 투자 · 최대 30종목</h3>
          <p className="mt-3 text-xl font-bold">
            {actual ? usd(actual.summary.totalPnl) : "-"}{" "}
            <span className="text-sm">
              ({actual ? `${actual.summary.totalReturn.toFixed(2)}%` : "-"})
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            입력한 체결만 반영 · 보유 {actual?.summary.openPositions ?? 0}/30
          </p>
          {actual ? (
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              {[
                ["운용자금 기준 평가자산", actual.summary.equity],
                ["운용자금 기준 계산 현금", actual.summary.cash],
                ["실현손익", actual.summary.realizedPnl],
                ["평가손익", actual.summary.unrealizedPnl],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd>{usd(Number(v))}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={!doc || busy}
            onClick={() => {
              if (writeGuard.current.pending || writeGuard.current.needsReload) return;
              capitalSession.current = createLedgerEditSession(data?.revision);
              setCapital(String(doc?.capital ?? 100000));
            }}
          >
            실제 운용자금 설정
          </Button>
        </section>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <UsModelTaxEstimatePanel snapshot={model} title="A0 모델 · 양도소득세 추정" />
        <UsTaxEstimatePanel estimate={actualTaxEstimate} title="실제 투자 · 양도소득세 추정" />
      </div>
      <p className="text-xs text-muted-foreground">
        실제 원장은 모델의 매수·매도를 자동 체결하지 않습니다. USD 기준 이동평균 원가와 입력한
        수수료·세금으로 계산하며, 환차손익·배당·미체결 매도비용은 포함하지 않습니다. 체결일은 미국
        현지 날짜입니다.
      </p>
      <p className="text-xs text-muted-foreground">
        통합 원장 · 저장한 실제 체결을 기준으로 보유·손익을 조회하며, 삭제는 취소 이력으로 남습니다.{" "}
        {LEDGER_CASH_NOTE}
      </p>
      {writeError ? (
        <p role="alert" className="rounded border border-destructive p-3 text-sm">
          {writeError}
        </p>
      ) : null}
      {query.error ? (
        <p role="alert" className="rounded border border-destructive p-3 text-sm">
          {query.error instanceof Error ? query.error.message : "실제 원장 조회 실패"}
        </p>
      ) : null}
      {query.isPending ? <p role="status">실제 원장을 불러오는 중입니다.</p> : null}
      {actual && actual.summary.cash < 0 ? (
        <p className="text-sm text-down">
          운용자금 기준 계산 현금이 음수입니다. 기초 현금·입출금과 설정 자금을 확인하세요. 증권사
          잔고 부족을 뜻하지는 않습니다.
        </p>
      ) : null}
      {capital !== null ? (
        <div className="flex flex-wrap items-end gap-3 rounded border p-3">
          <label className="text-xs">
            실제 운용자금 USD
            <Input
              type="number"
              min="1"
              disabled={busy}
              value={capital}
              onChange={(e) => setCapital(e.target.value)}
            />
          </label>
          <Button
            disabled={busy || writeGuard.current.needsReload || capitalSession.current?.needsReview}
            onClick={async () => {
              if (
                capitalSession.current &&
                (await mutate(
                  { action: "capital", capital: Number(capital) },
                  capitalSession.current,
                ))
              )
                setCapital(null);
            }}
          >
            운용자금 저장
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (!writeGuard.current.pending) setCapital(null);
            }}
          >
            취소
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            {capitalSession.current?.needsReview
              ? LEDGER_RECONCILE_MESSAGE
              : "모델 기준자금과 체결 수량은 바뀌지 않습니다."}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap justify-between gap-3">
        <div className="flex gap-1" role="tablist" aria-label="US 포트폴리오 원장">
          {(
            [
              ["model", "모델 체결 원장"],
              ["actual", "실제 보유·거래"],
              ["signals", "A0 신호 · 미매수"],
            ] as const
          ).map(([v, label]) => (
            <Button
              key={v}
              size="sm"
              role="tab"
              aria-selected={tab === v}
              variant={tab === v ? "default" : "outline"}
              onClick={() => setTab(v)}
            >
              {label}
            </Button>
          ))}
        </div>
        {tab !== "model" ? (
          <Input
            className="max-w-xs"
            aria-label="US 실제 원장 종목 검색"
            placeholder="티커 / 종목명 검색"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        ) : null}
      </div>
      {edit ? (
        <section
          className="rounded-lg border border-primary/40 bg-card p-4"
          ref={editPanel}
          aria-label="US 실제 체결 입력"
        >
          <div className="flex justify-between">
            <h3 className="font-semibold">
              실제 {edit.side === "BUY" ? "매수" : "매도"} · {edit.symbol}
            </h3>
            <Button variant="ghost" disabled={busy} onClick={closeEditor}>
              체결 입력 닫기
            </Button>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            {(
              [
                ["date", "미국 체결일", "date"],
                ["price", "체결가격 USD", "number"],
                ["shares", "체결수량", "number"],
                ["fee", "수수료·세금 USD", "number"],
              ] as const
            ).map(([key, label, type]) => (
              <label key={key} className="text-xs">
                {label}
                <Input
                  type={type}
                  min={type === "number" ? 0 : undefined}
                  step={key === "shares" ? 1 : "any"}
                  disabled={busy}
                  value={edit[key]}
                  onChange={(e) => setEdit({ ...edit, [key]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <label className="mt-3 block text-xs">
            메모 / 미매수 사유
            <Input
              maxLength={300}
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
          <Button
            className="mt-3"
            disabled={busy || writeGuard.current.needsReload || editSession.current?.needsReview}
            onClick={() => void save()}
          >
            실제 원장에 저장
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            매수 0주는 미매수로 보존합니다. 같은 날짜의 체결은 입력 순서대로 계산합니다. 가격은 실제
            체결가로 확인해 주세요.
          </p>
        </section>
      ) : null}
      {tab === "model" ? children : null}
      {tab === "actual" && actual ? (
        <>
          <Table
            title={`실제 보유 종목 · ${actual.positions.length}/30`}
            heads={[
              "종목",
              "수량",
              "평균원가",
              "현재가 · 기준일",
              "평가금액",
              "평가손익",
              "A0 청산 신호",
              "실제 체결",
            ]}
            empty={!actual.positions.filter(matches).length}
          >
            {actual.positions.filter(matches).map((p) => (
              <tr key={p.symbol} className="border-t">
                <td className={td}>
                  {p.symbol}
                  <br />
                  {p.name}
                </td>
                <td className={td}>{p.shares}주</td>
                <td className={td}>{usd(p.averagePrice)}</td>
                <td className={td}>
                  {usd(p.currentPrice)}
                  <br />
                  {p.markDate ?? "체결가 기준"}
                </td>
                <td className={td}>{usd(p.marketValue)}</td>
                <td className={td}>{usd(p.unrealizedPnl)}</td>
                <td className={td}>
                  {p.exitSignal ?? "없음"}
                  <br />
                  실제 매도는 직접 기록
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
                        market: "US",
                        signalKey: null,
                        side: "SELL",
                        date: today(),
                        price: String(p.currentPrice),
                        shares: String(p.shares),
                        fee: "0",
                        note: "",
                        order: 0,
                      })
                    }
                  >
                    매도 기록
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
          {!hideHistory ? (
            <Table
              title="실제 매수·매도 내역"
              heads={["체결일", "종목", "구분", "가격", "수량", "비용", "실현손익", "메모", "수정"]}
              empty={!actual.executions.filter(matches).length}
            >
              {[...actual.executions]
                .reverse()
                .filter(matches)
                .map((e) => (
                  <tr key={e.id} className="border-t">
                    <td className={td}>{e.date}</td>
                    <td className={td}>{e.symbol}</td>
                    <td className={td}>{e.side === "BUY" ? "매수" : "매도"}</td>
                    <td className={td}>{usd(e.price)}</td>
                    <td className={td}>{e.shares}주</td>
                    <td className={td}>{usd(e.fee)}</td>
                    <td className={td}>{e.realizedPnl === null ? "-" : usd(e.realizedPnl)}</td>
                    <td className="max-w-[220px] p-3">{splitExecutionMemo(e.note).note}</td>
                    <td className={td}>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          openEditor({
                            ...e,
                            price: String(e.price),
                            shares: String(e.shares),
                            fee: String(e.fee),
                          })
                        }
                      >
                        수정
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={async () => {
                          if (writeGuard.current.pending || writeGuard.current.needsReload) return;
                          if (
                            window.confirm(
                              "잘못 입력한 실제 체결을 삭제할까요? 모델 원장은 유지됩니다.",
                            )
                          )
                            await mutate({ action: "remove", executionId: e.id });
                        }}
                      >
                        삭제
                      </Button>
                    </td>
                  </tr>
                ))}
            </Table>
          ) : null}
        </>
      ) : null}
      {tab === "signals" && data ? (
        <Table
          title="전체 A0 진입 신호 · 실제 매수 여부"
          heads={["신호일", "종목", "실제 매수 누계", "실제 상태 / 사유", "체결 입력"]}
          empty={!data.candidates.filter(matches).length}
        >
          {data.candidates.filter(matches).map((c) => (
            <tr key={c.key} className="border-t">
              <td className={td}>{c.date}</td>
              <td className={td}>
                {c.symbol}
                <br />
                {c.name}
              </td>
              <td className={td}>{buys.get(c.key) ?? 0}주</td>
              <td className={td}>
                {buys.has(c.key)
                  ? "실제 체결 기록됨"
                  : splitExecutionMemo(doc?.excluded[c.key] ?? "미체결 · 확인 대기").note}
              </td>
              <td className={td}>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => beginBuy(c)}>
                  매수 / 미매수 기록
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
      {tab === "signals" ? (
        <p className="text-xs text-muted-foreground">
          모델 보유 한도와 관계없이 전체 A0 진입 신호를 표시합니다. 새 신호의 실제 수량은 0주이며
          직접 체결을 입력해야 보유로 반영됩니다.
        </p>
      ) : null}
    </section>
  );
}
