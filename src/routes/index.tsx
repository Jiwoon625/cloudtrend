import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, ArrowDown, ArrowUp, Hash, ListPlus, Loader2, Play, RefreshCw, ShieldAlert, TrendingUp } from "lucide-react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { GradeBadge, ScreenerTable } from "@/components/ScreenerTable";
import { EtfUniverseInput } from "@/components/EtfUniverseInput";
import { StockUniverseInput } from "@/components/StockUniverseInput";
import { CollectionProgress } from "@/components/CollectionProgress";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { analysisQueryOptions, ipQueryOptions } from "@/lib/analysisQuery";
import { getMarketAnalysis } from "@/lib/market.functions";

const SCREENING_STARTED_KEY = "trendscore:screening-started";
import { WARNING_LABELS } from "@/lib/engine/scoring";
import { formatCount, formatKstDateTime, formatNumber, formatPercent, formatWon } from "@/lib/format";
import { buildSnapshot, diffSnapshots, saveSnapshot, type GradeDiff } from "@/lib/screeningHistory";

export const Route = createFileRoute("/")({
  // 외부 시세 API 실패 시 SSR 500(빈 화면) 대신 클라이언트 에러 화면을 보여준다.
  ssr: false,
  head: () => ({
    meta: [
      { title: "대시보드 | TrendScore KR 추세추종 스크리너" },
      {
        name: "description",
        content:
          "한국 주식·국내 상장 ETF의 시장 게이트, 섹터 상대강도, 기술·우선순위 점수를 한 화면에서 확인하는 규칙 기반 스크리닝 대시보드입니다.",
      },
      { property: "og:title", content: "대시보드 | TrendScore KR" },
      {
        property: "og:description",
        content: "시장 상태, 스크리닝 요약, 상위 후보와 경고 신호를 계산 근거와 함께 제공합니다.",
      },
    ],
  }),
  // 스크리닝(데이터 수집)은 사용자가 버튼을 눌렀을 때만 시작한다.
  loader: ({ context }) => context.queryClient.ensureQueryData(ipQueryOptions),
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
        {value}
        {hint ? <span className="ml-1 text-[10px] text-muted-foreground">{hint}</span> : null}
      </span>
    </div>
  );
}

function Dashboard() {
  const { data: ip } = useSuspenseQuery(ipQueryOptions);
  const queryClient = useQueryClient();
  const [started, setStarted] = useState(
    () => typeof window !== "undefined" && window.sessionStorage.getItem(SCREENING_STARTED_KEY) === "1",
  );
  const analysisQuery = useQuery({ ...analysisQueryOptions, enabled: started });

  const startScreening = () => {
    window.sessionStorage.setItem(SCREENING_STARTED_KEY, "1");
    setStarted(true);
  };

  /** 종목을 바꿔 다시 스크리닝: 캐시된 분석 결과를 제거해 로딩·진행률 화면으로 전환한다. */
  const rescreen = () => {
    queryClient.removeQueries({ queryKey: analysisQueryOptions.queryKey });
    setStarted(false);
    // removeQueries 반영 후 재시작해야 isPending 상태로 진입한다.
    setTimeout(() => {
      window.sessionStorage.setItem(SCREENING_STARTED_KEY, "1");
      setStarted(true);
    }, 0);
  };

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">대시보드</h1>
          <p className="text-[12px] text-muted-foreground">
            스크리닝은 버튼을 눌렀을 때만 데이터 수집·계산을 시작합니다.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {started && !analysisQuery.isPending ? (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={rescreen}>
              <RefreshCw className="size-3.5" />
              다시 스크리닝
            </Button>
          ) : null}
          <p className="text-[11px] text-muted-foreground">서버 출구 IP {ip ?? "알 수 없음"}</p>
        </div>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="주식 스크리닝 종목코드 (코스피/코스닥)" icon={<Hash className="size-4 text-primary" />}>
          <StockUniverseInput />
        </Card>
        <Card title="ETF 스크리닝 종목코드" icon={<ListPlus className="size-4 text-primary" />}>
          <EtfUniverseInput />
        </Card>
      </div>

      {!started ? (
        <section className="rounded-lg border border-dashed border-primary/50 bg-card p-8 text-center">
          <Play className="mx-auto mb-3 size-8 text-primary" />
          <h2 className="mb-1 text-base font-semibold">스크리닝 시작</h2>
          <p className="mx-auto mb-4 max-w-md text-[12px] leading-relaxed text-muted-foreground">
            버튼을 누르면 토스증권 API에서 종목 시세를 수집하고 Universe Filter → Market Gate →
            Scoring을 계산합니다. 수집에는 수 분이 걸릴 수 있습니다.
          </p>
          <Button onClick={startScreening} size="lg" className="gap-2">
            <Play className="size-4" />
            스크리닝 시작
          </Button>
        </section>
      ) : analysisQuery.isPending ? (
        <section className="rounded-lg border border-border bg-card p-8">
          <div className="mb-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            시세 데이터를 수집·분석하는 중입니다…
          </div>
          <CollectionProgress />
        </section>
      ) : analysisQuery.isError ? (
        <DataError error={analysisQuery.error} reset={() => analysisQuery.refetch()} />
      ) : (
        <DashboardContent analysis={analysisQuery.data.analysis} />
      )}
    </AppShell>
  );
}

