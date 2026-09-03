import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  FileCode2,
  Loader2,
  MinusCircle,
  Play,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { UsDataInput } from "@/components/us/UsDataInput";
import { UsFetchGuide } from "@/components/us/UsFetchGuide";
import { UsGradeBadge } from "@/components/us/UsScreenerTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatKstDateTime } from "@/lib/format";
import {
  isUsAnalysisFailure,
  isUsAnalysisPayload,
  usAnalysisQueryOptions,
} from "@/lib/usAnalysisQuery";
import { getUsDataText } from "@/lib/usDataStore";
import type { ScoreStatus, UsAnalysisResult } from "@/lib/engine/usPipeline";
import { UsDisclaimer } from "@/components/us/UsDisclaimer";

export const Route = createFileRoute("/us/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "US 시장 브리핑 | CloudTrend 미국 주식·ETF 스크리너" },
      {
        name: "description",
        content:
          "SPY·QQQ·IWM 추세와 breadth로 미국 시장 상태를 판정하고, 11개 GICS 섹터 게이트와 Technical·Priority 점수를 근거와 함께 제공하는 리서치 워크스페이스입니다.",
      },
      { property: "og:title", content: "US 시장 브리핑 | CloudTrend" },
      {
        property: "og:description",
        content: "미국 주식·ETF의 시장 게이트, 섹터 강도, 점수 coverage를 한 화면에서 확인합니다.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: UsHome,
});

function StatusIcon({ status }: { status: ScoreStatus }) {
  if (status === "PASS") return <CheckCircle2 className="size-3.5 text-up" />;
  if (status === "FAIL") return <AlertTriangle className="size-3.5 text-down" />;
  return <MinusCircle className="size-3.5 text-muted-foreground" />;
}

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

function UsHome() {
  const queryClient = useQueryClient();
  const [started, setStarted] = useState(false);
  const [hasData, setHasData] = useState(() => (getUsDataText() ?? "").trim().length > 0);
  const query = useQuery({ ...usAnalysisQueryOptions, enabled: started });

  const invalidate = () => {
    queryClient.removeQueries({ queryKey: usAnalysisQueryOptions.queryKey });
  };

  return (
    <AppShell loadAnalysis={false}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">US 시장 브리핑 · 데이터 입력</h1>
          <p className="text-[12px] text-muted-foreground">
            로컬(주피터)에서 토스증권 Open API로 수집한 미국 종목 일봉을 업로드하면 시장 → 섹터 →
            종목 순서로 분석합니다. 한국 시장 데이터와 별도로 저장됩니다.
          </p>
        </div>
        {started && !query.isPending ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              invalidate();
              setStarted(false);
              setTimeout(() => setStarted(true), 0);
            }}
          >
            <RefreshCw className="size-3.5" />
            다시 스크리닝
          </Button>
        ) : null}
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card
          title="1. 이용할 데이터 & 토스증권 API 조회 코드 (로컬 수집기)"
          subtitle="API 키·시크릿은 로컬 환경변수에만 두고, 검증·정규화된 CSV만 업로드합니다."
          icon={<FileCode2 className="size-4 text-primary" />}
        >
          <UsFetchGuide />
        </Card>
        <Card
          title="2. 받은 데이터 입력 (붙여넣기 또는 CSV/JSON 업로드)"
          subtitle="입력 데이터는 이 브라우저에만 저장되며 서버로 시세를 조회하지 않습니다."
          icon={<Database className="size-4 text-primary" />}
        >
          <UsDataInput
            onChanged={(ok) => {
              setHasData(ok);
              invalidate();
              setStarted(false);
            }}
          />
        </Card>
      </div>

      {!started ? (
        <section className="rounded-lg border border-dashed border-primary/50 bg-card p-8 text-center">
          <Play className="mx-auto mb-3 size-8 text-primary" />
          <h2 className="mb-1 text-base font-semibold">3. US 스크리닝 시작</h2>
          <p className="mx-auto mb-4 max-w-md text-[12px] leading-relaxed text-muted-foreground">
            Market Policy v1 → 섹터 게이트 → Technical 7 / Priority 10 / ETF Health를 계산하고, US
            스크리너·종목 상세 탭이 이 데이터로 동작합니다.
          </p>
          <Button size="lg" className="gap-2" disabled={!hasData} onClick={() => setStarted(true)}>
            <Play className="size-4" />
            US 스크리닝 시작
          </Button>
          {!hasData ? (
            <p className="mt-2 text-[11px] text-warn">먼저 위 2번 칸에 데이터를 적용해 주세요.</p>
          ) : null}
        </section>
      ) : query.isPending ? (
        <section className="flex items-center justify-center gap-2 rounded-lg border border-border bg-card p-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          입력한 미국 시세로 지표와 점수를 계산하는 중입니다…
        </section>
      ) : isUsAnalysisFailure(query.data) ? (
        <section className="rounded-lg border border-down/40 bg-down/10 p-6 text-[12px] text-down">
          <p className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="size-4" />
            분석을 실행하지 못했습니다.
          </p>
          <p className="mt-1 leading-relaxed">{query.data.error}</p>
        </section>
      ) : isUsAnalysisPayload(query.data) ? (
        <UsBriefing analysis={query.data.analysis} />
      ) : null}

      <UsDisclaimer />
    </AppShell>
  );
}

