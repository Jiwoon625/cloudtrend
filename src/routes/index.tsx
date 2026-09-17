import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Loader2,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { ScreenerTable } from "@/components/ScreenerTable";
import { PdfExportButton } from "@/components/PdfExportButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dashboardQueryOptions } from "@/lib/analysisQuery";
import {
  formatCount,
  formatKstDateTime,
  formatNumber,
  formatPercent,
  formatWon,
} from "@/lib/format";
import type { DashboardSummary } from "@/lib/screeningCache";
import { isScreeningStarted } from "@/lib/screeningRun";
import { rebuildScreeningCachesServerFirst } from "@/lib/webScreeningClient";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "대시보드 | CloudTrend V8 Final" },
      {
        name: "description",
        content:
          "CloudTrend V8 Final 10점 기술점수의 KOSDAQ80 Onset, KOSPI 8점 Onset과 RSAccel Relative Quality, KOSDAQ 9.0 상향·3.0 하향 Exit, 섹터 로테이션과 시장 상태를 한 화면에서 확인합니다.",
      },
      { property: "og:title", content: "대시보드 | CloudTrend V8 Final" },
      {
        property: "og:description",
        content: "V8 Final 운영신호와 KOSPI Relative Quality, 전체 섹터 Rotation 대시보드.",
      },
    ],
  }),
  errorComponent: ({ error, reset }) => <DataError error={error} reset={reset} />,
  component: Dashboard,
});

function Card({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
        {icon}
        {title}
      </h2>
      {subtitle ? (
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">{subtitle}</p>
      ) : null}
      {children}
    </section>
  );
}

function KeyValue({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-border py-1.5 last:border-0">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="num text-[13px] font-medium">
        {value}
        {hint ? <span className="ml-1 text-[10px] text-muted-foreground">{hint}</span> : null}
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
      await rebuildScreeningCachesServerFirst();
      await queryClient.invalidateQueries({ queryKey: ["market-analysis"] });
      queryClient.removeQueries({ queryKey: ["instrument"] });
      toast.success("V8 Final 스크리닝을 서버에서 다시 계산했습니다.");
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
          <h1 className="text-xl font-bold tracking-tight">대시보드 · V8 Final</h1>
          <p className="text-[12px] text-muted-foreground">
            KOSDAQ80 Onset, 확정 포트폴리오 운영 규칙, 점수 Exit와 섹터 Rotation을 확인합니다.
          </p>
        </div>
        <div className="flex items-center gap-2" data-no-print>
          {started && !summaryQuery.isPending ? (
            <>
              <PdfExportButton documentTitle="CloudTrend V8 Final 대시보드" />
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => void rescreen()}
                disabled={rescreening}
              >
                {rescreening ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
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
            데이터·산식 탭에서 시세 데이터를 입력한 뒤 스크리닝 시작을 누르면 V8 Final 캐시가
            생성됩니다.
          </p>
          <Button asChild size="lg" className="gap-2">
            <Link to="/scoring">
              <SlidersHorizontal className="size-4" />
              데이터·산식 탭으로 이동
            </Link>
          </Button>
        </section>
      ) : summaryQuery.isPending ? (
        <section className="rounded-lg border border-border bg-card p-8">
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            V8 Final 대시보드를 불러오는 중입니다…
          </div>
        </section>
      ) : summaryQuery.isError || !summaryQuery.data ? (
        <DataError
          error={summaryQuery.error ?? "대시보드 요약을 불러오지 못했습니다."}
          reset={() => summaryQuery.refetch()}
          embedded
        />
      ) : (
        <DashboardContent summary={summaryQuery.data} />
      )}
    </AppShell>
  );
}

