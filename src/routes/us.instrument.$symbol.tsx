import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CheckCircle2, MinusCircle } from "lucide-react";
import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { UsDisclaimer } from "@/components/us/UsDisclaimer";
import { CoverageBadge, EligibilityBadge, UsGradeBadge } from "@/components/us/UsScreenerTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatKstDateTime } from "@/lib/format";
import {
  usSectorLabel,
  type ScoreReason,
  type ScoreStatus,
  type UsAnalysisResult,
  type UsRow,
  type UsScoreBlock,
} from "@/lib/engine/usPipeline";
import { isUsAnalysisPayload, usAnalysisQueryOptions } from "@/lib/usAnalysisQuery";

export const Route = createFileRoute("/us/instrument/$symbol")({
  ssr: false,
  head: ({ params }) => ({
    meta: [
      { title: `${params.symbol} 분석 | TrendScore US 종목 상세` },
      {
        name: "description",
        content: `${params.symbol}의 Technical 7, Priority, ETF Health 점수와 각 항목의 관측값·기준·데이터 출처를 근거와 함께 표시합니다.`,
      },
      { property: "og:title", content: `${params.symbol} 분석 | TrendScore US` },
      {
        property: "og:description",
        content: "점수 근거, coverage, 시장·섹터 상태를 함께 확인할 수 있는 종목 상세 화면입니다.",
      },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: UsInstrumentPage,
});

function StatusIcon({ status }: { status: ScoreStatus }) {
  if (status === "PASS") return <CheckCircle2 className="size-3.5 shrink-0 text-up" />;
  if (status === "FAIL") return <AlertTriangle className="size-3.5 shrink-0 text-down" />;
  return <MinusCircle className="size-3.5 shrink-0 text-muted-foreground" />;
}

function ReasonList({ reasons }: { reasons: ScoreReason[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full text-[11.5px]">
        <thead className="bg-surface-strong text-left">
          <tr>
            <th className="px-2 py-1.5 font-semibold">항목</th>
            <th className="px-2 py-1.5 font-semibold">관측값</th>
            <th className="px-2 py-1.5 font-semibold">기준</th>
            <th className="px-2 py-1.5 text-right font-semibold">점수</th>
          </tr>
        </thead>
        <tbody>
          {reasons.map((r) => (
            <tr key={r.key} className="border-t border-border align-top">
              <td className="px-2 py-1.5">
                <span className="flex items-start gap-1.5 font-medium">
                  <StatusIcon status={r.status} />
                  {r.label}
                </span>
                <span className="block pl-5 text-[10.5px] text-muted-foreground">
                  {r.definition}
                </span>
              </td>
              <td className="px-2 py-1.5 text-muted-foreground">{r.observed}</td>
              <td className="px-2 py-1.5 text-muted-foreground">{r.threshold}</td>
              <td className="num px-2 py-1.5 text-right">
                {r.status === "UNAVAILABLE" ? "N/A" : `${r.points}/${r.maxPoints}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function blockLabel(b: UsScoreBlock): string {
  return b.availableMaxPoints > 0
    ? `${b.points} / ${b.availableMaxPoints} (총 ${b.maxPoints})`
    : "N/A";
}

function UsInstrumentPage() {
  const { symbol } = Route.useParams();
  const query = useQuery(usAnalysisQueryOptions);
  const payload = isUsAnalysisPayload(query.data) ? query.data : null;
  const row = payload?.analysis.rows.find((r) => r.instrument.symbol === symbol.toUpperCase());

  return (
    <AppShell loadAnalysis={false}>
      <Link
        to="/us/screener"
        className="mb-3 inline-flex items-center gap-1 text-[12px] text-primary hover:underline"
      >
        <ArrowLeft className="size-3.5" />
        US 스크리너로 돌아가기
      </Link>

      {!payload ? (
        <section className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
          <h1 className="mb-1 text-lg font-semibold">먼저 US 스크리닝을 실행해 주세요</h1>
          <Link to="/us">
            <Button size="sm" className="mt-2">
              US 데이터 입력으로 이동
            </Button>
          </Link>
        </section>
      ) : !row ? (
        <section className="rounded-lg border border-border bg-card p-10 text-center text-[12px] text-muted-foreground">
          입력한 데이터에 {symbol.toUpperCase()} 일봉이 없습니다.
        </section>
      ) : (
        <Detail row={row} analysis={payload.analysis} />
      )}
      <UsDisclaimer />
    </AppShell>
  );
}

function Detail({ row, analysis }: { row: UsRow; analysis: UsAnalysisResult }) {
  const [tab, setTab] = useState<"TECHNICAL" | "PRIORITY" | "QUALITY" | "DATA">("TECHNICAL");
  const s = row.snapshot;

  const positives = [
    row.technical.points >= 6 ? "Technical 7 중 6개 이상 충족" : null,
    (s.return126 ?? -1) > 0 ? "6개월 절대수익 양수" : null,
    (s.distanceFrom252High ?? -100) >= -5 ? "52주 고가 5% 이내" : null,
    row.sectorState === "STRONG" ? "소속 섹터 게이트 Strong" : null,
  ]
    .filter((x): x is string => x !== null)
    .slice(0, 3);

  const cautions = [
    row.dataStatus !== "COMPLETE"
      ? `데이터 coverage ${(row.coverage * 100).toFixed(0)}% (부분 계산)`
      : null,
    row.eligibility.status !== "ELIGIBLE" ? `자격 상태 ${row.eligibility.status}` : null,
    analysis.market.state === "RISK_OFF" ? "시장 Risk-Off — 표시등급 상한 B" : null,
    row.sectorState === "WEAK" ? "소속 섹터 Weak — 표시등급 상한 A" : null,
  ]
    .filter((x): x is string => x !== null)
    .slice(0, 3);

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-4 lg:grid-cols-[auto_1fr_1fr]">
          <div className="flex flex-col items-center gap-1">
            <UsGradeBadge grade={row.displayGrade} size="lg" />
            <span className="text-[10.5px] text-muted-foreground">
              표시등급 (원등급 {row.rawGrade})
            </span>
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">
              <span className="font-mono">{row.instrument.symbol}</span> · {row.instrument.name}
            </h1>
            <p className="mb-2 text-[11.5px] text-muted-foreground">
              {usSectorLabel(row.instrument.sector)} · {row.instrument.assetType} /{" "}
              {row.instrument.securityType} · 기준일 {analysis.asOfDate}
            </p>
            <dl className="grid grid-cols-2 gap-x-4 text-[12px]">
              <div className="flex justify-between border-b border-border py-1">
                <dt className="text-muted-foreground">rawComposite</dt>
                <dd className="num font-semibold">{row.rawComposite.toFixed(1)}</dd>
              </div>
              <div className="flex justify-between border-b border-border py-1">
                <dt className="text-muted-foreground">Technical</dt>
                <dd className="num">{blockLabel(row.technical)}</dd>
              </div>
              <div className="flex justify-between border-b border-border py-1">
                <dt className="text-muted-foreground">Priority</dt>
                <dd className="num">{blockLabel(row.priority)}</dd>
              </div>
              <div className="flex justify-between border-b border-border py-1">
                <dt className="text-muted-foreground">
                  {row.instrument.assetType === "ETF" ? "ETF Health" : "Fundamental"}
                </dt>
                <dd className="num">
                  {row.instrument.assetType === "ETF"
                    ? row.etfHealth
                      ? blockLabel(row.etfHealth)
                      : "N/A (ETN 제외)"
                    : "N/A (SEC 미연결)"}
                </dd>
              </div>
            </dl>
          </div>
          <div className="space-y-1.5 text-[12px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="text-[10px]">
                Market {analysis.market.state}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                Sector {row.sectorState}
              </Badge>
              <CoverageBadge coverage={row.coverage} status={row.dataStatus} />
              <EligibilityBadge row={row} />
            </div>
            <p className="text-[11px] text-muted-foreground">
              데이터 기준 {analysis.asOfDate} · 계산 {formatKstDateTime(analysis.calculatedAt)} ·
              ruleVersion {analysis.ruleVersion}
            </p>
            <div>
              <p className="text-[11px] font-semibold text-up">긍정 요인</p>
              <ul className="list-inside list-disc text-[11px] text-muted-foreground">
                {positives.length ? positives.map((p) => <li key={p}>{p}</li>) : <li>해당 없음</li>}
              </ul>
            </div>
            <div>
              <p className="text-[11px] font-semibold text-warn">주의 요인</p>
              <ul className="list-inside list-disc text-[11px] text-muted-foreground">
                {cautions.length ? cautions.map((p) => <li key={p}>{p}</li>) : <li>해당 없음</li>}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-1">
        {(
          [
            ["TECHNICAL", "Technical 7"],
            ["PRIORITY", "Priority"],
            ["QUALITY", row.instrument.assetType === "ETF" ? "ETF Health" : "Fundamental"],
            ["DATA", "Data Quality"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors ${
              tab === id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-surface hover:bg-accent"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "TECHNICAL" ? <ReasonList reasons={row.technical.reasons} /> : null}
      {tab === "PRIORITY" ? <ReasonList reasons={row.priority.reasons} /> : null}
      {tab === "QUALITY" ? (
        row.instrument.assetType === "ETF" && row.etfHealth ? (
          <ReasonList reasons={row.etfHealth.reasons} />
        ) : (
          <p className="rounded-md border border-warn/40 bg-warn-soft p-3 text-[12px]">
            {row.instrument.assetType === "ETF"
              ? "ETN·CEF 구조는 ETF Health 평가 대상이 아닙니다."
              : "Fundamental 100은 SEC CompanyFacts 연결 후 계산됩니다. 현재는 N/A로 표시되며 Composite 가중치에서 제외됩니다."}
          </p>
        )
      ) : null}
      {tab === "DATA" ? (
        <section className="space-y-2 rounded-md border border-border bg-card p-4 text-[12px]">
          <p>
            일봉 {s.bars}봉 · MA200 {s.ma200 === null ? "계산 불가" : "계산됨"} · 60일 median dollar
            volume{" "}
            {s.dollarVolume60Median === null
              ? "데이터 없음"
              : `$${(s.dollarVolume60Median / 1e6).toFixed(1)}M`}
          </p>
          <p className="text-muted-foreground">
            자격 판정 사유:{" "}
            {row.eligibility.reasons.length ? row.eligibility.reasons.join(" · ") : "없음"}
          </p>
          <ul className="list-inside list-disc text-[11px] text-muted-foreground">
            {analysis.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
