import { KrPreliminaryNotice } from "@/components/KrPreliminaryNotice";
import { screeningSession } from "@/lib/screeningSession";
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
import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";

import {
  kospiMarketGateDisplay,
  kospiMarketGateLabel,
  kospiVolatilitySourceLabel,
} from "@/components/kospiEntryPresentation";
import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { PdfExportButton } from "@/components/PdfExportButton";
import { Button } from "@/components/ui/button";
import {
  DASHBOARD_OPERATIONS_QUERY,
  DashboardSignalCounts,
  DashboardSignalLists,
  DashboardStrategyRules,
  UsDashboardPortfolio,
  useDashboardOperations,
} from "@/components/DashboardOperations";
import { dashboardQueryOptions } from "@/lib/analysisQuery";
import {
  dashboardCacheEmptyPresentation,
  dashboardCacheReadQueryOptions,
  readDashboardSourceAvailability,
} from "@/lib/dashboardCachePresentation";
import {
  formatCount,
  formatKstDateTime,
  formatNumber,
  formatPercent,
  formatWon,
} from "@/lib/format";
import { UniversePendingSummary } from "@/components/UniversePendingSummary";
import { type DashboardSummary } from "@/lib/screeningCache";
import { isScreeningStarted } from "@/lib/screeningRun";
import { rebuildScreeningCachesServerFirst } from "@/lib/webScreeningClient";

