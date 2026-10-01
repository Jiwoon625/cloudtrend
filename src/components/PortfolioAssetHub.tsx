import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AppShell } from "./AppShell";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { UsPortfolioLedgers } from "./UsPortfolioLedgers";
import { supabase } from "@/lib/cloud";
import { portfolioLedgersServer } from "@/lib/portfolioLedgers.functions";
import { usActualLedgerServer } from "@/lib/usActualLedger.functions";
import { loadUsPortfolioSnapshots } from "@/lib/usProspectiveCloud";
import type { LedgerRequest } from "@/lib/portfolioLedgers.server";
import type { UsActualRequest } from "@/lib/usActualLedger";
import type { ActualExecution, ActualLedger } from "@/lib/portfolioLedgers";
import { exitLabel, soldSymbolsSinceSignal } from "@/lib/dashboardOperations";
import { ETF_POLICY } from "@/lib/engine/etfStrategy";
import { formatWon } from "@/lib/format";

type Asset = "KR" | "US" | "ETF";
type Execution = ActualExecution<"KOSPI" | "KOSDAQ" | "ETF" | "US">;
type Editor = Omit<Execution, "price" | "shares" | "fee"> & {
  price: string;
  shares: string;
  fee: string;
};
const label = { KR: "한국주식", US: "미국주식", ETF: "ETF" };
const assetOf = (market: string): Asset =>
  market === "US" ? "US" : market === "ETF" ? "ETF" : "KR";
const usd = (value: number) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const amount = (value: number, asset: Asset) => (asset === "US" ? usd(value) : formatWon(value));
const color = (value: number) =>
  value > 0 ? "text-up" : value < 0 ? "text-down" : "text-muted-foreground";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
