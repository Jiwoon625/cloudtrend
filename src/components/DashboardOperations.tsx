import { ActualEntryDecisionDialog } from "./ActualEntryDecisions";
import { entryDecisionLabel, type EntryDecisionCandidate } from "@/lib/actualEntryDecisions";
import { dashboardInbox, type InboxKind } from "@/lib/dashboardInbox";
import { dashboardCopy } from "@/lib/dashboardCopy";
import {
  OperatingAllocationPanel,
  type OperatingAllocationCandidate,
} from "./OperatingAllocationPanel";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, TrendingUp } from "lucide-react";
import { Button } from "./ui/button";
import { DomesticStrategyRules } from "./DomesticStrategyRules";
import { UsA0AllocationRules } from "./UsA0AllocationRules";
import { OnsetProfileDetails } from "./OnsetProfileDetails";
import { supabase } from "@/lib/cloud";
import { formatCount } from "@/lib/format";
import { dashboardOperationsServer } from "@/lib/dashboardOperations.functions";
import { compareDashboardCandidates } from "@/lib/dashboardOperations";
import type {
  DashboardMarket,
  DashboardOperations,
  DashboardSignal,
} from "@/lib/dashboardOperations";
import type { DashboardSummary } from "@/lib/screeningCacheContract";

import type { PurchaseRecordCandidate } from "./NewActualPortfolio";
const PurchaseRecordEditor = lazy(() =>
  import("./NewActualPortfolio").then((m) => ({ default: m.NewActualPortfolio })),
);