function UsBriefing({ analysis }: { analysis: UsAnalysisResult }) {
  const { market, sectors, rows } = analysis;
  const eligible = rows.filter((r) => r.eligibility.scoreEligible);
  const stateLabel =
    market.state === "RISK_ON" ? "Risk-On" : market.state === "NEUTRAL" ? "Neutral" : "Risk-Off";
  const stateColor =
    market.state === "RISK_ON" ? "text-up" : market.state === "NEUTRAL" ? "text-warn" : "text-down";
  const postureLabel =
    market.researchPosture === "NORMAL"
      ? "NORMAL — 통상 리서치"
      : market.researchPosture === "CAUTION"
        ? "CAUTION — 확인 항목 증가"
        : "DEFENSIVE — 데이터·리스크 점검 우선";
  const top = [...eligible].slice(0, 10);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          기준일 {analysis.asOfDate} · ruleVersion {analysis.ruleVersion} · 데이터{" "}
          {analysis.dataVersion}
        </span>
        <span>계산 시각 {formatKstDateTime(analysis.calculatedAt)} (KST · EOD 확정 일봉)</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title="시장 상태 (Market Policy v1)"
          icon={<Activity className="size-4 text-primary" />}
        >
          <p className={`mb-1 text-lg font-bold ${stateColor}`}>{stateLabel}</p>
          <p className="mb-2 text-[11px] text-muted-foreground">
            researchPosture {postureLabel} · 표시등급 상한 {market.displayGradeCap}
          </p>
          {market.incomplete ? (
            <p className="mb-2 text-[11px] text-warn">
              일부 시장 신호가 “데이터 없음”입니다({market.availableCount}/{market.signals.length}{" "}
              판정 가능). 판단 보류 항목은 0점 처리하지 않습니다.
            </p>
          ) : null}
          <ul className="space-y-1">
            {market.signals.map((s) => (
              <li key={s.key} className="flex items-start gap-1.5 text-[11.5px]">
                <StatusIcon status={s.status} />
                <span>
                  <span className="font-medium">{s.label}</span>
                  <span className="ml-1 text-muted-foreground">
                    {s.observed} · 기준 {s.threshold}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="분석 요약" icon={<Activity className="size-4 text-primary" />}>
          <dl className="space-y-1 text-[12px]">
            {[
              ["전체 분석 종목", `${rows.length}종목`],
              ["평가 자격 통과", `${eligible.length}종목`],
              [
                "S/A 등급 (표시등급)",
                `${eligible.filter((r) => r.displayGrade === "S" || r.displayGrade === "A").length}종목`,
              ],
              [
                "coverage 90% 이상",
                `${rows.filter((r) => r.dataStatus === "COMPLETE").length}종목`,
              ],
              [
                "TACTICAL_ONLY (레버리지·인버스)",
                `${rows.filter((r) => r.eligibility.status === "TACTICAL_ONLY").length}종목`,
              ],
              [
                "NEW_LISTING (이력 부족)",
                `${rows.filter((r) => r.eligibility.status === "NEW_LISTING").length}종목`,
              ],
            ].map(([k, v]) => (
              <div
                key={k}
                className="flex justify-between border-b border-border py-1 last:border-0"
              >
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="num font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[11px] text-muted-foreground">
            상세 필터·CSV 내보내기는{" "}
            <Link to="/us/screener" className="text-primary hover:underline">
              US 스크리너
            </Link>{" "}
            탭에서 이용하세요.
          </p>
        </Card>

        <Card
          title="상위 우선도 후보 (매수 지시 아님)"
          icon={<Activity className="size-4 text-primary" />}
        >
          <ul className="space-y-1">
            {top.map((r) => (
              <li
                key={r.instrument.symbol}
                className="flex items-center justify-between gap-2 text-[12px]"
              >
                <Link
                  to="/us/instrument/$symbol"
                  params={{ symbol: r.instrument.symbol }}
                  className="flex items-center gap-1.5 hover:underline"
                >
                  <UsGradeBadge grade={r.displayGrade} />
                  <span className="font-mono font-semibold">{r.instrument.symbol}</span>
                  <span className="max-w-[110px] truncate text-muted-foreground">
                    {r.instrument.name}
                  </span>
                </Link>
                <span className="num">{r.rawComposite.toFixed(1)}</span>
              </li>
            ))}
            {top.length === 0 ? (
              <li className="text-[11px] text-muted-foreground">
                평가 자격을 통과한 종목이 없습니다.
              </li>
            ) : null}
          </ul>
        </Card>
      </div>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">섹터 게이트 (11개 GICS 프록시 ETF)</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {sectors.map((s) => (
            <div key={s.sector} className="rounded-md border border-border p-2.5">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold">
                  {s.label}{" "}
                  <span className="font-mono text-[10px] text-muted-foreground">{s.proxyEtf}</span>
                </span>
                <Badge
                  variant="outline"
                  className={`text-[10px] ${
                    s.state === "STRONG"
                      ? "border-up/50 text-up"
                      : s.state === "WEAK"
                        ? "border-down/50 text-down"
                        : s.state === "UNKNOWN"
                          ? "text-muted-foreground"
                          : "border-warn/50 text-warn"
                  }`}
                >
                  {s.state === "UNKNOWN" ? "판단 보류" : s.state}
                </Badge>
              </div>
              <p className="num text-[11px] text-muted-foreground">
                조건 {s.score}/{s.availableConditions || 0} 충족 · 3M 초과수익{" "}
                {s.excessReturn63 === null ? "N/A" : `${s.excessReturn63.toFixed(1)}%`} · breadth{" "}
                {s.breadthMa50 === null ? "N/A" : `${s.breadthMa50.toFixed(0)}%`}
              </p>
              <ul className="mt-1 space-y-0.5">
                {s.conditions.map((c) => (
                  <li
                    key={c.key}
                    className="flex items-start gap-1 text-[10.5px] text-muted-foreground"
                  >
                    <StatusIcon status={c.status} />
                    <span>
                      {c.label} — {c.observed}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4 text-[11px] leading-relaxed text-muted-foreground">
        <h2 className="mb-1 text-sm font-semibold text-foreground">데이터 한계</h2>
        <ul className="list-inside list-disc space-y-0.5">
          {analysis.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