const DomesticAssessmentPanel = lazy(() =>
  import("@/components/DomesticAssessmentPanel").then((module) => ({
    default: module.DomesticAssessmentPanel,
  })),
);

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "대시보드 | CloudTrend V8 Final" },
      {
        name: "description",
        content:
          "CloudTrend V8 Final 10점 기술점수의 KOSPI 하루 확인·RSAccel·하락장 진입 차단, KOSDAQ 8.0 원신호, KOSPI U9.5 / H60 / K4, KOSDAQ U9.0 / D3.0 Exit, 섹터 로테이션과 시장 상태를 한 화면에서 확인합니다.",
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

function GateConditionValue({ comparison, met }: { comparison: string; met: boolean | null }) {
  const className =
    met === true ? "text-up" : met === false ? "text-down" : "text-muted-foreground";
  const label = met === true ? "충족" : met === false ? "미충족" : "미평가";

  return (
    <span className={className}>
      {comparison}
      <span className="ml-1 text-[10px] font-normal">{label}</span>
    </span>
  );
}

function Dashboard() {
  const queryClient = useQueryClient();
  const [requested] = useState(() => isScreeningStarted());
  const [rescreening, setRescreening] = useState(false);
  // Availability is metadata-only and only needed after a successful empty cache read.
  const cachedSummary = queryClient.getQueryState<DashboardSummary | null>(
    dashboardQueryOptions.queryKey,
  );
  const sourceAvailability = useQuery({
    queryKey: ["dashboard-source-availability"],
    queryFn: readDashboardSourceAvailability,
    enabled: cachedSummary?.status === "success" && cachedSummary.data === null,
    staleTime: 60_000,
    retry: false,
  });
  // A fresh device may read a published result; only explicit start may calculate.
  const readOnlyOptions = dashboardCacheReadQueryOptions(
    dashboardQueryOptions.queryKey,
    sourceAvailability.isError,
  );
  // Revisiting a tab never authorizes a new full screening, even when the saved
  // legacy started flag is set. Only the explicit rescreen button runs the engine.
  const summaryQuery = useQuery<DashboardSummary | null>(readOnlyOptions);
  const cacheMissing = summaryQuery.isSuccess && summaryQuery.data === null;
  const emptyPresentation = dashboardCacheEmptyPresentation(sourceAvailability.data);
  const started = requested || Boolean(summaryQuery.data);
  const operations = useDashboardOperations(started, summaryQuery.data?.resultDigest);
  const rescreen = async () => {
    setRescreening(true);
    try {
      const result = await rebuildScreeningCachesServerFirst();
      await queryClient.invalidateQueries({ queryKey: ["market-analysis"] });
      await queryClient.invalidateQueries({ queryKey: ["portfolio-ledgers"] });
      await queryClient.invalidateQueries({ queryKey: DASHBOARD_OPERATIONS_QUERY });
      queryClient.removeQueries({ queryKey: ["instrument"] });
      if (result.refresh?.portfolioRefresh.status === "FAILED")
        toast.warning(
          "스크리닝은 완료됐지만 포트폴리오 갱신에 실패했습니다. 포트폴리오에서 다시 확인하세요.",
        );
      else
        toast.success(
          result.refresh?.reused
            ? "입력이 같아 저장된 스크리닝·포트폴리오를 재사용했습니다."
            : "스크리닝과 포트폴리오를 함께 갱신했습니다.",
        );
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

      {summaryQuery.isPending ? (
        <section className="rounded-lg border border-border bg-card p-8">
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            V8 Final 대시보드를 불러오는 중입니다…
          </div>
        </section>
      ) : summaryQuery.isError || (cacheMissing && sourceAvailability.isError) ? (
        <DataError
          error={summaryQuery.error ?? sourceAvailability.error}
          reset={() => Promise.all([summaryQuery.refetch(), sourceAvailability.refetch()])}
          embedded
        />
      ) : !summaryQuery.data ? (
        <section
          className="rounded-lg border border-dashed border-primary/50 bg-card p-8 text-center"
          role="status"
        >
          <SlidersHorizontal className="mx-auto mb-3 size-8 text-primary" />
          <h2 className="mb-1 text-base font-semibold">{emptyPresentation.title}</h2>
          <p className="mx-auto mb-4 max-w-md text-[12px] leading-relaxed text-muted-foreground">
            {emptyPresentation.detail}
            {!requested ? " 이 화면에서는 새 계산을 시작하지 않습니다." : null}
          </p>
          <Button asChild size="lg" className="gap-2">
            <Link to="/scoring">
              <SlidersHorizontal className="size-4" />
              데이터 관리 탭으로 이동
            </Link>
          </Button>
        </section>
      ) : (
        <DashboardContent summary={summaryQuery.data} operations={operations} />
      )}
    </AppShell>
  );
}

function DashboardContent({
  summary,
  operations,
}: {
  summary: DashboardSummary;
  operations: ReturnType<typeof useDashboardOperations>;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const gate = kospiMarketGateDisplay(summary.kospiMarketGate, summary.asOfDate);
  const gateColor =
    gate.status === "RISK_ON" ? "text-up" : gate.status === "RISK_OFF" ? "text-down" : "text-warn";
  const gateLabel = kospiMarketGateLabel(gate.status);
  const portfolio = operations.data?.newActualPools?.KRW;
  const portfolioFallback = operations.isPending
    ? "불러오는 중…"
    : operations.isError
      ? "조회 실패"
      : "미확인";

  return (
    <>
      <KrPreliminaryNotice publication={summary.krPublication} />
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

      <p className="mb-2 text-xs text-muted-foreground">
        오전·저녁 하루 두 번, 자료수집 완료 후 게시된 최신 결과입니다. 시각만으로 진입 확정 여부를
        판단하지 않습니다.
      </p>
      <details className="rounded border p-2">
        <summary className="cursor-pointer text-sm">시장별 집계·자료 확인사항</summary>
        <DashboardSignalCounts query={operations} counts={summary.counts} />
      </details>
      <div className="my-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {(["KR", "US"] as const).map((market) => {
          const publication = operations.data?.publications?.[market];
          return (
            <span key={market}>
              {market === "KR" ? "한국·ETF" : "미국"} · {screeningSession(publication?.collectedAt)}
              {publication?.collectedAt
                ? ` ${formatKstDateTime(publication.collectedAt)}`
                : publication?.registeredAt
                  ? ` · 자료 등록 ${formatKstDateTime(publication.registeredAt)}`
                  : ""}{" "}
              · 계산{" "}
              {publication?.calculatedAt ? formatKstDateTime(publication.calculatedAt) : "미확인"}{" "}
              KST
            </span>
          );
        })}
      </div>
      <DashboardSignalLists query={operations} />
      <details
        className="my-3 rounded border p-3"
        onToggle={(event) => setReviewOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer text-sm">원신호·자료 확인 대기 후보</summary>
        {operations.data ? (
          reviewOpen ? (
            <Suspense
              fallback={
                <p className="my-4 text-xs text-muted-foreground" role="status">
                  후보 검토 자료 불러오는 중…
                </p>
              }
            >
              <DomesticAssessmentPanel markets={operations.data.markets} review />
            </Suspense>
          ) : null
        ) : (
          <p className="my-4 text-xs text-muted-foreground" role="status">
            {operations.isError
              ? "후보 검토 자료 조회 실패 · 기존 판단 자료를 다시 확인해 주세요."
              : "후보 검토 자료 불러오는 중…"}
          </p>
        )}
      </details>
      <div className="space-y-4">
        <div className="space-y-4">
          <Card
            title="KOSPI / KOSDAQ 포트폴리오"
            icon={<ShieldCheck className="size-4 text-primary" />}
          >
            <p className="mb-2 text-[10px] text-muted-foreground">
              배정·입출금 기준 · KRW (ETF와 공유)
            </p>
            <KeyValue
              label="순입금"
              value={
                portfolio
                  ? portfolio.netContributions === null
                    ? "자금 확인 대기"
                    : formatWon(Number(portfolio.netContributions))
                  : portfolioFallback
              }
            />
            <KeyValue
              label="현금"
              value={
                portfolio
                  ? portfolio.cash === null
                    ? "자금 확인 대기"
                    : formatWon(Number(portfolio.cash))
                  : portfolioFallback
              }
            />
            <KeyValue
              label="실제 보유 종목수"
              value={
                portfolio
                  ? `국내주식 ${portfolio.assetPositions.KR}종목 · ETF ${portfolio.assetPositions.ETF}종목`
                  : portfolioFallback
              }
            />
            {portfolio?.fundingStatus === "INCOMPLETE" ? (
              <p className="mt-2 text-[10px] text-warn">입출금·체결의 자금 연결을 확인해 주세요.</p>
            ) : null}
            <Link
              to="/portfolio"
              className="mt-3 inline-flex text-[11px] font-medium text-primary hover:underline"
            >
              포트폴리오 상세 보기 →
            </Link>
          </Card>
          <UsDashboardPortfolio query={operations} />
        </div>

        <Card
          title="KOSPI 시장 상태 · 진입 조건"
          icon={<Activity className="size-4 text-primary" />}
        >
          <div className={`mb-2 flex items-center gap-2 text-lg font-bold ${gateColor}`}>
            {gate.status === "RISK_OFF" ? (
              <ArrowDown className="size-5" />
            ) : gate.status === "UNKNOWN" ? (
              <ShieldCheck className="size-5" />
            ) : (
              <ArrowUp className="size-5" />
            )}
            {gateLabel}
            <span className="num text-xs font-normal text-muted-foreground">{gate.metCount}/4</span>
          </div>
          <p className="mb-2 text-[10px] text-muted-foreground">
            기준일 {gate.date} · Risk-On 4/4 · Neutral 2–3/4 · Risk-Off 0–1/4 · 결측/오래된 자료
            Unknown
          </p>
          {gate.incomplete ? (
            <p className="mb-2 text-[11px] text-warn">
              시장국면 미확인 · KOSPI 진입 제외 · {gate.issues.join(" · ")}
            </p>
          ) : null}
          <KeyValue
            label="KOSPI / MA60"
            value={
              <GateConditionValue
                comparison={
                  gate.benchmarkAboveMa60 === null
                    ? "데이터 없음"
                    : `${formatNumber(summary.kospi.close, 2)} ${gate.benchmarkAboveMa60 ? ">" : "≤"} ${formatNumber(summary.kospi.ma60, 2)}`
                }
                met={gate.benchmarkAboveMa60}
              />
            }
          />
          <KeyValue
            label="KOSPI / Cloud Top"
            value={
              <GateConditionValue
                comparison={
                  gate.benchmarkAboveCloud === null
                    ? "데이터 없음"
                    : `${formatNumber(summary.kospi.close, 2)} ${gate.benchmarkAboveCloud ? ">" : "≤"} ${formatNumber(summary.kospi.ichimoku.cloudTop, 2)}`
                }
                met={gate.benchmarkAboveCloud}
              />
            }
          />
          <KeyValue
            label={`변동성 (${kospiVolatilitySourceLabel(gate.volatilitySource)})`}
            value={
              <GateConditionValue
                comparison={
                  gate.vkospiBelow30 === null
                    ? "데이터 없음"
                    : `${formatNumber(gate.vkospi, 2)} ${gate.vkospiBelow30 ? "<" : "≥"} 30`
                }
                met={gate.vkospiBelow30}
              />
            }
          />
          <KeyValue
            label="외국인 최근 5일 순매수(도)"
            value={
              <GateConditionValue
                comparison={
                  gate.marketForeignNet5d === null
                    ? "데이터 없음"
                    : `${formatWon(gate.marketForeignNet5d)} ${
                        gate.marketForeignNet5d > 0 ? ">" : gate.marketForeignNet5d < 0 ? "<" : "="
                      } 0`
                }
                met={gate.foreignNet5dPositive}
              />
            }
          />
          <KeyValue
            label="KOSDAQ"
            value={formatNumber(summary.kosdaq.close, 2)}
            hint="참고 · Gate 기준 없음"
          />
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
                      <Link
                        to="/sectors"
                        search={{ sector: sector.sectorCode }}
                        className="hover:underline"
                      >
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

      <UniversePendingSummary reasons={summary.pendingReasons ?? []} />

      {summary.skippedReasons.length > 0 ? (
        <section className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
          <div className="border-b border-border bg-surface-strong px-3 py-2">
            <h2 className="text-sm font-semibold">주식 Universe 검사 생략 사유</h2>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              데이터가 없어 해당 필터를 적용하지 못한 주식입니다. 실격으로 처리되지는 않습니다.
            </p>
          </div>
          <table className="w-full text-[12px]">
            <tbody>
              {summary.skippedReasons.map(([reason, count]) => (
                <tr key={reason} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">{reason}</td>
                  <td className="num px-3 py-2 text-right font-semibold text-muted-foreground">
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