function DashboardContent({ summary }: { summary: DashboardSummary }) {
  const gate = summary.marketGate;
  const { counts } = summary;
  const gateColor =
    gate.status === "RISK_ON" ? "text-up" : gate.status === "NEUTRAL" ? "text-warn" : "text-down";
  const gateLabel =
    gate.status === "RISK_ON" ? "Risk-On" : gate.status === "NEUTRAL" ? "Neutral" : "Risk-Off";

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">
          기준일 {summary.asOfDate} · 모델{" "}
          <strong className="text-foreground">{summary.strategyVersion}</strong> · 데이터{" "}
          {summary.dataVersion}
        </p>
        <p className="text-[11px] text-muted-foreground">
          계산 시각 {formatKstDateTime(summary.calculatedAt)} (KST·미래 데이터 미사용)
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <Card title="오늘의 V8 신호" icon={<TrendingUp className="size-4 text-primary" />}>
          <KeyValue label="KOSDAQ80 Onset" value={formatCount(counts.kosdaq80Onsets)} />
          <KeyValue
            label="KOSPI 8점 신규 진입"
            value={formatCount(counts.kospiEightPointEntries)}
          />
          <KeyValue
            label="KOSPI RS 확인"
            value={formatCount(counts.kospiRelativeQualityConfirmed)}
            hint="RSAccel > 0"
          />
          <KeyValue label="상승 Exit · 9.0점 상향 재돌파" value={formatCount(counts.upsideExits)} />
          <KeyValue label="하락 Exit · 3.0점 하향 이탈" value={formatCount(counts.downsideExits)} />
          <KeyValue label="점수 산정 불가" value={formatCount(counts.incomplete)} />
        </Card>

        <Card title="KOSDAQ 실전 포트폴리오" icon={<ShieldCheck className="size-4 text-primary" />}>
          <KeyValue label="포트폴리오 한도" value="P30 · 최대 30종목" />
          <KeyValue label="오늘 Onset / 최대 슬롯" value={`${counts.kosdaq80Onsets} / 30`} />
        </Card>

        <Card title="진입·Exit 규칙" icon={<TrendingUp className="size-4 text-primary" />}>
          <KeyValue label="KOSDAQ 진입" value="KOSDAQ80 Onset" />
          <KeyValue label="KOSPI 참고" value="8점 Onset + RSAccel" />
          <KeyValue label="상승 Exit" value="9.0 상향 재돌파" />
          <KeyValue label="하락 Exit" value="3.0 하향 이탈" />
          <KeyValue label="최대 보유" value="60거래일" />
          <KeyValue label="기술점수" value="Raw 0~10" />
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            KOSDAQ Exit는 8.0 Onset 당일의 9.0 초과 진입을 즉시 청산으로 보지 않고, 이후 재돌파·하향
            이탈을 신호로 봅니다. 60거래일 만기는 포지션 추적 기능 연결 전까지 화면 자동 신호로
            표시하지 않습니다. RSAccel은 KOSPI 전용 Relative Quality 축입니다.
          </p>
        </Card>

        <Card title="시장 상태 · 참고" icon={<Activity className="size-4 text-primary" />}>
          <div className={`mb-2 flex items-center gap-2 text-lg font-bold ${gateColor}`}>
            {gate.status === "RISK_OFF" ? (
              <ArrowDown className="size-5" />
            ) : (
              <ArrowUp className="size-5" />
            )}
            {gateLabel}
            <span className="num text-xs font-normal text-muted-foreground">{gate.metCount}/4</span>
          </div>
          {gate.incomplete ? (
            <p className="mb-2 text-[11px] text-warn">
              일부 시장 데이터가 없어 판정이 불완전합니다.
            </p>
          ) : null}
          <KeyValue
            label="KOSPI / MA60"
            value={`${formatNumber(summary.kospi.close, 2)} / ${formatNumber(summary.kospi.ma60, 2)}`}
          />
          <KeyValue label="KOSDAQ" value={formatNumber(summary.kosdaq.close, 2)} />
          <KeyValue label="변동성" value={formatNumber(summary.vkospi, 2)} />
          <KeyValue label="외국인 최근 5일" value={formatWon(summary.marketForeignNet5d)} />
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            Market Gate는 참고정보이며 KOSDAQ80 Onset 또는 Exit를 차단하지 않습니다.
          </p>
        </Card>
      </div>

      <section className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border bg-surface-strong px-3 py-2">
          <h2 className="text-sm font-semibold">Sector Rotation · 전체 섹터</h2>
          <p className="text-[11px] text-muted-foreground">
            Rotation Score는 기술점수와 분리되어 우선점수 0~1점으로 반영됩니다. 현재 계산된 모든
            섹터를 표시합니다.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[12px]">
            <thead>
              <tr className="border-b border-border text-[11px] text-muted-foreground">
                <th className="px-3 py-2 text-left">순위</th>
                <th className="px-3 py-2 text-left">섹터</th>
                <th className="px-3 py-2 text-right">Rotation</th>
                <th className="px-3 py-2 text-right">Price Leadership</th>
                <th className="px-3 py-2 text-right">Money Flow</th>
                <th className="px-3 py-2 text-right">RS20</th>
                <th className="px-3 py-2 text-right">순위 변화</th>
              </tr>
            </thead>
            <tbody>
              {summary.rotationSectors.map((sector) => {
                const move =
                  sector.prevRank > sector.rank
                    ? `▲${sector.prevRank - sector.rank}`
                    : sector.prevRank < sector.rank
                      ? `▼${sector.rank - sector.prevRank}`
                      : "-";
                return (
                  <tr key={sector.sectorCode} className="border-b border-border last:border-0">
                    <td className="num px-3 py-2">{sector.rank}</td>
                    <td className="px-3 py-2 font-medium">
                      <Link to="/sectors" className="hover:underline">
                        {sector.sectorName}
                      </Link>
                    </td>
                    <td className="num px-3 py-2 text-right font-semibold">
                      {formatNumber(sector.score, 1)}
                    </td>
                    <td className="num px-3 py-2 text-right">
                      {sector.priceLeadership === null
                        ? "-"
                        : formatNumber(sector.priceLeadership, 1)}
                    </td>
                    <td className="num px-3 py-2 text-right">
                      {sector.moneyFlow === null ? "-" : formatNumber(sector.moneyFlow, 1)}
                    </td>
                    <td
                      className={`num px-3 py-2 text-right ${(sector.rs20 ?? 0) >= 0 ? "text-up" : "text-down"}`}
                    >
                      {sector.rs20 === null ? "-" : formatPercent(sector.rs20, 2)}
                    </td>
                    <td className="num px-3 py-2 text-right text-muted-foreground">{move}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">오늘의 KOSDAQ80 Onset</h2>
          <Badge
            variant="outline"
            className="border-primary/30 bg-primary/5 text-[10px] text-primary"
          >
            전일 &lt;8.0 → 당일 ≥8.0
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            우선점수(Sector Rotation 포함)가 높은 순으로 최대 30개를 표시합니다.
          </span>
        </div>
        {summary.onsetRows.length ? (
          <ScreenerTable rows={summary.onsetRows} />
        ) : (
          <div className="rounded-lg border border-border bg-card p-4 text-[12px] text-muted-foreground">
            오늘 새로 발생한 KOSDAQ80 Onset이 없습니다.
          </div>
        )}
      </section>

      <section className="mt-6">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">KOSPI 8점 신규 진입 후보 · Relative Quality</h2>
          <Badge
            variant="outline"
            className="border-primary/30 bg-primary/5 text-[10px] text-primary"
          >
            전일 &lt;8.0 → 당일 ≥8.0
          </Badge>
          <Badge variant="outline" className="border-up/30 bg-up-soft text-[10px] text-up">
            RSAccel = RS20 − RS60
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            RSAccel &gt; 0은 ‘RS 확인’으로 표시합니다. 기술점수에는 합산하지 않으며 RSAccel이 높은
            후보부터 최대 30개를 표시합니다.
          </span>
        </div>
        {summary.kospiEntryRows.length ? (
          <ScreenerTable rows={summary.kospiEntryRows} />
        ) : (
          <div className="rounded-lg border border-border bg-card p-4 text-[12px] text-muted-foreground">
            오늘 새로 발생한 KOSPI 8점 신규 진입 후보가 없습니다.
          </div>
        )}
      </section>

      <section className="mt-6">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-warn">V8 Exit 조건</h2>
          <Badge variant="outline" className="border-warn/30 bg-warn-soft text-[10px] text-warn">
            9.0 상향 재돌파 또는 3.0 하향 이탈
          </Badge>
          <span className="text-[11px] text-muted-foreground">
            실제 매도 대상 여부는 보유 여부와 함께 확인해야 하며, 최대 보유 60거래일은 별도 포지션
            관리 기준입니다.
          </span>
        </div>
        {summary.exitRows.length ? (
          <ScreenerTable rows={summary.exitRows} />
        ) : (
          <div className="rounded-lg border border-border bg-card p-4 text-[12px] text-muted-foreground">
            현재 점수 Exit 조건에 해당하는 KOSDAQ 종목이 없습니다.
          </div>
        )}
      </section>

      {summary.failReasons.length > 0 ? (
        <section className="mt-6 overflow-hidden rounded-lg border border-border bg-card">
          <h2 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
            Universe 실격 사유 분포 · {formatCount(counts.disqualified)}종목
          </h2>
          <table className="w-full text-[12px]">
            <tbody>
              {summary.failReasons.map(([reason, count]) => (
                <tr key={reason} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">{reason}</td>
                  <td className="num px-3 py-2 text-right font-semibold text-warn">
                    {formatCount(count)}건
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}
