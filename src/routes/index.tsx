import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Loader2,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  TrendingUp,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { GradeBadge, ScreenerTable } from "@/components/ScreenerTable";
import { PdfExportButton } from "@/components/PdfExportButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dashboardQueryOptions } from "@/lib/analysisQuery";
import { WARNING_LABELS } from "@/lib/engine/scoring";
import {
  formatCount,
  formatKstDateTime,
  formatNumber,
  formatPercent,
  formatWon,
} from "@/lib/format";
import { buildAndPersistScreeningCaches, type DashboardSummary } from "@/lib/screeningCache";
import { isScreeningStarted } from "@/lib/screeningRun";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "대시보드 | CloudTrend 주식/ETF 스크리너" },
      {
        name: "description",
        content:
          "국내·미국 주식과 ETF의 시장 게이트, 섹터 상대강도, 기술·우선순위 점수를 한 화면에서 확인하는 규칙 기반 스크리닝 대시보드입니다.",
      },
      { property: "og:title", content: "대시보드 | CloudTrend" },
      {
        property: "og:description",
        content: "시장 상태, 스크리닝 요약, 상위 후보와 경고 신호를 계산 근거와 함께 제공합니다.",
      },
    ],
  }),
  errorComponent: ({ error, reset }) => <DataError error={error} reset={reset} />,
  component: Dashboard,
});

function Card({ title, subtitle, icon, children }: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">{icon}{title}</h2>
      {subtitle ? <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{subtitle}</p> : null}
      {children}
    </section>
  );
}

function KeyValue({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border py-1.5 last:border-0">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="num text-[13px] font-medium">
        {value}{hint ? <span className="ml-1 text-[10px] text-muted-foreground">{hint}</span> : null}
      </span>
    </div>
  );
}

