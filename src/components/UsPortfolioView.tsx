import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useMemo } from "react";

import { NavSeriesLegend } from "@/components/NavSeriesLegend";
import { navSeriesStyle } from "@/lib/navSeries";
import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UsModelTradeTable } from "@/components/UsModelExecutionJournal";
import { UsModelTaxEstimatePanel } from "@/components/UsModelTaxEstimatePanel";
import { UsA0AllocationRules } from "@/components/UsA0AllocationRules";
import {
  loadUsPortfolioSnapshots,
  loadUsPortfolioTrades,
  loadUsStrategyRegistry,
  type UsPortfolioSnapshotRecord,
} from "@/lib/usProspectiveCloud";

const LABEL: Record<string, string> = {
  A0_QUARTER_PRIMARY: "A0 · β Anchor",
  A2_QUARTER_SHADOW: "A2",
  B3_BETA_SHADOW: "B3 Beta",
  SPY_BENCHMARK: "SPY",
};

function pct(v: number | null | undefined, digits = 2) {
  return v === null || v === undefined ? "-" : `${(v * 100).toFixed(digits)}%`;
}
function topPct(v: number | null | undefined, digits = 1) {
  return v === null || v === undefined ? "-" : `상위 ${((1 - v) * 100).toFixed(digits)}%`;
}
function usd(v: number | null | undefined) {
  return v === null || v === undefined
    ? "-"
    : `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function UsPortfolioView({
  shadowStrategyId,
  fromDate = "",
  toDate = "",
}: {
  shadowStrategyId?: "A0_QUARTER_PRIMARY" | "A2_QUARTER_SHADOW" | "B3_BETA_SHADOW";
  fromDate?: string;
  toDate?: string;
}) {
  const order = shadowStrategyId
    ? [shadowStrategyId, "SPY_BENCHMARK"]
    : ["A0_QUARTER_PRIMARY", "SPY_BENCHMARK"];
  const within = (date: string) => (!fromDate || date >= fromDate) && (!toDate || date <= toDate);
  const qc = useQueryClient();
  const registry = useQuery({
    queryKey: ["us-strategy-registry"],
    queryFn: loadUsStrategyRegistry,
    staleTime: 60_000,
  });
  const snapshots = useQuery({
    queryKey: ["us-portfolio-snapshots"],
    queryFn: () => loadUsPortfolioSnapshots(370),
    staleTime: 60_000,
  });
  const trades = useQuery({
    queryKey: ["us-portfolio-trades"],
    queryFn: () => loadUsPortfolioTrades(800),
    staleTime: 60_000,
  });
  const selectedStrategy = shadowStrategyId ?? "A0_QUARTER_PRIMARY";

  const latest = useMemo(() => {
    const out = new Map<string, UsPortfolioSnapshotRecord>();
    for (const r of snapshots.data ?? []) if (!out.has(r.strategy_id)) out.set(r.strategy_id, r);
    return out;
  }, [snapshots.data]);
  const series = (() => {
    const by = new Map<string, UsPortfolioSnapshotRecord[]>();
    for (const r of snapshots.data ?? []) {
      if (!order.includes(r.strategy_id) || !within(r.date)) continue;
      const arr = by.get(r.strategy_id) ?? [];
      arr.push(r);
      by.set(r.strategy_id, arr);
    }
    for (const arr of by.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
    return by;
  })();

  const currentPrimary = latest.get(selectedStrategy);
  const positions = Object.values(
    (
      currentPrimary?.state as {
        positions?: Record<
          string,
          {
            symbol: string;
            name: string;
            sector: string | null;
            shares: number;
            lastPrice: number;
            entryDate: string;
            entryCoreRank: number | null;
          }
        >;
      }
    )?.positions ?? {},
  );
  const executed = (trades.data ?? []).filter(
    (t) =>
      (t.status === "EXECUTED" || t.status === "PARTIAL") &&
      t.strategy_id === selectedStrategy &&
      within(t.execution_date ?? t.signal_date),
  );

  const content = (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold">
              {shadowStrategyId
                ? `${LABEL[shadowStrategyId]} · USD ${shadowStrategyId === "A0_QUARTER_PRIMARY" ? "모델 기록" : "Shadow"}`
                : "US 포트폴리오 · A0 Primary"}
            </h1>
            <Badge>
              {selectedStrategy === "A0_QUARTER_PRIMARY" ? "A0 PRIMARY · USD" : "SHADOW · USD"}
            </Badge>
          </div>
          <p className="mt-1 max-w-4xl text-[11px] leading-relaxed text-muted-foreground">
            {shadowStrategyId
              ? "기존 미국 모델 원장의 신호·NAV·보유·모델 체결을 그대로 조회합니다. 실제 투자 내역과 자금은 분리됩니다."
              : "A0 + Beta 상위 40% 밖 3거래일 연속 Anchor 기준 모델입니다."}
            {!shadowStrategyId && (
              <>
                {" "}
                A2·B3는{" "}
                <Link to="/shadow" className="underline">
                  통합 Shadow 탭
                </Link>
                에서 관리합니다.
              </>
            )}
            {shadowStrategyId &&
              " 날짜 필터는 NAV 추이와 체결 내역에 적용하며, 상단 요약·보유는 최신 스냅샷입니다."}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void qc.invalidateQueries({ queryKey: ["us-portfolio-snapshots"] });
            void qc.invalidateQueries({ queryKey: ["us-portfolio-trades"] });
            void qc.invalidateQueries({ queryKey: ["us-model-tax-projection"] });
          }}
        >
          <RefreshCw className="size-3.5" />
          새로고침
        </Button>
      </header>

      {(registry.isError || snapshots.isError || trades.isError) && (
        <p role="alert" className="rounded-lg border border-destructive p-3 text-sm">
          포트폴리오를 불러오지 못했습니다. 로그인 상태를 확인한 뒤 새로고침해 주세요.
        </p>
      )}
      {(registry.isLoading || snapshots.isLoading || trades.isLoading) && (
        <p role="status" className="text-sm text-muted-foreground">
          포트폴리오를 불러오는 중입니다.
        </p>
      )}
      {!snapshots.isLoading && !snapshots.isError && snapshots.data?.length === 0 && (
        <p className="rounded-lg border p-3 text-sm text-muted-foreground">
          아직 확정된 미국 포트폴리오가 없습니다. 첫 수집일은 순위 기준을 저장하고 이후 발생한 진입
          신호부터 추적합니다.
        </p>
      )}

      <section aria-label="모델과 벤치마크 요약" className="grid gap-3 sm:grid-cols-2">
        {order.map((id) => {
          const r = latest.get(id);
          const role = (registry.data ?? []).find((x) => x.strategy_id === id)?.role;
          return (
            <div key={id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">{LABEL[id] ?? id}</h2>
                <Badge variant={role === "PRIMARY" ? "default" : "outline"}>
                  {role ?? (id === "SPY_BENCHMARK" ? "BENCHMARK" : "-")}
                </Badge>
              </div>
              <p className="mt-3 text-2xl font-bold num">{usd(r?.nav_usd)}</p>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                <Mini label="누적수익률" value={pct(r?.cumulative_return)} />
                <Mini label="현금" value={usd(r?.cash_usd)} />
                <Mini label="일일 회전율" value={pct(r?.turnover)} />
                <Mini label="일일 비용" value={usd(r?.fees_usd)} />
                <Mini label="SPY NAV" value={usd(r?.benchmark_nav)} />
                <Mini label="보유" value={`${r?.positions_count ?? 0}종목`} />
                <Mini label="기준일" value={r?.date ?? "-"} />
              </div>
            </div>
          );
        })}
      </section>

      <section className="min-w-0" aria-label="모델 보유종목">
        <div className="min-w-0 rounded-lg border border-border bg-card">
          <div className="border-b p-3">
            <h2 className="text-sm font-semibold">{LABEL[selectedStrategy]} 모델 보유</h2>
            <p className="text-[10px] text-muted-foreground">
              2026-10-05부터 초기자금 ÷ 목표 20종목 · 고정 매입 예산. 이전 기록은 당시 규칙을
              보존합니다.
            </p>
            {selectedStrategy === "A0_QUARTER_PRIMARY" ? <UsA0AllocationRules /> : null}
          </div>
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="모델 보유종목 표">
            <table className="w-full min-w-[620px] text-[11px]">
              <thead>
                <tr className="border-b text-muted-foreground [&>th]:px-2 [&>th]:py-2">
                  <th className="text-left">종목</th>
                  <th>섹터</th>
                  <th className="text-right">수량</th>
                  <th className="text-right">현재가</th>
                  <th>진입일</th>
                  <th className="text-right">체결일 종가 Core 상위</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.symbol} className="border-b last:border-0 [&>td]:px-2 [&>td]:py-2">
                    <td className="font-medium">
                      {p.symbol} <span className="text-muted-foreground">{p.name}</span>
                    </td>
                    <td>{p.sector ?? "-"}</td>
                    <td className="num text-right">{p.shares}</td>
                    <td className="num text-right">${p.lastPrice.toFixed(2)}</td>
                    <td>{p.entryDate}</td>
                    <td className="num text-right">{topPct(p.entryCoreRank)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {positions.length === 0 ? (
              <p className="p-6 text-center text-[11px] text-muted-foreground">
                아직 보유 포지션이 없습니다.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <UsModelTradeTable trades={executed} />

      <UsModelTaxEstimatePanel
        snapshot={currentPrimary}
        title={`${LABEL[selectedStrategy] ?? selectedStrategy} · 양도소득세 추정`}
      />

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3">
          <h2 className="text-sm font-semibold">정규화 NAV 추적</h2>
          <p className="text-[10px] text-muted-foreground">
            모든 전략과 SPY를 USD 100,000에서 시작해 같은 prospective 날짜 축으로 비교합니다.
          </p>
        </div>
        <NavChart series={series} order={order} />
      </section>
    </div>
  );
  return shadowStrategyId ? content : <AppShell loadAnalysis={false}>{content}</AppShell>;
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-medium">{value}</p>
    </div>
  );
}
export function NavChart({
  series,
  order,
}: {
  series: Map<string, UsPortfolioSnapshotRecord[]>;
  order: string[];
}) {
  const dates = Array.from(
    new Set(order.flatMap((id) => (series.get(id) ?? []).map((r) => r.date))),
  ).sort();
  const values = order
    .flatMap((id) => (series.get(id) ?? []).map((r) => Number(r.nav_usd)))
    .filter(Number.isFinite);
  const min = Math.min(...values),
    max = Math.max(...values);
  const w = 1000,
    h = 240,
    p = 20;
  const x = (date: string) => p + (dates.indexOf(date) / (dates.length - 1)) * (w - 2 * p);
  const y = (value: number) =>
    max === min ? h / 2 : p + (1 - (value - min) / (max - min)) * (h - 2 * p);
  return (
    <div className="min-w-0">
      {dates.length < 2 || values.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
          prospective 데이터가 2거래일 이상 쌓이면 추이가 표시됩니다.
        </div>
      ) : (
        <>
          <svg
            role="img"
            aria-label="미국 모델과 SPY의 정규화 NAV 추이"
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="none"
            className="h-48 w-full sm:h-56"
          >
            <title>미국 모델과 SPY의 NAV 추이. 아래 범례의 색상과 선 모양으로 구분합니다.</title>
            {order.map((id) => {
              const arr = series.get(id) ?? [];
              if (arr.length < 2) return null;
              const style = navSeriesStyle(id);
              return (
                <polyline
                  key={id}
                  points={arr.map((r) => `${x(r.date)},${y(Number(r.nav_usd))}`).join(" ")}
                  fill="none"
                  stroke={style.color}
                  strokeDasharray={style.dash}
                  strokeWidth="2.5"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
          <div className="mt-1 flex justify-between gap-3 text-xs text-muted-foreground">
            <span>{dates[0]}</span>
            <span>{dates.at(-1)}</span>
          </div>
        </>
      )}
      <NavSeriesLegend
        series={order.map((id) => ({
          id,
          label: LABEL[id] ?? id,
          ...((series.get(id)?.length ?? 0) < 2
            ? { status: (series.get(id)?.length ?? 0) === 0 ? "기록 없음" : "1일 기록 · 추이 대기" }
            : {}),
        }))}
      />
    </div>
  );
}