const LABEL: Record<DashboardMarket, string> = {
  KOSPI: "KOSPI",
  KOSDAQ: "KOSDAQ",
  ETF: "ETF",
  US: "미국 A0",
};
const MARKETS: DashboardMarket[] = ["KOSPI", "KOSDAQ", "ETF", "US"];
import { DASHBOARD_OPERATIONS_QUERY } from "@/lib/dashboardActualRefresh";
export { DASHBOARD_OPERATIONS_QUERY } from "@/lib/dashboardActualRefresh";
async function accessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("먼저 로그인해 주세요.");
  return data.session.access_token;
}
export function useDashboardOperations(started: boolean, digest: string | undefined) {
  return useQuery<DashboardOperations>({
    queryKey: [...DASHBOARD_OPERATIONS_QUERY, digest],
    queryFn: async () => dashboardOperationsServer({ data: { accessToken: await accessToken() } }),
    enabled: started && Boolean(digest),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    // Real fills already invalidate this query immediately; focus only refreshes stale reads.
    refetchOnWindowFocus: true,
    retry: false,
  });
}
type OperationsQuery = ReturnType<typeof useDashboardOperations>;
const usd = (value: number) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border py-1.5 last:border-0">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="num text-[13px] font-medium">{children}</span>
    </div>
  );
}
export function DashboardSignalCounts({
  query,
  counts,
}: {
  query: OperationsQuery;
  counts: DashboardSummary["counts"];
}) {
  const kospiPending = query.data?.markets.find((m) => m.market === "KOSPI")?.pendingCount;
  const etfMarket = query.data?.markets.find((m) => m.market === "ETF");
  const etfPending = etfMarket?.pendingCount;
  const etfDataUnconfirmed = etfMarket?.dataUnconfirmedCount;
  const pendingCount = (value: number | null | undefined) =>
    value == null ? "—" : formatCount(value);
  // Persisted actual-position K4/E4 intents, never model-only signals.
  const heldPriceExits = [
    ...new Map(
      (query.data?.markets ?? [])
        .flatMap((item) => item.exits)
        .filter((item) => item.held === true && /\b(?:K4|E4)\b/.test(item.reason))
        .map((item) => [`${item.market}:${item.symbol}`, item] as const),
    ).values(),
  ];
  return (
    <section
      className="rounded-lg border border-border bg-card p-4"
      aria-label="실제 포트폴리오 진입/EXIT"
    >
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
        <TrendingUp className="size-4 text-primary" />
        실제 포트폴리오 진입/EXIT
      </h2>
      <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">
        시장별 최신 확정 거래일의 조건과 실제 원장 체결을 함께 봅니다. 조건 충족은 주문·체결 확정이
        아니며 현금·배분·수량 확인이 필요합니다. Shadow 보유는 실제 후보를 막지 않습니다.
      </p>
      {heldPriceExits.length > 0 && (
        <div role="alert" className="mb-3 rounded-md border border-warn p-3 text-xs">
          <p className="font-semibold">
            K4/E4 청산신호 · 실제 매도 체결 확인 필요 ({heldPriceExits.length}종목)
          </p>
          <p className="mt-1">
            {heldPriceExits.map((item) => `${item.name}(${item.symbol}, ${item.date})`).join(" · ")}
          </p>
          <p className="mt-1 text-muted-foreground">
            신호는 체결이 아닙니다. 다음 거래 가능한 시가 주문 여부와 증권사 체결 내역을 확인하고
            실제 포트폴리오에 기록해 주세요. 미체결 신호는 가격이 회복해도 유지됩니다.
          </p>
          <Link to="/portfolio" className="mt-2 inline-block font-medium text-primary underline">
            실제 포트폴리오 확인 →
          </Link>
        </div>
      )}
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b text-[10px] text-muted-foreground">
            <th className="py-2 text-left">시장 / 기준일</th>
            <th className="text-right">조건 충족</th>
            <th className="text-right">실제 미보유 후보</th>
            <th className="text-right">EXIT</th>
          </tr>
        </thead>
        <tbody>
          {MARKETS.map((market) => {
            const item = query.data?.markets.find((m) => m.market === market);
            const count = (n: number | null | undefined) =>
              n == null ? "—" : `${formatCount(n)}종목`;
            return (
              <tr key={market} className="border-b last:border-0">
                <td className="py-2">
                  <span className="font-medium">{LABEL[market]}</span>
                  <span className="block text-[10px] text-muted-foreground">
                    {item?.date ?? (query.isPending ? "불러오는 중…" : "미확인")}
                  </span>
                </td>
                <td className="num text-right">{count(item?.conditionCount)}</td>
                <td className="num text-right text-up">{count(item?.onsetCount)}</td>
                <td className="num text-right text-warn">{count(item?.exitCount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {query.isError ? (
        <p role="alert" className="mt-2 text-[11px] text-destructive">
          신호 조회 실패{" "}
          <button className="underline" onClick={() => void query.refetch()}>
            다시 조회
          </button>
        </p>
      ) : null}
      {query.data?.markets.some((m) => !m.holdingsKnown) ? (
        <p className="mt-2 text-[10px] text-muted-foreground">
          — 는 실제 보유정보 또는 신호 미확인입니다. 조건 충족은 표시하되 실제 행동 판단은
          보류합니다.
        </p>
      ) : null}
      <div className="mt-2 border-t border-border pt-1">
        <Row label="확인대기(KOSPI/ETF)">
          <span
            className="whitespace-nowrap"
            aria-label={`KOSPI ${kospiPending == null ? "미확인" : `${formatCount(kospiPending)}종목`}, ETF ${etfPending == null ? "미확인" : `${formatCount(etfPending)}종목`}`}
          >
            {pendingCount(kospiPending)}/{pendingCount(etfPending)}
          </span>
        </Row>
        <Row label="ETF 자료 확인">
          {etfDataUnconfirmed == null ? "미확인" : `${formatCount(etfDataUnconfirmed)}종목`}
        </Row>
        <Row label="점수 산정 불가">{formatCount(counts.incomplete)}</Row>
        <Row label="주식 판단 보류">
          {counts.pending == null ? "미확인" : formatCount(counts.pending)}
        </Row>
      </div>
      <Link
        to="/screener/etfs"
        className="mt-2 inline-flex text-[11px] font-medium text-primary hover:underline"
      >
        ETF 조건 상세 보기 →
      </Link>
      {query.data?.warnings.length ? (
        <details className="mt-2 text-[11px] text-warn">
          <summary className="cursor-pointer">
            데이터 확인사항 ({query.data.warnings.length})
          </summary>
          {query.data.warnings.map((w) => (
            <p key={w} className="mt-1 leading-relaxed">
              {dashboardCopy(w)}
            </p>
          ))}
        </details>
      ) : null}
    </section>
  );
}

export function UsDashboardPortfolio({ query }: { query: OperationsQuery }) {
  const portfolio = query.data?.newActualPools?.USD;
  const fallback = query.isPending ? "불러오는 중…" : query.isError ? "조회 실패" : "미확인";
  return (
    <div className="min-w-0 space-y-4">
      <section
        className="rounded-lg border border-border bg-card p-4"
        aria-label="미국주식 A0 포트폴리오"
      >
        <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
          <ShieldCheck className="size-4 text-primary" />
          미국주식 A0 포트폴리오
        </h2>
        <p className="mb-2 text-[10px] text-muted-foreground">배정·입출금 기준 · USD</p>
        <Row label="순입금">
          {portfolio
            ? portfolio.netContributions === null
              ? "자금 확인 대기"
              : usd(Number(portfolio.netContributions))
            : fallback}
        </Row>
        <Row label="현금">
          {portfolio
            ? portfolio.cash === null
              ? "자금 확인 대기"
              : usd(Number(portfolio.cash))
            : fallback}
        </Row>
        <Row label="실제 보유 종목수">
          {portfolio ? `${portfolio.openPositions}종목` : fallback}
        </Row>
        {portfolio?.fundingStatus === "INCOMPLETE" ? (
          <p className="mt-2 text-[10px] text-warn">입출금·체결의 자금 연결을 확인해 주세요.</p>
        ) : null}
        <Link
          to="/us/portfolio"
          className="mt-3 inline-flex text-[11px] font-medium text-primary hover:underline"
        >
          포트폴리오 상세 보기 →
        </Link>
      </section>
    </div>
  );
}

export function DashboardStrategyRules() {
  return (
    <div className="space-y-3 text-[11px] leading-relaxed text-muted-foreground">
      <DomesticStrategyRules />
      <div className="border-t border-border pt-2">
        <h3 className="font-semibold text-foreground">ETF · M0</h3>
        <p>
          M0 80점 돌파 진입 · 기초지수 MA60 하회 또는 보유 후 최고 기준가격 대비 −10% E4 종가 신호 →
          다음 거래 가능 시가 청산.
        </p>
        <p>
          최대 10종목 · 기본 비중 10% × min(1, 15% / 20일 연율 변동성). 매수에 적용하며 진입·청산은
          다음 거래일 시가 기준입니다.
        </p>
      </div>
      <div className="border-t border-border pt-2">
        <h3 className="font-semibold text-foreground">미국 A0 · 실제 운용</h3>
        <p>
          ret120/252 Core 상위 20% 진입 + Beta 상위 10% 이내 + TK 상위 20% 이내 + 공통 유동성 조건
          충족.
        </p>
        <p>Core 상위 30% 밖 또는 산정 불가 시 청산. Beta 상위 40% 밖 3거래일 연속도 청산합니다.</p>
        <UsA0AllocationRules />
        <p>진입·청산 신호는 매일 확인하고 다음 미국 정규장 시가에 반영합니다.</p>
      </div>
    </div>
  );
}

function SignalLink({ row }: { row: DashboardSignal }) {
  if (row.market === "US")
    return (
      <Link
        to="/us/instrument/$symbol"
        params={{ symbol: row.symbol }}
        className="font-medium hover:underline"
      >
        {row.name}
        <span className="ml-1 text-[10px] text-muted-foreground">{row.symbol}</span>
      </Link>
    );
  return (
    <Link
      to="/instrument/$symbol"
      params={{ symbol: row.symbol }}
      className="font-medium hover:underline"
    >
      {row.name}
      <span className="ml-1 text-[10px] text-muted-foreground">{row.symbol}</span>
    </Link>
  );
}
export function DashboardSectorLimitBadge({ row }: { row: DashboardSignal }) {
  if (row.market !== "KOSPI" && row.market !== "KOSDAQ") return null;
  const limit = row.sectorLimit;
  const status = limit?.status ?? "unknown";
  const countLabel = `${limit?.count ?? "—"}/${limit?.limit ?? "—"}`;
  const label =
    status === "blocked" ? "섹터 제한" : status === "room" ? "섹터 여유" : "섹터 미확인";
  return (
    <div className="mt-1.5 max-w-[240px] text-[10px] leading-relaxed" data-sector-status={status}>
      <span
        className={`inline-flex flex-wrap items-center gap-x-1 rounded border px-1.5 py-0.5 font-medium ${status === "blocked" ? "border-destructive/30 bg-destructive/10 text-destructive" : status === "room" ? "border-border bg-muted text-foreground" : "border-warn/30 bg-warn/10 text-warn"}`}
      >
        {label} · {countLabel}종목
      </span>
      <span className="mt-0.5 block text-muted-foreground">
        {status === "blocked" ? "추가 진입 제한 · " : ""}
        {status === "unknown" ? `${limit?.issue ?? "전략 장부 미수신"} · ` : ""}
        실제 배분 기준 {limit?.asOfDate ?? "미확인"}
      </span>
      {limit?.limit != null ? (
        <span className="block text-muted-foreground">
          {row.market} 한도 {Math.round(limit.cap * 100)}% · 국내 {limit.maxPositions}슬롯
        </span>
      ) : null}
    </div>
  );
}
export function DashboardSignalLists({ query }: { query: OperationsQuery }) {
  const [tab, setTab] = useState<
    "all" | "conditions" | "onsets" | "pending" | "exits" | "notPurchased"
  >("all");
  const [decisionCandidate, setDecisionCandidate] = useState<EntryDecisionCandidate | null>(null);
  const [market, setMarket] = useState<DashboardMarket | "ALL">("ALL");
  const [page, setPage] = useState(0);
  const [purchaseCandidate, setPurchaseCandidate] = useState<PurchaseRecordCandidate | null>(null);
  const [allocationCandidate, setAllocationCandidate] =
    useState<OperatingAllocationCandidate | null>(null);
  const listMarkets = (kind: typeof tab): DashboardMarket[] =>
    kind === "pending" ? ["KOSPI", "ETF"] : ["KOSPI", "KOSDAQ", "ETF", "US"];
  const selectedMarkets = listMarkets(tab).filter((m) => market === "ALL" || m === market);
  const selected = (query.data?.markets ?? []).filter((m) => selectedMarkets.includes(m.market));
  const inbox = dashboardInbox(selected);
  const rows = tab === "all" ? inbox : selected.flatMap((m) => m[tab] ?? []);
  const rowKind = (row: DashboardSignal): InboxKind | "conditions" =>
    tab === "all"
      ? (inbox.find((r) => r.market === row.market && r.symbol === row.symbol)?.inboxKind ?? "raw")
      : tab;
  if (tab !== "exits" && tab !== "all") rows.sort(compareDashboardCandidates);
  const pageCount = Math.max(1, Math.ceil(rows.length / 25));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = rows.slice(currentPage * 25, currentPage * 25 + 25);
  const incomplete = selectedMarkets.some((selectedMarket) => {
    const item = selected.find((m) => m.market === selectedMarket);
    return (
      (tab === "notPurchased"
        ? 0
        : tab === "all"
          ? item?.onsetCount
          : tab === "conditions"
            ? item?.conditionCount
            : tab === "onsets"
              ? item?.onsetCount
              : tab === "pending"
                ? item?.pendingCount
                : item?.exitCount) == null
    );
  });
  const selectedPreview = allocationCandidate
    ? query.data?.actualAllocation?.previews.find(
        (p) =>
          p.market === allocationCandidate.market &&
          p.symbol === allocationCandidate.symbol &&
          p.signalOriginDate === allocationCandidate.signalOriginDate,
      )
    : null;
  const selectedSignal = allocationCandidate
    ? query.data?.markets
        .flatMap((m) => m.onsets)
        .find(
          (s) =>
            s.market === allocationCandidate.market &&
            s.symbol === allocationCandidate.symbol &&
            s.signalOriginDate === allocationCandidate.signalOriginDate,
        )
    : null;
  const currentAllocationCandidate = allocationCandidate
    ? {
        ...allocationCandidate,
        sourceDate: selectedSignal?.date ?? allocationCandidate.sourceDate,
        status: selectedPreview?.status ?? ("WAITING" as const),
        quantity: selectedPreview?.quantity ?? null,
        cashRequired: selectedPreview?.cashRequired ?? null,
      }
    : null;
  const totals = (kind: "all" | "conditions" | "onsets" | "pending" | "exits" | "notPurchased") =>
    kind === "all"
      ? dashboardInbox(query.data?.markets ?? []).length
      : (query.data?.markets ?? [])
          .filter((m) => listMarkets(kind).includes(m.market))
          .reduce((sum, m) => sum + (m[kind]?.length ?? 0), 0);
  return (
    <section
      className="mt-3 rounded-lg border border-border bg-card"
      aria-label="통합 조건달성종목"
    >
      <div className="border-b border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            오늘 확인할 종목 ·{" "}
            {tab === "pending" ? "KOSPI / ETF" : "KOSPI / KOSDAQ / ETF / 미국 A0"}
          </h2>
          <select
            aria-label="조건달성종목 시장"
            value={market}
            onChange={(e) => {
              setMarket(e.target.value as DashboardMarket | "ALL");
              setPage(0);
            }}
            className="rounded border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="ALL">전체 시장</option>
            {listMarkets(tab).map((item) => (
              <option key={item} value={item}>
                {LABEL[item]}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          실제 원장 기준 · 시장별 최신 기준일 · 전략 원장과 비교 성과는{" "}
          <Link to="/shadow" className="underline">
            Shadow
          </Link>
          에서 확인합니다.
        </p>
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer">신호·배분 안내</summary>{" "}
          <p className="mt-1 text-[10px] text-muted-foreground">
            시장 간 점수를 서로 비교하지 않습니다. 확인대기는 KOSPI·ETF의 다음 거래일 확인 전
            종목입니다. ETF 기존 원신호는 확인일 KRX 자료가 도착할 때까지 대기를 유지하며, 확인
            탈락은 제외합니다. 조건 충족과 실제 미보유 후보를 구분하며, 실제 체결을 포트폴리오에
            기록하면 보유·청산·재진입 판단에 반영합니다. 실제 매도로 소진된 원신호는 다시 사용하지
            않습니다. EXIT는 실제 원장 보유종목의 청산 신호만 집계하며, ETF 자료 미확인은 청산
            신호가 아닙니다. KOSPI는 체결 직전 완료 거래일 시장국면을 다시 확인합니다.
          </p>
          {tab !== "exits" && selectedMarkets.some((m) => m === "KOSPI" || m === "KOSDAQ") ? (
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              실제 S06 배분은 한국/ETF/미국 40/20/40입니다. 실제 보유·예약 슬롯과 시장별 현금 귀속을
              함께 확인합니다. 예산이나 현금이 미확정이어도 진입 조건 충족은 계속 표시합니다. 예상
              수량은 현재 종가 기준이며 실제 주문 전에 체결가와 주문가능 현금을 다시 확인하세요.
            </p>
          ) : null}
        </details>
        <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="신호 종류">
          {(["all", "exits", "onsets", "notPurchased", "pending", "conditions"] as const).map(
            (kind) => (
              <Button
                key={kind}
                id={`dashboard-tab-${kind}`}
                role="tab"
                aria-selected={tab === kind}
                aria-controls="dashboard-signal-panel"
                size="sm"
                variant={tab === kind ? "default" : "outline"}
                onClick={() => {
                  setTab(kind);
                  if (market !== "ALL" && !listMarkets(kind).includes(market)) setMarket("ALL");
                  setPage(0);
                }}
              >
                {kind === "notPurchased"
                  ? "미매수"
                  : kind === "all"
                    ? "전체 신호"
                    : kind === "conditions"
                      ? "진입 조건 충족"
                      : kind === "onsets"
                        ? "실제 미보유 후보"
                        : kind === "pending"
                          ? "확인대기"
                          : "실제 EXIT"}{" "}
                {query.data ? `(${totals(kind)})` : ""}
              </Button>
            ),
          )}
        </div>
      </div>
      {decisionCandidate ? (
        <ActualEntryDecisionDialog
          candidate={decisionCandidate}
          onClose={() => setDecisionCandidate(null)}
        />
      ) : null}
      {purchaseCandidate ? (
        <Suspense
          fallback={
            <p role="status" className="p-4">
              매수 기록 창을 여는 중입니다…
            </p>
          }
        >
          <PurchaseRecordEditor
            key={`${purchaseCandidate.market}:${purchaseCandidate.symbol}`}
            entryCandidate={purchaseCandidate}
            onEntryClose={() => setPurchaseCandidate(null)}
          />
        </Suspense>
      ) : null}
      {allocationCandidate ? (
        <div className="p-3">
          <Button variant="outline" onClick={() => setAllocationCandidate(null)}>
            예산 검토 닫기
          </Button>
          <OperatingAllocationPanel editable candidate={currentAllocationCandidate} />
        </div>
      ) : null}
      <div id="dashboard-signal-panel" role="tabpanel" aria-labelledby={`dashboard-tab-${tab}`}>
        {incomplete ? (
          <p className="px-3 pt-3 text-[11px] text-warn">
            일부 시장은 신호 또는 보유정보가 미확인입니다. 확인된 종목만 표시합니다.
          </p>
        ) : null}
        {query.isPending ? (
          <p role="status" className="p-6 text-xs text-muted-foreground">
            저장된 신호를 불러오는 중입니다…
          </p>
        ) : query.isError ? (
          <p role="alert" className="p-6 text-xs text-destructive">
            신호를 불러오지 못했습니다.{" "}
            <button className="underline" onClick={() => void query.refetch()}>
              다시 조회
            </button>
          </p>
        ) : visible.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-xs">
              <thead>
                <tr className="border-b text-[11px] text-muted-foreground">
                  <th className="px-3 py-2 text-left">시장 / 전략</th>
                  <th className="px-3 py-2 text-left">종목 / 섹터</th>
                  <th className="px-3 py-2 text-left">기준일</th>
                  <th className="px-3 py-2 text-right">점수 / Core</th>
                  <th className="px-3 py-2 text-right">가격</th>
                  {tab === "onsets" || tab === "all" ? (
                    <th className="px-3 py-2 text-left">실제 예산 · 예상 수량</th>
                  ) : null}
                  <th className="px-3 py-2 text-left">신호 근거</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={`${row.market}:${row.symbol}`} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-3 py-3">{LABEL[row.market]}</td>
                    <td className="px-3 py-3">
                      <SignalLink row={row} />
                      <span className="block text-[10px] text-muted-foreground">{row.sector}</span>
                    </td>
                    <td className="num whitespace-nowrap px-3 py-3">{row.date}</td>
                    <td className="num whitespace-nowrap px-3 py-3 text-right">
                      {row.score === null
                        ? "—"
                        : row.market === "US"
                          ? `상위 ${((1 - row.score) * 100).toFixed(1)}%`
                          : `${row.score.toFixed(1)} / ${row.market === "ETF" ? 100 : 10}`}
                    </td>
                    <td className="num whitespace-nowrap px-3 py-3 text-right">
                      {row.price === null
                        ? "—"
                        : row.market === "US"
                          ? usd(row.price)
                          : `${row.price.toLocaleString("ko-KR")}원`}
                    </td>
                    {tab === "onsets" || tab === "all" ? (
                      <td className="px-3 py-3">
                        {rowKind(row) === "onsets" ? (
                          <>
                            <Button
                              size="sm"
                              className="mb-1"
                              onClick={() =>
                                setPurchaseCandidate({
                                  symbol: row.symbol,
                                  name: row.name,
                                  market: row.market,
                                })
                              }
                            >
                              매수수량 기록
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="mb-1 ml-1"
                              onClick={() =>
                                setDecisionCandidate({
                                  market: row.market,
                                  symbol: row.symbol,
                                  name: row.name,
                                  signalOriginDate: row.signalOriginDate ?? row.date,
                                })
                              }
                            >
                              미매수 처리
                            </Button>
                            {(() => {
                              const preview = query.data?.actualAllocation?.previews.find(
                                (p) =>
                                  p.market === row.market &&
                                  p.symbol === row.symbol &&
                                  p.signalOriginDate === row.signalOriginDate,
                              );
                              return preview ? (
                                <details>
                                  <summary className="cursor-pointer text-xs">
                                    예산·수량 확인
                                  </summary>
                                  <div>
                                    {preview.budget == null
                                      ? "미확정"
                                      : Number(preview.budget).toLocaleString("ko-KR", {
                                          maximumFractionDigits: row.market === "US" ? 2 : 0,
                                        })}{" "}
                                    {row.market === "US" ? "USD" : "KRW"}
                                  </div>
                                  <div>
                                    {preview.quantity === null
                                      ? "수량 미확정"
                                      : `${preview.quantity}주`}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground">
                                    {preview.reason}
                                  </div>
                                  {row.signalOriginDate ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        setAllocationCandidate({
                                          market: row.market,
                                          symbol: row.symbol,
                                          name: row.name,
                                          signalOriginDate: row.signalOriginDate!,
                                          sourceDate: row.date,
                                          cashRequired: preview.cashRequired,
                                          quantity: preview.quantity,
                                          status: preview.status,
                                        })
                                      }
                                    >
                                      예산·예약 상세 (선택)
                                    </Button>
                                  ) : null}
                                </details>
                              ) : (
                                <span className="block text-xs">예산 확인 필요</span>
                              );
                            })()}
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {rowKind(row) === "exits" ? "매도 체결 확인" : "조건 확인"}
                          </span>
                        )}
                      </td>
                    ) : null}
                    <td className={`px-3 py-3 ${tab === "onsets" ? "text-up" : "text-warn"}`}>
                      <div className="max-w-64 truncate" title={dashboardCopy(row.reason)}>
                        {row.entryDecision && rowKind(row) !== "exits"
                          ? entryDecisionLabel(row.entryDecision)
                          : rowKind(row) === "exits"
                            ? dashboardCopy(row.reason)
                            : rowKind(row) === "onsets"
                              ? "진입 준비"
                              : rowKind(row) === "pending"
                                ? "확인 대기"
                                : rowKind(row) === "raw"
                                  ? "원신호 · 진입 미확정"
                                  : "조건 충족"}
                      </div>
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer">상세 근거</summary>
                        <p>{dashboardCopy(row.reason)}</p>
                        {row.entryDecision ? (
                          <>
                            <p>{row.entryDecision.note}</p>
                            <Link to="/portfolio" className="underline">
                              미매수·제한 관리에서 해제
                            </Link>
                          </>
                        ) : null}
                        {row.signalOriginDate ? (
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            원신호 {row.signalOriginDate}
                          </div>
                        ) : null}
                        {row.actualQuantity !== undefined ? (
                          <div className="text-[10px] text-muted-foreground">
                            실제 보유{" "}
                            {row.actualQuantity.toLocaleString("ko-KR", {
                              maximumFractionDigits: 20,
                            })}
                            주 · 진입 {row.actualEntryDate}
                          </div>
                        ) : null}
                        {tab !== "exits" ? (
                          <OnsetProfileDetails profile={row.onsetProfile} compact />
                        ) : null}
                        {tab !== "exits" ? <DashboardSectorLimitBadge row={row} /> : null}
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-6 text-xs text-muted-foreground">
            {incomplete
              ? "확인된 신호가 없습니다. 미확인 시장의 데이터를 확인해 주세요."
              : `해당 ${tab === "conditions" ? "진입 조건 충족" : tab === "onsets" ? "실제 미보유 후보" : tab === "pending" ? "확인대기" : "실제 보유 EXIT"} 종목이 없습니다.`}
          </p>
        )}
        {rows.length > 25 ? (
          <div className="flex items-center justify-end gap-3 border-t p-3 text-xs" data-no-print>
            <span>
              {rows.length}종목 · {currentPage + 1} / {pageCount}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              이전
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              다음
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
