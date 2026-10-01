import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { StrategyDescription } from "./StrategyDescription";
import { supabase } from "@/lib/cloud";
import { formatCount, formatKstDateTime } from "@/lib/format";
import {
  dashboardOperationsServer,
  dashboardEtfHoldingsServer,
} from "@/lib/dashboardOperations.functions";
import type {
  DashboardMarket,
  DashboardOperations,
  DashboardSignal,
} from "@/lib/dashboardOperations";
import type { DashboardSummary } from "@/lib/screeningCacheContract";

const LABEL: Record<DashboardMarket, string> = {
  KOSPI: "KOSPI",
  KOSDAQ: "KOSDAQ",
  ETF: "ETF",
  US: "미국 A0",
};
const MARKETS: DashboardMarket[] = ["KOSPI", "KOSDAQ", "ETF", "US"];
export const DASHBOARD_OPERATIONS_QUERY = ["dashboard-operations"];
async function accessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("먼저 로그인해 주세요.");
  return data.session.access_token;
}
export function useDashboardOperations(started: boolean, digest: string | undefined) {
  const qc = useQueryClient();
  useEffect(
    () =>
      qc.getQueryCache().subscribe((event) => {
        if (
          event.type === "updated" &&
          event.action.type === "success" &&
          ["portfolio-ledgers", "us-actual-ledger"].includes(String(event.query.queryKey[0]))
        ) {
          void qc.invalidateQueries({ queryKey: DASHBOARD_OPERATIONS_QUERY });
        }
      }),
    [qc],
  );
  return useQuery<DashboardOperations>({
    queryKey: [...DASHBOARD_OPERATIONS_QUERY, digest],
    queryFn: async () => dashboardOperationsServer({ data: { accessToken: await accessToken() } }),
    enabled: started && Boolean(digest),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
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
function EtfHoldings({ query }: { query: OperationsQuery }) {
  const qc = useQueryClient();
  const [input, setInput] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = query.data?.etfHoldings;
  const text = input ?? saved?.symbols.join(", ") ?? "";
  async function save() {
    setSaving(true);
    try {
      const symbols = text
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await dashboardEtfHoldingsServer({ data: { accessToken: await accessToken(), symbols } });
      await qc.invalidateQueries({ queryKey: DASHBOARD_OPERATIONS_QUERY });
      setInput(null);
      toast.success("ETF 보유종목을 저장했습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ETF 보유종목 저장 실패");
    } finally {
      setSaving(false);
    }
  }
  return (
    <details className="mt-3 text-[11px]" data-no-print>
      <summary className="cursor-pointer font-medium text-primary">ETF 보유종목 등록·수정</summary>
      <p className="my-2 leading-relaxed text-muted-foreground">
        실제 보유 ETF의 6자리 코드를 쉼표로 구분해 저장하세요. 보유가 없으면 빈칸으로 저장합니다.
        미등록은 0건으로 간주하지 않습니다. 매매 주문은 실행하지 않습니다.
      </p>
      <Input
        aria-label="ETF 실제 보유종목 코드"
        placeholder="예: 069500, 229200"
        value={text}
        disabled={saving || query.isPending}
        onChange={(e) => setInput(e.target.value)}
        className="text-xs"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground">
          {saved ? `${saved.symbols.length}종목 · ${formatKstDateTime(saved.updatedAt)}` : "미등록"}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={saving || query.isPending || query.isError}
          onClick={() => void save()}
        >
          {saving ? "저장 중…" : "보유종목 저장"}
        </Button>
      </div>
    </details>
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
  return (
    <section
      className="rounded-lg border border-border bg-card p-4"
      aria-label="오늘의 진입 준비/EXIT"
    >
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
        <TrendingUp className="size-4 text-primary" />
        오늘의 진입 준비/EXIT
      </h2>
      <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">
        시장별 최신 확정 거래일 기준 · KOSPI는 하루 확인·RSAccel 조건을 통과한 진입 준비만 집계 ·
        EXIT는 실제 보유종목 기준입니다.
      </p>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b text-[10px] text-muted-foreground">
            <th className="py-2 text-left">시장 / 기준일</th>
            <th className="text-right">진입 준비</th>
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
          — 는 보유정보 또는 신호 미확인입니다. 진입 준비는 보유 확인 전 조건달성 수입니다.
        </p>
      ) : null}
      <div className="mt-2 border-t border-border pt-1">
        <Row label="KOSPI 하루 확인 대기">
          {kospiPending == null ? "—" : `${formatCount(kospiPending)}종목`}
        </Row>
        <Row label="점수 산정 불가">{formatCount(counts.incomplete)}</Row>
      </div>
      <EtfHoldings query={query} />
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
              {w}
            </p>
          ))}
        </details>
      ) : null}
    </section>
  );
}