async function token() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("먼저 로그인해 주세요.");
  return data.session.access_token;
}
async function krRequest(input: LedgerRequest) {
  return portfolioLedgersServer({ data: { ...input, accessToken: await token() } });
}
async function usRequest(input: UsActualRequest) {
  return usActualLedgerServer({ data: { ...input, accessToken: await token() } });
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
    <section className="mb-4 rounded-lg border bg-card" aria-label={title}>
      <h2 className="border-b p-3 font-semibold">{title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              {heads.map((h) => (
                <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">
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
const td = "whitespace-nowrap px-3 py-3";

export function PortfolioAssetHub({ domestic }: { domestic: ReactNode }) {
  const qc = useQueryClient();
  const kr = useQuery({
    queryKey: ["portfolio-ledgers"],
    queryFn: () => krRequest({ action: "sync" }),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const us = useQuery({
    queryKey: ["us-actual-ledger"],
    queryFn: () => usRequest({ action: "load" }),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const snapshots = useQuery({
    queryKey: ["us-portfolio-snapshots"],
    queryFn: () => loadUsPortfolioSnapshots(370),
    staleTime: 60_000,
    retry: false,
  });
  const [asset, setAsset] = useState<Asset>("KR");
  const [historyAsset, setHistoryAsset] = useState<Asset | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const [etfSymbol, setEtfSymbol] = useState("");
  const [etfSearch, setEtfSearch] = useState("");
  const [etfCapital, setEtfCapital] = useState<string | null>(null);
  const books: Record<Asset, ActualLedger<string> | undefined> = {
    KR: kr.data?.actual,
    US: us.data?.actual,
    ETF: kr.data?.etfActual,
  };
  const histories = Object.entries(books)
    .flatMap(([key, book]) => (book?.executions ?? []).map((e) => ({ ...e, asset: key as Asset })))
    .filter(
      (e) =>
        (historyAsset === "ALL" || e.asset === historyAsset) &&
        `${e.symbol} ${e.name}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.order - a.order);
  const etfRows = kr.data?.etfRows ?? [];
  const tracked = (kr.data?.etfTrackedSymbols ?? []).filter(
    (symbol) =>
      !kr.data?.document.executions.some((e) => e.market === "ETF" && e.symbol === symbol),
  );
  const heldEtfs = new Set([...(books.ETF?.positions.map((p) => p.symbol) ?? []), ...tracked]);
  const etfConsumed = (r: (typeof etfRows)[number]) =>
    soldSymbolsSinceSignal(
      books.ETF?.executions ?? [],
      "ETF",
      r.etfEntry?.originDate ?? r.date,
    ).has(r.symbol);
  const etfSignalRows = etfRows
    .filter(
      (r) =>
        r.date === books.ETF?.summary.latestDate &&
        ((r.etfEntry?.entryState &&
          r.etfEntry.entryState !== "none" &&
          !heldEtfs.has(r.symbol) &&
          !etfConsumed(r)) ||
          ((r.exitReason || r.etfEntry?.dataStatus === "krx_batch_pending") &&
            heldEtfs.has(r.symbol))),
    )
    .sort(
      (a, b) =>
        Number(b.onset) - Number(a.onset) ||
        b.priority - a.priority ||
        a.symbol.localeCompare(b.symbol),
    );
  const krxPending = etfRows.find((r) => r.etfEntry?.dataStatus === "krx_batch_pending");
  const staleEtfPolicy = etfRows.some((r) => r.etfEntry?.version !== ETF_POLICY.version);
  const model = snapshots.data?.find((s) => s.strategy_id === "A0_QUARTER_PRIMARY");
  const modelPositions = Object.values(
    (
      model?.state as
        | {
            positions?: Record<
              string,
              { symbol: string; name: string; shares: number; lastPrice: number; entryDate: string }
            >;
          }
        | undefined
    )?.positions ?? {},
  );
  async function mutateKr(input: LedgerRequest) {
    qc.setQueryData(
      ["portfolio-ledgers"],
      await krRequest({ ...input, revision: kr.data?.revision }),
    );
    void qc.invalidateQueries({ queryKey: ["dashboard-operations"] });
  }
  async function save() {
    if (!edit || busy) return;
    const shares = Number(edit.shares),
      price = Number(edit.price),
      fee = Number(edit.fee);
    if (
      !edit.shares.trim() ||
      !Number.isInteger(shares) ||
      shares < 0 ||
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(fee) ||
      fee < 0
    ) {
      toast.error("체결가격·수량·수수료를 확인해 주세요.");
      return;
    }
    setBusy(true);
    try {
      if (shares === 0) {
        if (edit.side !== "BUY" || !edit.signalKey)
          throw new Error("수량은 1주 이상이어야 합니다.");
        const input = {
          action: "exclude" as const,
          executionId: edit.id,
          signalKey: edit.signalKey,
          note: edit.note || "미매수 · 0주",
        };
        if (edit.market === "US")
          qc.setQueryData(
            ["us-actual-ledger"],
            await usRequest({ ...input, revision: us.data?.revision }),
          );
        else await mutateKr(input);
      } else if (edit.market === "US") {
        qc.setQueryData(
          ["us-actual-ledger"],
          await usRequest({
            action: "execution",
            revision: us.data?.revision,
            execution: { ...edit, market: "US", shares, price, fee },
          }),
        );
      } else {
        await mutateKr({
          action: "execution",
          execution: { ...edit, market: edit.market, shares, price, fee },
        });
      }
      void qc.invalidateQueries({ queryKey: ["dashboard-operations"] });
      setEdit(null);
      toast.success("실제 체결을 저장했습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }
  function beginEtf(symbol: string, side: "BUY" | "SELL" = "BUY") {
    const row = etfRows.find((r) => r.symbol === symbol),
      position = books.ETF?.positions.find((p) => p.symbol === symbol);
    if (!row && !position) {
      toast.error("최신 스크리닝에서 ETF를 찾지 못했습니다.");
      return;
    }
    setEdit({
      id: "",
      symbol,
      name: row?.name ?? position!.name,
      market: "ETF",
      side,
      signalKey: null,
      date: today(),
      price: String(row?.price ?? position?.currentPrice ?? ""),
      shares: side === "SELL" ? String(position?.shares ?? 0) : "",
      fee: "0",
      note: "",
      order: 0,
    });
  }
  async function remove(e: { id: string; asset: Asset }) {
    if (!window.confirm("실제 체결 기록을 삭제할까요? 전략 원장은 유지됩니다.")) return;
    setBusy(true);
    try {
      if (e.asset === "US")
        qc.setQueryData(
          ["us-actual-ledger"],
          await usRequest({ action: "remove", executionId: e.id, revision: us.data?.revision }),
        );
      else await mutateKr({ action: "remove", executionId: e.id });
      void qc.invalidateQueries({ queryKey: ["dashboard-operations"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "삭제 실패");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AppShell loadAnalysis={false}>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">포트폴리오</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            한국주식·ETF는 원화, 미국주식은 달러 기준입니다.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy || kr.isFetching || us.isFetching}
          onClick={() => {
            void kr.refetch();
            void us.refetch();
            void snapshots.refetch();
          }}
        >
          새로고침
        </Button>
      </header>
      <div className="mb-4 rounded-lg border bg-card p-4" aria-label="전체 실제 투자 요약">
        <h2 className="font-semibold">전체 실제 투자 · 통화별</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <p>
            원화 평가금액{" "}
            <strong>
              {kr.data && books.ETF
                ? formatWon(kr.data.actual.summary.marketValue + books.ETF.summary.marketValue)
                : "-"}
            </strong>
            <br />
            <span className="text-sm text-muted-foreground">
              누적손익{" "}
              {kr.data && books.ETF
                ? formatWon(kr.data.actual.summary.totalPnl + books.ETF.summary.totalPnl)
                : "-"}
            </span>
          </p>
          <p>
            달러 평가금액 <strong>{books.US ? usd(books.US.summary.marketValue) : "-"}</strong>
            <br />
            <span className="text-sm text-muted-foreground">
              누적손익 {books.US ? usd(books.US.summary.totalPnl) : "-"}
            </span>
          </p>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          평가금액은 실제 보유 종목 기준입니다. 체결 미입력 ETF는 합계에서 제외합니다. 환율
          환산·환차손익은 적용하지 않습니다.
        </p>
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {(["KR", "US", "ETF"] as const).map((key) => {
          const book = books[key];
          return (
            <section
              key={key}
              className="rounded-lg border bg-card p-4"
              aria-label={`${label[key]} 실제 투자 요약`}
            >
              <h2 className="font-semibold">
                {label[key]} · {key === "US" ? "USD" : "KRW"}
              </h2>
              <p className={`mt-3 text-xl font-bold ${color(book?.summary.totalPnl ?? 0)}`}>
                {book ? amount(book.summary.totalPnl, key) : "-"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                누적손익 · 보유 {book?.positions.length ?? "-"}종목
              </p>
              <p className="mt-3 text-sm">
                평가금액 {book ? amount(book.summary.marketValue, key) : "-"}
                <br />
                실현손익 {book ? amount(book.summary.realizedPnl, key) : "-"}
                <br />
                평가손익 {book ? amount(book.summary.unrealizedPnl, key) : "-"}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                평가 기준 {book?.summary.latestDate ?? "체결가 기준"}
              </p>
            </section>
          );
        })}
      </div>
      {[kr.error, us.error, snapshots.error].filter(Boolean).map((error, i) => (
        <p key={i} role="alert" className="mb-3 rounded border border-destructive p-3 text-sm">
          {error instanceof Error ? error.message : "포트폴리오 조회 실패"}
        </p>
      ))}
      {(kr.isPending || us.isPending) && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          원장을 불러오는 중입니다.
        </p>
      )}
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="포트폴리오 자산군">
        {(["KR", "US", "ETF"] as const).map((key) => (
          <Button
            key={key}
            role="tab"
            aria-selected={asset === key}
            variant={asset === key ? "default" : "outline"}
            onClick={() => setAsset(key)}
          >
            {label[key]}
          </Button>
        ))}
      </div>
      <div role="tabpanel" aria-label={label[asset]}>
        {asset === "KR" ? domestic : null}
        {asset === "US" ? (
          <UsPortfolioLedgers model={model} hideHistory initialTab="actual">
            <Table
              title="A0 전략 보유 · USD"
              heads={["종목", "수량", "현재가 USD", "진입일"]}
              empty={!modelPositions.length}
            >
              {modelPositions.map((p) => (
                <tr key={p.symbol} className="border-t">
                  <td className={td}>
                    {p.symbol} · {p.name}
                  </td>
                  <td className={td}>{p.shares}주</td>
                  <td className={td}>{usd(p.lastPrice)}</td>
                  <td className={td}>{p.entryDate}</td>
                </tr>
              ))}
            </Table>
            <Link to="/us/portfolio" className="text-sm text-primary underline">
              미국 전략 성과·모델 체결 상세
            </Link>
          </UsPortfolioLedgers>
        ) : null}
        {asset === "ETF" ? (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              M0 80점 신규 돌파 후 다음 거래일 종가에 M0 ≥ 80·기초지수 ≥ MA60·데이터 적격을
              확인하고, 그다음 거래일 시가에 진입합니다. 확인일 20거래일 평균 거래대금 내림차순(동률
              종목코드순), 최대 10종목, 변동성 비례 비중입니다. 자리가 없으면 건너뛰며 교체·추가
              매수는 하지 않습니다. 청산 체결 후 실제 현금만 사용합니다. 실제 매수·매도는 직접
              입력하며 신호로 자동 체결하지 않습니다.
            </p>
            {krxPending && (
              <p
                role="status"
                className="mb-3 rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-slate-900"
              >
                {krxPending.date} KRX 금액·기초지수 일괄 미수신 · 직전 자료 확인일{" "}
                {krxPending.etfEntry?.krxReferenceDate}. ETF 신규 진입·청산 판단은 자료 수신까지
                대기합니다. MA60 하회 청산으로 해석하지 마세요.
              </p>
            )}
            {staleEtfPolicy && (
              <p role="alert" className="mb-3 text-sm text-down">
                이전 ETF 규칙 캐시입니다. 스크리닝을 다시 실행해야 새 진입 신호가 표시됩니다.
              </p>
            )}
            <Link to="/screener/etfs" className="mb-3 block text-sm text-primary underline">
              ETF 확인 상태·거래대금 우선순위·신규 비중 및 수량 계산
            </Link>
            {kr.data?.etfWarning ? (
              <p role="alert" className="mb-3 text-sm text-down">
                ETF 신호 조회: {kr.data.etfWarning}
              </p>
            ) : null}
            <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
              <label className="text-sm">
                ETF 찾기
                <Input
                  placeholder="종목명 / 종목코드"
                  value={etfSearch}
                  onChange={(e) => setEtfSearch(e.target.value)}
                />
              </label>
              <label className="text-sm">
                매수할 ETF
                <select
                  className="mt-1 block max-w-[300px] rounded border bg-background p-2"
                  aria-label="매수할 ETF"
                  value={etfSymbol}
                  onChange={(e) => setEtfSymbol(e.target.value)}
                >
                  <option value="">종목 선택</option>
                  {etfRows
                    .filter((r) =>
                      `${r.symbol} ${r.name}`.toLowerCase().includes(etfSearch.toLowerCase()),
                    )
                    .map((r) => (
                      <option key={r.symbol} value={r.symbol}>
                        {r.symbol} · {r.name}
                      </option>
                    ))}
                </select>
              </label>
              <Button disabled={busy || !etfSymbol} onClick={() => beginEtf(etfSymbol)}>
                매수 기록
              </Button>
              <Button
                variant="outline"
                onClick={() => setEtfCapital(String(kr.data?.document.etfCapital ?? 10_000_000))}
              >
                ETF 운용자금 설정
              </Button>
            </div>
            {etfCapital !== null ? (
              <div className="mb-4 flex flex-wrap items-end gap-3 rounded border p-3">
                <label className="text-sm">
                  ETF 운용자금 KRW
                  <Input
                    type="number"
                    min="1"
                    value={etfCapital}
                    onChange={(e) => setEtfCapital(e.target.value)}
                  />
                </label>
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await mutateKr({ action: "capital", etfCapital: Number(etfCapital) });
                      setEtfCapital(null);
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "저장 실패");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  저장
                </Button>
                <Button variant="ghost" onClick={() => setEtfCapital(null)}>
                  취소
                </Button>
                <p className="w-full text-sm text-muted-foreground">
                  초기 기준자금은 1,000만원입니다. 실제 배정한 ETF 자금으로 맞춰 주세요.
                </p>
              </div>
            ) : null}
            <Table
              title="ETF 실제 보유 · KRW"
              heads={[
                "종목",
                "수량",
                "평균원가",
                "현재가 · 기준일",
                "평가금액",
                "평가손익",
                "청산 신호",
                "체결",
              ]}
              empty={!books.ETF?.positions.length}
            >
              {books.ETF?.positions.map((p) => (
                <tr key={p.symbol} className="border-t">
                  <td className={td}>
                    {p.symbol}
                    <br />
                    {p.name}
                  </td>
                  <td className={td}>{p.shares}주</td>
                  <td className={td}>{formatWon(p.averagePrice)}</td>
                  <td className={td}>
                    {formatWon(p.currentPrice)}
                    <br />
                    {p.markDate ?? "체결가 기준"}
                  </td>
                  <td className={td}>{formatWon(p.marketValue)}</td>
                  <td className={`${td} ${color(p.unrealizedPnl)}`}>
                    {formatWon(p.unrealizedPnl)}
                  </td>
                  <td className={td}>
                    {krxPending
                      ? "KRX 자료 대기 · 판단 보류"
                      : p.markDate === books.ETF?.summary.latestDate
                        ? p.exitSignal
                          ? exitLabel(p.exitSignal)
                          : "없음"
                        : "최신 신호 미확인"}
                  </td>
                  <td className={td}>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => beginEtf(p.symbol, "SELL")}
                    >
                      매도 기록
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
            {tracked.length > 0 ? (
              <Table
                title="기존 ETF 보유 목록 · 체결 입력 필요"
                heads={["종목", "상태", "체결"]}
                empty={false}
              >
                {tracked.map((symbol) => (
                  <tr key={symbol} className="border-t">
                    <td className={td}>
                      {symbol} · {etfRows.find((r) => r.symbol === symbol)?.name ?? ""}
                    </td>
                    <td className={td}>수량·매입가 미입력 · 손익 합계 제외</td>
                    <td className={td}>
                      <Button
                        variant="outline"
                        disabled={busy || !etfRows.some((r) => r.symbol === symbol)}
                        onClick={() => beginEtf(symbol)}
                      >
                        매수 내역 입력
                      </Button>
                    </td>
                  </tr>
                ))}
              </Table>
            ) : null}
            <Table
              title="ETF 하루 확인 · 진입·청산 신호"
              heads={[
                "종목",
                "Onset / 확인일",
                "M0 점수",
                "20일 평균 거래대금",
                "신규 비중",
                "신호",
                "체결",
              ]}
              empty={!etfSignalRows.length}
            >
              {etfSignalRows.map((r) => (
                <tr key={r.symbol} className="border-t">
                  <td className={td}>
                    {r.symbol} · {r.name}
                  </td>
                  <td className={td}>
                    {r.etfEntry?.originDate ?? "—"} /{" "}
                    {r.etfEntry?.confirmationDate ??
                      (r.etfEntry?.entryState === "pending" ? "다음 거래일 종가" : r.date)}
                  </td>
                  <td className={td}>{r.score?.toFixed(1) ?? "-"}</td>
                  <td className={td}>
                    {r.etfEntry?.averageTradingValue20 == null
                      ? "—"
                      : formatWon(r.etfEntry.averageTradingValue20)}
                  </td>
                  <td className={td}>
                    {r.onset && r.etfEntry?.entryWeight != null
                      ? `${(r.etfEntry.entryWeight * 100).toFixed(2)}%`
                      : "—"}
                  </td>
                  <td className={td}>
                    {r.etfEntry?.dataStatus === "krx_batch_pending"
                      ? "KRX 자료 대기 · 판단 보류"
                      : r.exitReason && heldEtfs.has(r.symbol)
                        ? exitLabel(r.exitReason)
                        : r.etfEntry?.entryState === "pending"
                          ? "하루 확인 대기"
                          : r.etfEntry?.entryState === "rejected"
                            ? `확인 탈락 · ${(r.etfEntry.confirmationIssues ?? []).join(" · ")}`
                            : "확인 완료 · 다음 거래일 시가 진입"}
                  </td>
                  <td className={td}>
                    <Button
                      variant="outline"
                      disabled={
                        busy ||
                        r.etfEntry?.dataStatus === "krx_batch_pending" ||
                        (!r.onset && !heldEtfs.has(r.symbol)) ||
                        r.etfEntry?.version !== ETF_POLICY.version
                      }
                      onClick={() =>
                        beginEtf(r.symbol, r.exitReason && heldEtfs.has(r.symbol) ? "SELL" : "BUY")
                      }
                    >
                      체결 기록
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          </>
        ) : null}
      </div>
      <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-3">
        <label className="text-sm">
          거래내역 자산군{" "}
          <select
            className="rounded border bg-background p-2"
            value={historyAsset}
            onChange={(e) => setHistoryAsset(e.target.value as Asset | "ALL")}
          >
            <option value="ALL">전체</option>
            {(["KR", "US", "ETF"] as const).map((key) => (
              <option key={key} value={key}>
                {label[key]}
              </option>
            ))}
          </select>
        </label>
        <Input
          aria-label="전체 거래내역 종목 검색"
          placeholder="종목명 / 코드 / 티커 검색"
          className="max-w-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <Table
        title="실제 매수·매도 내역 · 전체 자산군"
        heads={[
          "체결일",
          "자산군",
          "종목",
          "구분",
          "가격",
          "수량",
          "수수료·세금",
          "실현손익",
          "메모",
          "관리",
        ]}
        empty={!histories.length}
      >
        {histories.map((e) => (
          <tr key={`${e.asset}:${e.id}`} className="border-t">
            <td className={td}>{e.date}</td>
            <td className={td}>
              {label[e.asset]} · {e.asset === "US" ? "USD" : "KRW"}
            </td>
            <td className={td}>
              {e.symbol}
              <br />
              {e.name}
            </td>
            <td className={td}>{e.side === "BUY" ? "매수" : "매도"}</td>
            <td className={td}>{amount(e.price, e.asset)}</td>
            <td className={td}>{e.shares}주</td>
            <td className={td}>{amount(e.fee, e.asset)}</td>
            <td className={`${td} ${color(e.realizedPnl ?? 0)}`}>
              {e.realizedPnl === null ? "-" : amount(e.realizedPnl, e.asset)}
            </td>
            <td className="max-w-[240px] px-3 py-3">{e.note}</td>
            <td className={td}>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  setEdit({
                    ...e,
                    market: e.market as Execution["market"],
                    price: String(e.price),
                    shares: String(e.shares),
                    fee: String(e.fee),
                  })
                }
              >
                수정
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void remove(e)}>
                삭제
              </Button>
            </td>
          </tr>
        ))}
      </Table>
      <p className="text-sm text-muted-foreground">
        미국 체결일은 미국 현지 날짜입니다. 미국주식의 가격·비용·손익은 모두 USD입니다.
      </p>
      <Dialog
        open={edit !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setEdit(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {edit?.side === "SELL" ? "실제 매도" : "실제 매수"} · {edit?.name}
            </DialogTitle>
            <DialogDescription>
              {edit?.market === "US"
                ? "가격·비용·손익은 달러, 체결일은 미국 현지 기준입니다."
                : "가격·비용·손익은 원화 기준입니다."}
            </DialogDescription>
          </DialogHeader>
          {edit ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              className="space-y-3"
            >
              {(
                [
                  ["date", "체결일", "date"],
                  ["price", "체결가격", "number"],
                  ["shares", "체결수량", "number"],
                  ["fee", "수수료·세금", "number"],
                ] as const
              ).map(([key, title, type]) => (
                <label key={key} className="block text-sm">
                  {title}
                  {key === "price" || key === "fee" ? (edit.market === "US" ? " USD" : " KRW") : ""}
                  <Input
                    autoFocus={key === "date"}
                    required
                    type={type}
                    min={type === "number" ? 0 : undefined}
                    step={key === "shares" ? 1 : "any"}
                    value={edit[key]}
                    onChange={(e) => setEdit({ ...edit, [key]: e.target.value })}
                  />
                </label>
              ))}
              <label className="block text-sm">
                메모
                <Input
                  maxLength={300}
                  value={edit.note}
                  onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                />
              </label>
              <Button type="submit" disabled={busy}>
                실제 원장에 저장
              </Button>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