type AnalysisResult = Awaited<ReturnType<typeof getMarketAnalysis>>["analysis"];

function DashboardContent({ analysis }: { analysis: AnalysisResult }) {
  const { marketGate: gate, rows, sectors } = analysis;

  // 그날의 마지막 스크리닝 결과를 저장하고, 이전 날짜 스냅샷과 등급 변화를 비교한다.
  const snapshot = useMemo(() => buildSnapshot(analysis), [analysis]);
  const [diff, setDiff] = useState<GradeDiff | null>(null);
  useEffect(() => {
    setDiff(diffSnapshots(snapshot));
    saveSnapshot(snapshot);
  }, [snapshot]);

  const passed = rows.filter((r) => r.hardFilterPassed);
  const gradeA = passed.filter((r) => r.grade === "A");
  const gradeB = passed.filter((r) => r.grade === "B");
  const incomplete = rows.filter((r) => r.dataCompletenessRatio < 0.7);
  const top = [...passed].sort((a, b) => b.totalScoreNormalized - a.totalScoreNormalized).slice(0, 10);

  const gateColor =
    gate.status === "RISK_ON" ? "text-up" : gate.status === "NEUTRAL" ? "text-warn" : "text-down";
  const gateLabel =
    gate.status === "RISK_ON" ? "Risk-On" : gate.status === "NEUTRAL" ? "Neutral" : "Risk-Off";

  const warningBuckets = [
    { code: "HEAD_FAKE", rows: rows.filter((r) => r.warnings.includes("HEAD_FAKE")) },
    { code: "PRICE_INSIDE_CLOUD", rows: rows.filter((r) => r.warnings.includes("PRICE_INSIDE_CLOUD")) },
    { code: "EXIT_TRIGGER", rows: rows.filter((r) => r.warnings.includes("EXIT_TRIGGER")) },
    { code: "LOW_LIQUIDITY", rows: rows.filter((r) => !r.hardFilterPassed) },
  ];

  // 실격 사유별 건수 (한 종목이 여러 사유에 걸릴 수 있음)
  const failReasons: Array<[string, number]> = (() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      if (r.hardFilterPassed) continue;
      for (const f of r.failedRules) map.set(f, (map.get(f) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  })();


  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">
          기준일 {analysis.asOfDate} · 전략 v{analysis.strategyVersion} · 데이터 {analysis.dataVersion}
        </p>
        <p className="text-[11px] text-muted-foreground">
          계산 시각 {formatKstDateTime(analysis.calculatedAt)} (KST·미래 데이터 미사용)
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="시장 상태" icon={<Activity className="size-4 text-primary" />}>
          <div className={`mb-2 flex items-center gap-2 text-lg font-bold ${gateColor}`}>
            {gate.status === "RISK_OFF" ? (
              <ArrowDown className="size-5" />
            ) : (
              <ArrowUp className="size-5" />
            )}
            {gateLabel}
            <span className="num text-xs font-normal text-muted-foreground">
              게이트 {gate.metCount}/4 충족
            </span>
          </div>
          {gate.incomplete ? (
            <p className="mb-2 text-[11px] text-warn">판정 불완전 (일부 시장 데이터 없음)</p>
          ) : null}
          <KeyValue
            label="KOSPI 종가 / MA60"
            value={`${formatNumber(analysis.kospi.close, 2)} / ${formatNumber(analysis.kospi.ma60, 2)}`}
          />
          <KeyValue
            label="KOSPI 구름 상단 위"
            value={gate.benchmarkAboveCloud === null ? "데이터 없음" : gate.benchmarkAboveCloud ? "충족" : "미충족"}
          />
          <KeyValue label="KOSDAQ 종가" value={formatNumber(analysis.kosdaq.close, 2)} />
          <KeyValue label="VKOSPI" value={formatNumber(analysis.vkospi, 2)} hint="< 30" />
          <KeyValue label="외국인 최근 5일 누적" value={formatWon(analysis.marketForeignNet5d)} />
          {gate.status === "NEUTRAL" ? (
            <p className="mt-2 text-[11px] text-warn">
              Neutral: 신규 진입 후보의 권장 계획 리스크를 50%로 축소 표시합니다.
            </p>
          ) : null}
          {gate.status === "RISK_OFF" ? (
            <p className="mt-2 text-[11px] text-down">
              Risk-Off: 점수가 높아도 “관망” 또는 “리테스트 대기”로 표시합니다. 최종점수는 임의로
              차감하지 않습니다.
            </p>
          ) : null}
        </Card>

        <Card title="오늘의 스크리닝 요약" icon={<TrendingUp className="size-4 text-primary" />}>
          <KeyValue label="전체 분석 종목 수" value={formatCount(rows.length)} />
          <KeyValue label="Universe Filter 통과" value={formatCount(passed.length)} />
          <KeyValue label="A등급" value={formatCount(gradeA.length)} />
          <KeyValue label="B등급" value={formatCount(gradeB.length)} />
          <KeyValue
            label="신규 A등급 진입"
            value={diff?.previous ? formatCount(diff.newGradeA.length) : "미집계"}
            hint={diff?.previous ? `${diff.previous.date} 대비` : "이전 날짜 스냅샷 없음"}
          />
          <KeyValue
            label="A→B 하락"
            value={diff?.previous ? formatCount(diff.droppedAtoB.length) : "미집계"}
            hint={diff?.previous ? `${diff.previous.date} 대비` : "이전 날짜 스냅샷 없음"}
          />
          <KeyValue label="데이터 미완전 종목" value={formatCount(incomplete.length)} />
          <p className="mt-2 text-[11px] text-muted-foreground">
            결과는 <Link to="/history" className="text-primary hover:underline">스크리닝 이력</Link> 탭에
            날짜별(그날의 마지막 결과)로 저장됩니다.
          </p>
        </Card>

        <Card title="강한 섹터" icon={<TrendingUp className="size-4 text-primary" />}>
          <div className="space-y-1.5">
            {sectors.slice(0, 5).map((s) => (
              <div key={s.sectorCode} className="flex items-center justify-between gap-2 text-[12px]">
                <Link to="/sectors" className="font-medium hover:underline">
                  {s.rank}. {s.sectorName}
                  {s.isSynthetic ? (
                    <span className="ml-1 text-[10px] text-warn">합성 섹터지수</span>
                  ) : null}
                </Link>
                <span className="num flex gap-3">
                  <span className={s.rs20 >= 0 ? "text-up" : "text-down"}>
                    {formatPercent(s.rs20, 2)}
                  </span>
                  <span className="text-muted-foreground">
                    {s.prevRank > s.rank ? `▲${s.prevRank - s.rank}` : s.prevRank < s.rank ? `▼${s.rank - s.prevRank}` : "-"}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-4">
        {warningBuckets.map((b) => {
          const title = b.code === "LOW_LIQUIDITY" ? "실격 종목" : WARNING_LABELS[b.code]!;
          const subtitle =
            b.code === "HEAD_FAKE"
              ? "가격 돌파는 보이지만 거래량·구름대·선행스팬이 뒷받침하지 않아 되돌림 가능성이 큰 상태입니다. 진입 전 추가 확인이 필요합니다."
              : b.code === "PRICE_INSIDE_CLOUD"
                ? "종가가 일목균형표 구름(선행스팬 1, 2) 사이에 있어 추세 방향이 불분명합니다. 구름 상단/하단 이탈 후 방향을 판단합니다."
                : b.code === "EXIT_TRIGGER"
                  ? "추세 전환·하락 신호가 감지되어 보유 포지션의 청산 또는 손절을 검토해야 하는 상태입니다."
                  : "거래대금·유동성·데이터 완전성 조건을 충족하지 못해 Universe Filter에서 제외된 종목입니다.";
          return (
            <Card key={b.code} title={title} subtitle={subtitle} icon={<ShieldAlert className="size-4 text-warn" />}>
              <p className="num mb-2 text-2xl font-bold">{b.rows.length}</p>
              <div className="flex flex-wrap gap-1">
                {b.rows.slice(0, 4).map((r) => (
                  <Link
                    key={r.instrument.symbol}
                    to="/instrument/$symbol"
                    params={{ symbol: r.instrument.symbol }}
                  >
                    <Badge variant="outline" className="text-[10px]">
                      {r.instrument.name}
                    </Badge>
                  </Link>
                ))}
                {b.rows.length === 0 ? (
                  <span className="text-[11px] text-muted-foreground">해당 종목 없음</span>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>

      {failReasons.length > 0 ? (
        <section className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
          <h2 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
            실격 사유 분포 (총 {formatCount(rows.length - passed.length)}종목 실격)
          </h2>
          <table className="w-full text-[12px]">
            <tbody>
              {failReasons.map(([reason, count]) => (
                <tr key={reason} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">{reason}</td>
                  <td className="num px-3 py-2 text-right font-semibold text-warn">
                    {formatCount(count)}건
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            사유별 기준값은{" "}
            <Link to="/scoring" className="text-primary hover:underline">
              점수 산식
            </Link>{" "}
            탭의 Universe Filter에서 직접 조정할 수 있습니다.
          </p>
        </section>
      ) : null}



      <section className="mt-6">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold">상위 후보 (Universe 통과 · 종합점수 순)</h2>
          <GradeBadge grade="A" />
          <span className="text-[11px] text-muted-foreground">
            총점과 기술등급은 별개 지표입니다.
          </span>
        </div>
        <ScreenerTable rows={top} />
      </section>
    </>
  );
}
