import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  loadUsPortfolioSnapshots,
  loadUsPortfolioTrades,
  loadUsStrategyRegistry,
  type UsPortfolioSnapshotRecord,
  type UsPortfolioTradeRecord,
} from "@/lib/usProspectiveCloud";

export const Route = createFileRoute("/us/portfolio")({
  ssr: false,
  head: () => ({ meta: [{ title: "US 포트폴리오 | CloudTrend Prospective OOS" }] }),
  component: UsPortfolioPage,
});

const ORDER = ["A0_QUARTER_PRIMARY", "A2_QUARTER_SHADOW", "B3_BETA_SHADOW", "SPY_BENCHMARK"];
const LABEL: Record<string, string> = {
  A0_QUARTER_PRIMARY: "A0 분기 · β Anchor",
  A2_QUARTER_SHADOW: "A2 분기",
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

function UsPortfolioPage() {
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
  const [selectedStrategy, setSelectedStrategy] = useState("A0_QUARTER_PRIMARY");

  const latest = useMemo(() => {
    const out = new Map<string, UsPortfolioSnapshotRecord>();
    for (const r of snapshots.data ?? []) if (!out.has(r.strategy_id)) out.set(r.strategy_id, r);
    return out;
  }, [snapshots.data]);
  const series = useMemo(() => {
    const by = new Map<string, UsPortfolioSnapshotRecord[]>();
    for (const r of snapshots.data ?? []) {
      const arr = by.get(r.strategy_id) ?? [];
      arr.push(r);
      by.set(r.strategy_id, arr);
    }
    for (const arr of by.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
    return by;
  }, [snapshots.data]);

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
  const pending = (trades.data ?? [])
    .filter((t) => t.status === "PENDING" && t.strategy_id === selectedStrategy)
    .slice(0, 50);
  const executed = (trades.data ?? []).filter(
    (t) =>
      (t.status === "EXECUTED" || t.status === "PARTIAL") && t.strategy_id === selectedStrategy,
  );

  return (
    <AppShell loadAnalysis={false}>
      <div className="space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">US 포트폴리오 · Prospective OOS</h1>
              <Badge>A0 PRIMARY</Badge>
            </div>
            <p className="mt-1 max-w-4xl text-[11px] leading-relaxed text-muted-foreground">
              A0 분기 + Beta 상위 40% 밖 3거래일 연속 Anchor는 기준 모델, A2 분기와 B3 Beta는
              Shadow입니다. 실제 투자 내역과 분리해 A0·A2·B3 모델 신호·NAV·보유·거래만
              prospective 방식으로 누적합니다.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void qc.invalidateQueries({ queryKey: ["us-portfolio-snapshots"] });
              void qc.invalidateQueries({ queryKey: ["us-portfolio-trades"] });
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
            아직 확정된 미국 포트폴리오가 없습니다. 첫 수집일은 순위 기준을 저장하고 이후 발생한
            진입 신호부터 추적합니다.
          </p>
        )}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {ORDER.map((id) => {
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

        <section className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3">
            <h2 className="text-sm font-semibold">정규화 NAV 추적</h2>
            <p className="text-[10px] text-muted-foreground">
              모든 전략과 SPY를 USD 100,000에서 시작해 같은 prospective 날짜 축으로 비교합니다.
            </p>
          </div>
          <NavChart series={series} />
        </section>

        <label className="text-xs">
          모델 보유·대기 주문 전략{" "}
          <select
            value={selectedStrategy}
            onChange={(e) => setSelectedStrategy(e.target.value)}
            className="rounded border bg-background p-1"
          >
            {ORDER.filter((id) => id !== "SPY_BENCHMARK").map((id) => (
              <option key={id} value={id}>
                {LABEL[id]}
              </option>
            ))}
          </select>
        </label>
        <section className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-lg border border-border bg-card">
            <div className="border-b p-3">
              <h2 className="text-sm font-semibold">{LABEL[selectedStrategy]} 모델 보유</h2>
              <p className="text-[10px] text-muted-foreground">
                분기 비중조정, 신규 Onset/Exit는 매일 반영
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-[11px]">
                <thead>
                  <tr className="border-b text-muted-foreground [&>th]:px-2 [&>th]:py-2">
                    <th className="text-left">종목</th>
                    <th>섹터</th>
                    <th className="text-right">수량</th>
                    <th className="text-right">현재가</th>
                    <th>진입일</th>
                    <th className="text-right">진입 Core 상위</th>
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
          <div className="rounded-lg border border-border bg-card">
            <div className="border-b p-3">
              <h2 className="text-sm font-semibold">다음 정규장 모델 주문 대기</h2>
              <p className="text-[10px] text-muted-foreground">
                오늘 종가 신호 → 다음 미국 정규장 시가 모델
              </p>
            </div>
            <TradeTable rows={pending} compact />
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card">
            <div className="border-b p-3">
              <h2 className="text-sm font-semibold">모델 체결 원장</h2>
              <p className="text-[10px] text-muted-foreground">
                선택한 A0/A2/B3 모델의 prospective 체결만 표시합니다. 실제 투자 내역은 통합
                포트폴리오 탭에서 별도로 관리합니다.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-[10px]">
                <thead>
                  <tr className="border-b text-muted-foreground [&>th]:px-2 [&>th]:py-2">
                    <th>전략</th>
                    <th>신호일</th>
                    <th>체결일</th>
                    <th>종목</th>
                    <th>Side</th>
                    <th>사유</th>
                    <th>상태</th>
                    <th className="text-right">모델가격</th>
                    <th className="text-right">모델수량</th>
                    <th>모델비용 USD</th>
                  </tr>
                </thead>
                <tbody>
                  {executed.map((t) => (
                    <tr
                      key={t.trade_key}
                      className="border-b last:border-0 [&>td]:px-2 [&>td]:py-2"
                    >
                      <td>{LABEL[t.strategy_id] ?? t.strategy_id}</td>
                      <td>{t.signal_date}</td>
                      <td>{t.execution_date ?? "-"}</td>
                      <td className="font-medium">{t.symbol}</td>
                      <td>{t.side}</td>
                      <td>{t.reason}</td>
                      <td>{t.status}</td>
                      <td className="num text-right">
                        {t.model_price ? `$${t.model_price.toFixed(2)}` : "-"}
                      </td>
                      <td className="num text-right">{t.model_shares ?? "-"}</td>
                      <td className="num text-right">${Number(t.fee_usd).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {executed.length === 0 ? (
                <p className="p-6 text-center text-xs text-muted-foreground">
                  선택한 전략의 모델 체결 기록이 없습니다.
                </p>
              ) : null}
            </div>
        </section>
      </div>
    </AppShell>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-medium">{value}</p>
    </div>
  );
}
function TradeTable({ rows }: { rows: UsPortfolioTradeRecord[]; compact?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[700px] text-[10px]">
        <thead>
          <tr className="border-b text-muted-foreground [&>th]:px-2 [&>th]:py-2">
            <th>신호일</th>
            <th>종목</th>
            <th>Side</th>
            <th>사유</th>
            <th className="text-right">목표금액</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.trade_key} className="border-b last:border-0 [&>td]:px-2 [&>td]:py-2">
              <td>{t.signal_date}</td>
              <td className="font-medium">{t.symbol}</td>
              <td>{t.side}</td>
              <td>{t.reason}</td>
              <td className="num text-right">{usd(t.model_notional)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <p className="p-6 text-center text-[11px] text-muted-foreground">
          현재 대기 주문이 없습니다.
        </p>
      ) : null}
    </div>
  );
}

function NavChart({ series }: { series: Map<string, UsPortfolioSnapshotRecord[]> }) {
  const dates = Array.from(
    new Set(Array.from(series.values()).flatMap((x) => x.map((r) => r.date))),
  ).sort();
  if (dates.length < 2)
    return (
      <div className="flex h-48 items-center justify-center text-[11px] text-muted-foreground">
        prospective 데이터가 2거래일 이상 쌓이면 추이가 표시됩니다.
      </div>
    );
  const all = Array.from(series.values())
    .flatMap((x) => x.map((r) => Number(r.nav_usd)))
    .filter(Number.isFinite);
  const min = Math.min(...all),
    max = Math.max(...all);
  const w = 1000,
    h = 240,
    p = 20;
  const x = (d: string) => p + (dates.indexOf(d) / (dates.length - 1)) * (w - 2 * p);
  const y = (v: number) => (max === min ? h / 2 : p + (1 - (v - min) / (max - min)) * (h - 2 * p));
  const strokes = [
    "currentColor",
    "var(--color-primary)",
    "var(--color-muted-foreground)",
    "var(--color-foreground)",
  ];
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-56 min-w-[720px] w-full text-primary">
        {ORDER.map((id, i) => {
          const arr = series.get(id) ?? [];
          if (arr.length < 2) return null;
          const pts = arr.map((r) => `${x(r.date)},${y(Number(r.nav_usd))}`).join(" ");
          return (
            <polyline
              key={id}
              points={pts}
              fill="none"
              stroke={strokes[i]}
              strokeWidth="2"
              opacity={id === "A0_QUARTER_PRIMARY" ? 1 : 0.65}
            />
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-[10px]">
        {ORDER.map((id) => (
          <span key={id}>{LABEL[id]}</span>
        ))}
      </div>
    </div>
  );
}
