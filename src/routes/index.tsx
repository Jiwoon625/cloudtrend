import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, ArrowDown, ArrowUp, ShieldAlert, TrendingUp, Upload } from "lucide-react";
import { useSuspenseQuery } from "@tanstack/react-query";

import { AppShell } from "@/components/AppShell";
import { GradeBadge, ScreenerTable } from "@/components/ScreenerTable";
import { UniverseUpload } from "@/components/UniverseUpload";
import { Badge } from "@/components/ui/badge";
import { analysisQueryOptions, ipQueryOptions } from "@/lib/analysisQuery";
import { WARNING_LABELS } from "@/lib/engine/scoring";
import { formatCount, formatNumber, formatPercent, formatWon } from "@/lib/format";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "대시보드 | TrendScore KR 추세추종 스크리너" },
      {
        name: "description",
        content:
          "한국 주식·국내 상장 ETF의 시장 게이트, 섹터 상대강도, 기술·우선·펀더멘털 점수를 한 화면에서 확인하는 규칙 기반 스크리닝 대시보드입니다.",
      },
      { property: "og:title", content: "대시보드 | TrendScore KR" },
      {
        property: "og:description",
        content: "시장 상태, 스크리닝 요약, 상위 후보와 경고 신호를 계산 근거와 함께 제공합니다.",
      },
    ],
  }),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(analysisQueryOptions),
      context.queryClient.ensureQueryData(ipQueryOptions),
    ]),
  component: Dashboard,
});

function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        {icon}
        {title}
      </h2>
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
  const { data } = useSuspenseQuery(analysisQueryOptions);
  const { data: ip } = useSuspenseQuery(ipQueryOptions);
  const analysis = data.analysis;

  const { marketGate: gate, rows, sectors } = analysis;

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

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">대시보드</h1>
          <p className="text-[12px] text-muted-foreground">
            기준일 {analysis.asOfDate} · 전략 v{analysis.strategyVersion} · 데이터 {analysis.dataVersion}
          </p>
        </div>
        <p className="text-[11px] text-muted-foreground">
          서버 출구 IP {ip ?? "알 수 없음"} · 계산 시각{" "}
          {analysis.calculatedAt.slice(0, 16).replace("T", " ")} (미래 데이터 미사용)
        </p>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="코스피200 종목 CSV 업로드" icon={<Upload className="size-4 text-primary" />}>
          <UniverseUpload />
        </Card>
        <Card title="ETF 스크리닝 종목코드" icon={<ListPlus className="size-4 text-primary" />}>
          <EtfUniverseInput />
        </Card>
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
          <KeyValue label="신규 A등급 진입" value="미집계" hint="전일 스냅샷 필요" />
          <KeyValue label="A→B 하락" value="미집계" hint="전일 스냅샷 필요" />
          <KeyValue label="데이터 미완전 종목" value={formatCount(incomplete.length)} />
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
        {warningBuckets.map((b) => (
          <Card key={b.code} title={b.code === "LOW_LIQUIDITY" ? "실격 종목" : WARNING_LABELS[b.code]!} icon={<ShieldAlert className="size-4 text-warn" />}>
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
        ))}
      </div>

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
    </AppShell>
  );
}