function Dashboard() {
  const queryClient = useQueryClient();
  const [started] = useState(() => isScreeningStarted());
  const [rescreening, setRescreening] = useState(false);
  const summaryQuery = useQuery({ ...dashboardQueryOptions, enabled: started });

  const rescreen = async () => {
    setRescreening(true);
    try {
      await buildAndPersistScreeningCaches();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["market-analysis"] }),
      ]);
      queryClient.removeQueries({ queryKey: ["instrument"] });
      toast.success("스크리닝을 다시 계산했습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "스크리닝 재계산에 실패했습니다.");
    } finally {
      setRescreening(false);
    }
  };

  return (
    <AppShell loadAnalysis={false}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">대시보드</h1>
          <p className="text-[12px] text-muted-foreground">
            시장 게이트, 스크리닝 요약, 강한 섹터, 상위 후보 순위를 한 화면에 정리합니다.
          </p>
        </div>
        <div className="flex items-center gap-2" data-no-print>
          {started && !summaryQuery.isPending ? (
            <>
              <PdfExportButton documentTitle="CloudTrend 대시보드" />
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void rescreen()} disabled={rescreening}>
                {rescreening ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                다시 스크리닝
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {!started ? (
        <section className="rounded-lg border border-dashed border-primary/50 bg-card p-8 text-center">
          <SlidersHorizontal className="mx-auto mb-3 size-8 text-primary" />
          <h2 className="mb-1 text-base font-semibold">아직 스크리닝을 시작하지 않았습니다</h2>
          <p className="mx-auto mb-4 max-w-md text-[12px] leading-relaxed text-muted-foreground">
            “데이터·산식” 탭에서 시세 데이터를 업로드한 뒤 “스크리닝 시작”을 누르면 결과 캐시가 생성됩니다.
          </p>
          <Button asChild size="lg" className="gap-2"><Link to="/scoring"><SlidersHorizontal className="size-4" />데이터·산식 탭으로 이동</Link></Button>
        </section>
      ) : summaryQuery.isPending ? (
        <section className="rounded-lg border border-border bg-card p-8">
          <div className="mb-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />최신 대시보드 요약을 불러오는 중입니다…
          </div>
        </section>
      ) : summaryQuery.isError || !summaryQuery.data ? (
        <DataError error={summaryQuery.error ?? "대시보드 요약을 불러오지 못했습니다."} reset={() => summaryQuery.refetch()} embedded />
      ) : (
        <DashboardContent summary={summaryQuery.data} />
      )}
    </AppShell>
  );
}

function DashboardContent({ summary }: { summary: DashboardSummary }) {
  const gate = summary.marketGate;
  const { counts } = summary;
  const gateColor = gate.status === "RISK_ON" ? "text-up" : gate.status === "NEUTRAL" ? "text-warn" : "text-down";
  const gateLabel = gate.status === "RISK_ON" ? "Risk-On" : gate.status === "NEUTRAL" ? "Neutral" : "Risk-Off";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">
          기준일 {summary.asOfDate} · 전략 v{summary.strategyVersion} · 데이터 {summary.dataVersion}
        </p>
        <p className="text-[11px] text-muted-foreground">계산 시각 {formatKstDateTime(summary.calculatedAt)} (KST·미래 데이터 미사용)</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="시장 상태" icon={<Activity className="size-4 text-primary" />}>
          <div className={`mb-2 flex items-center gap-2 text-lg font-bold ${gateColor}`}>
            {gate.status === "RISK_OFF" ? <ArrowDown className="size-5" /> : <ArrowUp className="size-5" />}
            {gateLabel}<span className="num text-xs font-normal text-muted-foreground">게이트 {gate.metCount}/4 충족</span>
          </div>
          {gate.incomplete ? <p className="mb-2 text-[11px] text-warn">판정 불완전 (일부 시장 데이터 없음)</p> : null}
          <KeyValue label="KOSPI 종가 / MA60" value={`${formatNumber(summary.kospi.close, 2)} / ${formatNumber(summary.kospi.ma60, 2)}`} />
          <KeyValue label="KOSPI 구름 상단 위" value={gate.benchmarkAboveCloud === null ? "데이터 없음" : gate.benchmarkAboveCloud ? "충족" : "미충족"} />
          <KeyValue label="KOSDAQ 종가" value={formatNumber(summary.kosdaq.close, 2)} />
          <KeyValue label="변동성지수(VKOSPI 또는 실현변동성)" value={formatNumber(summary.vkospi, 2)} hint="< 30" />
          <KeyValue label="외국인 최근 5일 누적" value={formatWon(summary.marketForeignNet5d)} />
          {gate.status === "NEUTRAL" ? <p className="mt-2 text-[11px] text-warn">Neutral: 신규 진입 후보의 권장 계획 리스크를 50%로 축소 표시합니다.</p> : null}
          {gate.status === "RISK_OFF" ? <p className="mt-2 text-[11px] text-down">Risk-Off: 점수가 높아도 “관망” 또는 “리테스트 대기”로 표시합니다.</p> : null}
        </Card>

        <Card title="오늘의 스크리닝 요약" icon={<TrendingUp className="size-4 text-primary" />}>
          <KeyValue label="전체 분석 종목 수" value={formatCount(counts.total)} />
          <KeyValue label="Universe Filter 통과" value={formatCount(counts.passed)} />
          <KeyValue label="60점 Onset · 진입후보" value={formatCount(counts.entryOnsets)} />
          <KeyValue label="70점 Onset · 우선진입후보" value={formatCount(counts.priorityOnsets)} />
          <KeyValue label="모멘텀 위험" value={formatCount(counts.momentumRisk)} />
          <KeyValue label="A등급" value={formatCount(counts.gradeA)} />
          <KeyValue label="B등급" value={formatCount(counts.gradeB)} />
          <KeyValue label="신규 A등급 진입" value={counts.newGradeA === null ? "미집계" : formatCount(counts.newGradeA)} hint={counts.previousDate ? `${counts.previousDate} 대비` : "이전 날짜 스냅샷 없음"} />
          <KeyValue label="A→B 하락" value={counts.droppedAtoB === null ? "미집계" : formatCount(counts.droppedAtoB)} hint={counts.previousDate ? `${counts.previousDate} 대비` : "이전 날짜 스냅샷 없음"} />
          <KeyValue label="데이터 미완전 종목" value={formatCount(counts.incomplete)} />
          <p className="mt-2 text-[11px] text-muted-foreground">결과는 <Link to="/history" className="text-primary hover:underline">스크리닝 이력</Link> 탭에 날짜별로 저장됩니다.</p>
        </Card>

        <Card title="강한 섹터" subtitle="섹터 탭과 동일한 로테이션 점수 순위입니다." icon={<TrendingUp className="size-4 text-primary" />}>
          <div className="space-y-1.5">
            {summary.strongSectors.map((s) => (
              <div key={s.sectorCode} className="flex items-center justify-between gap-2 text-[12px]">
                <Link to="/sectors" className="font-medium hover:underline">{s.rank}. {s.sectorName}</Link>
                <span className="num flex gap-3">
                  <span className="font-semibold">{formatNumber(s.score, 1)}</span>
                  <span className={(s.rs20 ?? 0) >= 0 ? "text-up" : "text-down"}>{s.rs20 === null ? "-" : formatPercent(s.rs20, 2)}</span>
                  <span className="text-muted-foreground">{s.prevRank > s.rank ? `▲${s.prevRank - s.rank}` : s.prevRank < s.rank ? `▼${s.rank - s.prevRank}` : "-"}</span>
                </span>
              </div>
            ))}
            {summary.strongSectors.length === 0 ? <p className="text-[11px] text-muted-foreground">섹터 순위 데이터가 없습니다.</p> : null}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-4">
        {summary.warningBuckets.map((bucket) => {
          const title = bucket.code === "LOW_LIQUIDITY" ? "실격 종목" : WARNING_LABELS[bucket.code]!;
          const subtitle = bucket.code === "HEAD_FAKE"
            ? "가격 돌파는 보이지만 거래량·구름대·선행스팬이 뒷받침하지 않아 되돌림 가능성이 큰 상태입니다."
            : bucket.code === "PRICE_INSIDE_CLOUD"
              ? "종가가 일목균형표 구름 사이에 있어 추세 방향이 불분명합니다."
              : bucket.code === "EXIT_TRIGGER"
                ? "추세 전환·하락 신호가 감지되어 청산 또는 손절을 검토해야 하는 상태입니다."
                : "Universe Filter 조건을 충족하지 못한 종목입니다.";
          return (
            <Card key={bucket.code} title={title} subtitle={subtitle} icon={<ShieldAlert className="size-4 text-warn" />}>
              <p className="num mb-2 text-2xl font-bold">{bucket.count}</p>
              <div className="flex flex-wrap gap-1">
                {bucket.rows.map((row) => (
                  <Link key={row.instrument.symbol} to="/instrument/$symbol" params={{ symbol: row.instrument.symbol }}>
                    <Badge variant="outline" className="text-[10px]">{row.instrument.name}</Badge>
                  </Link>
                ))}
                {bucket.count === 0 ? <span className="text-[11px] text-muted-foreground">해당 종목 없음</span> : null}
              </div>
            </Card>
          );
        })}
      </div>

      {summary.failReasons.length > 0 ? (
        <section className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
          <h2 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">실격 사유 분포 (총 {formatCount(counts.disqualified)}종목 실격)</h2>
          <table className="w-full text-[12px]"><tbody>
            {summary.failReasons.map(([reason, count]) => (
              <tr key={reason} className="border-b border-border last:border-0"><td className="px-3 py-2">{reason}</td><td className="num px-3 py-2 text-right font-semibold text-warn">{formatCount(count)}건</td></tr>
            ))}
          </tbody></table>
          <p className="px-3 py-2 text-[11px] text-muted-foreground">사유별 기준값은 <Link to="/scoring" className="text-primary hover:underline">점수 산식</Link> 탭에서 조정할 수 있습니다.</p>
        </section>
      ) : null}

      <section className="mt-6">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">V6 Onset 상위 10</h2>
          <Badge variant="outline" className="border-primary/30 bg-primary/5 text-[10px] text-primary">60점 진입후보 / 70점 우선진입후보</Badge>
          <span className="text-[11px] text-muted-foreground">오늘 최초 상향 돌파한 Universe 통과 종목만 종합점수 순으로 표시합니다.</span>
        </div>
        {summary.onsetTop.length ? <ScreenerTable rows={summary.onsetTop} /> : <div className="rounded-lg border border-border bg-card p-4 text-[12px] text-muted-foreground">오늘 60점 또는 70점을 새로 상향 돌파한 종목이 없습니다.</div>}
      </section>

      <section className="mt-6">
        <div className="mb-2 flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-warn">모멘텀 위험</h2><span className="text-[11px] text-muted-foreground">직전 60점+ 모멘텀 구간에서 80점 이상을 기록한 뒤 현재 60점 미만으로 내려온 종목입니다.</span></div>
        {summary.momentumRiskRows.length ? <ScreenerTable rows={summary.momentumRiskRows} /> : <div className="rounded-lg border border-border bg-card p-4 text-[12px] text-muted-foreground">현재 모멘텀 위험 조건에 해당하는 종목이 없습니다.</div>}
      </section>

      <section className="mt-6">
        <div className="mb-2 flex items-center gap-2"><h2 className="text-sm font-semibold">상위 후보 (Universe 통과 · 종합점수 순)</h2><GradeBadge grade="A" /><span className="text-[11px] text-muted-foreground">주식 기술점수는 기본 9.5점 만점이며, 정규화 점수로 순위와 등급을 산정합니다.</span></div>
        <ScreenerTable rows={summary.top} />
      </section>
    </>
  );
}