export function UsDashboardPortfolio({ query }: { query: OperationsQuery }) {
  const portfolio = query.data?.usPortfolio;
  const fallback = query.isPending ? "불러오는 중…" : query.isError ? "조회 실패" : "미확인";
  return (
    <section
      className="rounded-lg border border-border bg-card p-4"
      aria-label="미국주식 A0 포트폴리오"
    >
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
        <ShieldCheck className="size-4 text-primary" />
        미국주식 A0 포트폴리오
      </h2>
      <p className="mb-2 text-[10px] text-muted-foreground">실제 체결 원장 기준 · USD</p>
      <Row label="운용자금">{portfolio ? usd(portfolio.capital) : fallback}</Row>
      <Row label="보유 종목수">
        {portfolio ? `${portfolio.summary.openPositions}종목` : fallback}
      </Row>
      <Row label="평가손익">{portfolio ? usd(portfolio.summary.unrealizedPnl) : fallback}</Row>
      <Row label="실현손익">{portfolio ? usd(portfolio.summary.realizedPnl) : fallback}</Row>
      {portfolio?.unpricedPositions ? (
        <p className="mt-2 text-[10px] text-warn">
          {portfolio.unpricedPositions}종목은 최신 평가가격을 확인하지 못해 기존 원장 가격을
          사용했습니다.
        </p>
      ) : null}
      <Link
        to="/us/portfolio"
        className="mt-3 inline-flex text-[11px] font-medium text-primary hover:underline"
      >
        포트폴리오 상세 보기 →
      </Link>
    </section>
  );
}

export function DashboardStrategyRules() {
  return (
    <div className="space-y-3 text-[11px] leading-relaxed text-muted-foreground">
      <StrategyDescription />
      <p>
        이미 보유한 종목과 Onset 이후 청산한 같은 신호는 신규 진입에서 제외하며, 보유 중 상단 점수
        돌파 시 EXIT를 우선합니다.
      </p>
      <div className="border-t border-border pt-2">
        <h3 className="font-semibold text-foreground">ETF · M0</h3>
        <p>M0 80점 신규 돌파 진입 · 기초지수 MA60 하회 시 청산 · 데이터 오류 시 청산 점검.</p>
        <p>
          최대 10종목 · 기본 비중 10% × min(1, 15% / 20일 연율 변동성). 신규 매수에 적용하며
          진입·청산은 다음 거래일 시가 기준입니다.
        </p>
      </div>
      <div className="border-t border-border pt-2">
        <h3 className="font-semibold text-foreground">미국 A0 · 실제 운용</h3>
        <p>
          ret120/252 Core 상위 20% 신규 진입 + Beta 상위 10% 이내 + TK 상위 20% 이내 + 공통 유동성
          조건 충족.
        </p>
        <p>Core 상위 30% 밖 또는 산정 불가 시 청산. Beta 상위 40% 밖 3거래일 연속도 청산합니다.</p>
        <p>
          비중조정은 분기별 · 신규 진입/청산 신호는 매일 확인하고 다음 거래일 시가에 반영합니다.
        </p>
      </div>
    </div>
  );
}

function SignalLink({ row }: { row: DashboardSignal }) {
  if (row.market === "US")
    return (
      <Link to="/us/screener" className="font-medium hover:underline">
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
export function DashboardSignalLists({ query }: { query: OperationsQuery }) {
  const [tab, setTab] = useState<"onsets" | "pending" | "exits">("onsets");
  const [market, setMarket] = useState<DashboardMarket | "ALL">("ALL");
  const [page, setPage] = useState(0);
  const selected = (query.data?.markets ?? []).filter(
    (m) => m.market !== "ETF" && (market === "ALL" || m.market === market),
  );
  const rows = selected.flatMap((m) => m[tab] ?? []);
  const pageCount = Math.max(1, Math.ceil(rows.length / 25));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = rows.slice(currentPage * 25, currentPage * 25 + 25);
  const incomplete = selected.some(
    (m) =>
      (tab === "onsets" ? m.onsetCount : tab === "pending" ? m.pendingCount : m.exitCount) === null,
  );
  const totals = (kind: "onsets" | "pending" | "exits") =>
    (query.data?.markets ?? [])
      .filter((m) => m.market !== "ETF")
      .reduce((sum, m) => sum + (m[kind]?.length ?? 0), 0);
  return (
    <section
      className="mt-6 rounded-lg border border-border bg-card"
      aria-label="통합 조건달성종목"
    >
      <div className="border-b border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">조건달성종목 · KOSPI / KOSDAQ / 미국 A0</h2>
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
            <option value="KOSPI">KOSPI</option>
            <option value="KOSDAQ">KOSDAQ</option>
            <option value="US">미국 A0</option>
          </select>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          시장 간 점수를 서로 비교하지 않습니다. 진입 준비는 시장별 우선순위 순이며, KOSPI 원시
          Onset은 하루 확인 대기로 분리합니다. EXIT는 실제 보유종목만 표시합니다.
        </p>
        <div className="mt-3 flex gap-2" role="tablist" aria-label="신호 종류">
          {(["onsets", "pending", "exits"] as const).map((kind) => (
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
                setPage(0);
              }}
            >
              {kind === "onsets" ? "진입 준비" : kind === "pending" ? "KOSPI 확인 대기" : "EXIT"}{" "}
              {query.data ? `(${totals(kind)})` : ""}
            </Button>
          ))}
        </div>
      </div>
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
                          : `${row.score.toFixed(1)} / 10`}
                    </td>
                    <td className="num whitespace-nowrap px-3 py-3 text-right">
                      {row.price === null
                        ? "—"
                        : row.market === "US"
                          ? usd(row.price)
                          : `${row.price.toLocaleString("ko-KR")}원`}
                    </td>
                    <td className={`px-3 py-3 ${tab === "onsets" ? "text-up" : "text-warn"}`}>
                      {row.reason}
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
              : `해당 ${tab === "onsets" ? "진입 준비" : tab === "pending" ? "KOSPI 확인 대기" : "보유 EXIT"} 종목이 없습니다.`}
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
