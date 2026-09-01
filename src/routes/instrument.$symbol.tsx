import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { BreakdownTable } from "@/components/BreakdownTable";
import { Delta, GradeBadge } from "@/components/ScreenerTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { instrumentQueryOptions } from "@/lib/analysisQuery";
import { WARNING_LABELS } from "@/lib/engine/scoring";
import { formatNumber, formatPercent, formatPrice, formatWon } from "@/lib/format";

export const Route = createFileRoute("/instrument/$symbol")({
  // 외부 시세 API 실패 시 SSR 500(빈 화면) 대신 클라이언트 에러 화면을 보여준다.
  ssr: false,
  loader: async ({ params, context }) => {
    const detail = await context.queryClient.ensureQueryData(
      instrumentQueryOptions(params.symbol),
    );
    if (!detail.row) throw notFound();
    return { name: detail.row.instrument.name, symbol: detail.row.instrument.symbol };
  },
  head: ({ loaderData }) => {
    if (!loaderData)
      return {
        meta: [
          { title: "종목 정보 없음 | TrendScore KR" },
          { name: "robots", content: "noindex" },
        ],
      };
    const title = `${loaderData.name}(${loaderData.symbol}) 점수 근거 | TrendScore KR`;
    const description = `${loaderData.name} 종목의 일목균형표·볼린저밴드·이동평균·거래량 조건별 획득점수와 산정 가능 점수, 경고 신호, 계산 근거를 확인합니다.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
    };
  },
  errorComponent: ({ error, reset }) => <DataError error={error} reset={reset} />,
  component: InstrumentDetail,
});

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-surface p-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="num text-[13px] font-semibold">{value}</p>
    </div>
  );
}

function InstrumentDetail() {
  const { symbol } = Route.useParams();
  const { data: detail } = useSuspenseQuery(instrumentQueryOptions(symbol));
  const analysis = detail;
  const row = detail.row!;
  const chart = detail.chart;
  const history = detail.history;
  const [showLog, setShowLog] = useState(false);
  const [watched, setWatched] = useState(false);
  const [visible, setVisible] = useState({ ma: true, bb: true, cloud: true });

  const snap = row.snapshot;
  const ich = snap.ichimoku;

  const log = {
    strategyVersion: analysis.strategyVersion,
    dataVersion: analysis.dataVersion,
    asOfDate: analysis.asOfDate,
    parameters: { bollinger: { period: 20, mult: 2 }, ichimoku: { 9: 9, 26: 26, 52: 52, shift: 26 }, atr: { period: 14, method: "wilder" } },
    rawInputs: { close: snap.close, volumeRatio20: snap.volumeRatio20, tradingValueRatio20: snap.tradingValueRatio20 },
    calculatedIndicators: {
      ma20: snap.ma20,
      ma60: snap.ma60,
      ma120: snap.ma120,
      atr14: snap.atr14,
      bbWidth: snap.bollinger.bb?.width ?? null,
      cloudTop: ich.cloudTop,
      cloudBottom: ich.cloudBottom,
      tenkan: ich.tenkan,
      kijun: ich.kijun,
      chikouDefinitionUsed: "현재 종가 > 26거래일 전 종가",
    },
    ruleEvaluations: [...row.technical.rows, ...row.priority.rows, ...row.quality.rows],
    finalScores: {
      technical: `${row.technical.points}/${row.technical.availableMaxPoints}`,
      priority: `${row.priority.points}/${row.priority.availableMaxPoints}`,
      quality: row.qualityScore,
      marketSector: row.marketSectorScore,
      totalNormalized: row.totalScoreNormalized,
    },
    failedRules: row.failedRules,
    warnings: row.warnings,
    timestamps: { calculatedAt: new Date().toISOString() },
  };

  const explanation = (() => {
    const parts: string[] = [];
    const cloudState =
      ich.cloudTop === null
        ? "일목 구름 계산에 필요한 데이터가 부족합니다"
        : snap.close > ich.cloudTop
          ? "종가가 일목 구름 상단 위에 있습니다"
          : snap.close >= (ich.cloudBottom ?? 0)
            ? "종가가 일목 구름 내부에 있어 진입 적합으로 표시하지 않습니다"
            : "종가가 일목 구름 아래에 있습니다";
    parts.push(`이 종목은 ${cloudState}.`);
    if (snap.maAligned !== null)
      parts.push(
        snap.maAligned
          ? "MA20 > MA60 > MA120 정배열을 유지하고 있습니다."
          : "이동평균 정배열 조건은 충족하지 않았습니다.",
      );
    if (snap.volumeRatio20 !== null)
      parts.push(`거래량은 직전 20일 평균의 ${snap.volumeRatio20.toFixed(1)}%입니다.`);
    const bb = row.technical.rows[1]!;
    parts.push(`볼린저 조건 판정: ${bb.actual} (획득 ${bb.points}점).`);
    parts.push(
      `기술점수는 ${row.technical.maxPoints}점 중 ${row.technical.points}점, 산정 가능 점수는 ${row.technical.availableMaxPoints}점입니다.`,
    );
    const foreign = row.priority.rows[1]!;
    if (foreign.status === "FAIL")
      parts.push("최근 3개월 외국인 누적 순매수가 음수이므로 우선점수에서 2점을 받지 못했습니다.");
    if (foreign.status === "NO_DATA")
      parts.push("외국인 수급 데이터가 없어 해당 항목은 0점이 아니라 산정 불가로 처리했습니다.");
    return parts.join(" ");
  })();

  return (
    <AppShell>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            {row.instrument.name}
            <span className="text-sm font-normal text-muted-foreground">
              {row.instrument.symbol} · {row.instrument.market} · {row.instrument.sectorName}
            </span>
          </h1>
          <p className="text-[12px] text-muted-foreground">
            기준일 {analysis.asOfDate} · 벤치마크 {row.benchmarkCode}
            {row.benchmarkFallback ? " (대체 벤치마크 사용)" : ""} · 데이터 완전성{" "}
            {formatNumber(row.dataCompletenessRatio * 100, 0)}%
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant={watched ? "secondary" : "default"} onClick={() => setWatched((w) => !w)}>
            {watched ? "관심종목에 추가됨" : "관심종목 추가"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowLog((s) => !s)}>
            계산 근거 보기
          </Button>
        </div>
      </header>

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="현재가" value={formatPrice(snap.close)} />
        <Stat label="종합점수" value={formatNumber(row.totalScoreNormalized, 1)} />
        <Stat label="기술등급" value={<GradeBadge grade={row.grade} />} />
        <Stat label="상태 라벨" value={row.actionLabelText} />
        <Stat
          label="시가총액"
          value={row.marketCap === null ? "데이터 없음" : formatWon(row.marketCap)}
        />
        <Stat label="52주 고점 거리" value={<Delta value={snap.distanceFrom52wHigh} />} />
      </div>

      {row.warnings.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {row.warnings.map((w) => (
            <Badge key={w} variant="outline" className="border-warn/30 bg-warn-soft text-[11px] text-warn">
              {WARNING_LABELS[w] ?? w}
            </Badge>
          ))}
        </div>
      ) : null}
      {!row.hardFilterPassed ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-down-soft p-2 text-[12px] text-down">
          실격 사유: {row.failedRules.join(", ")}
        </div>
      ) : null}
      {row.financials?.isFinancialSector ? (
        <div className="mt-3 rounded-md border border-warn/30 bg-warn-soft p-2 text-[12px] text-warn">
          금융업 종목: 일반 재무건전성 기준 적용에 주의가 필요합니다.
        </div>
      ) : null}

      <section className="mt-5 rounded-lg border border-border bg-card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">가격 · 지표 차트 (일봉)</h2>
          <div className="flex gap-1">
            {(
              [
                ["ma", "이동평균"],
                ["bb", "볼린저밴드"],
                ["cloud", "일목 구름"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setVisible((v) => ({ ...v, [key]: !v[key] }))}
                className={`rounded border px-2 py-0.5 text-[11px] ${visible[key] ? "border-primary/40 bg-info-soft text-info" : "border-border text-muted-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="h-[360px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chart}>
              <CartesianGrid stroke="var(--color-grid)" vertical={false} />
              <XAxis dataKey="tradeDate" tick={{ fontSize: 10 }} minTickGap={40} />
              <YAxis
                yAxisId="price"
                domain={["auto", "auto"]}
                tick={{ fontSize: 10 }}
                width={70}
                tickFormatter={(v: number) => v.toLocaleString("ko-KR")}
              />
              <YAxis yAxisId="volume" orientation="right" hide />
              <Tooltip
                contentStyle={{
                  background: "var(--color-card)",
                  border: "1px solid var(--color-border)",
                  fontSize: 11,
                }}
                formatter={(v) => (typeof v === "number" ? v.toLocaleString("ko-KR") : v)}
              />
              {visible.cloud ? (
                <>
                  <Area
                    yAxisId="price"
                    dataKey="cloudTop"
                    stroke="none"
                    fill="var(--color-chart-2)"
                    fillOpacity={0.16}
                    name="구름 상단"
                  />
                  <Area
                    yAxisId="price"
                    dataKey="cloudBottom"
                    stroke="none"
                    fill="var(--color-background)"
                    fillOpacity={1}
                    name="구름 하단"
                  />
                </>
              ) : null}
              <Bar yAxisId="volume" dataKey="volume" fill="var(--color-grid)" name="거래량" />
              <Line yAxisId="price" dataKey="close" stroke="var(--color-foreground)" dot={false} strokeWidth={1.6} name="종가" />
              {visible.ma ? (
                <>
                  <Line yAxisId="price" dataKey="ma20" stroke="var(--color-chart-3)" dot={false} strokeWidth={1} name="MA20" />
                  <Line yAxisId="price" dataKey="ma60" stroke="var(--color-chart-1)" dot={false} strokeWidth={1} name="MA60" />
                  <Line yAxisId="price" dataKey="ma120" stroke="var(--color-chart-5)" dot={false} strokeWidth={1} name="MA120" />
                </>
              ) : null}
              {visible.bb ? (
                <>
                  <Line yAxisId="price" dataKey="bbUpper" stroke="var(--color-chart-4)" dot={false} strokeDasharray="4 3" strokeWidth={1} name="BB 상단" />
                  <Line yAxisId="price" dataKey="bbLower" stroke="var(--color-chart-4)" dot={false} strokeDasharray="4 3" strokeWidth={1} name="BB 하단" />
                </>
              ) : null}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          ATR 손절선 참고: {formatPrice(snap.close - 1.8 * (snap.atr14 ?? 0))} (진입가 기준 1.8 ATR)
          · 52주 신고가 {formatPrice(snap.high52w)}
        </p>
      </section>

      <div className="mt-5 space-y-4">
        <BreakdownTable
          block={row.technical}
          title="Technical Signal Score (7점 만점)"
          asOfDate={analysis.asOfDate}
          source={analysis.dataProvider}
        />
        <BreakdownTable
          block={row.priority}
          title={`Priority Quality Score (8점 만점) · 정규화 ${row.priorityNormalized === null ? "산정 불가" : `${row.priorityNormalized.toFixed(1)}점`}`}
          asOfDate={analysis.asOfDate}
          source={analysis.dataProvider}
        />
        <BreakdownTable
          block={row.quality}
          title={
            row.instrument.instrumentType === "STOCK"
              ? "Fundamental Score (100점 환산)"
              : "ETF 상품건전성 (100점)"
          }
          asOfDate={analysis.asOfDate}
          source={analysis.dataProvider}
        />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-semibold">최근 60거래일 기술점수 추이</h2>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={history}>
                <CartesianGrid stroke="var(--color-grid)" vertical={false} />
                <XAxis dataKey="tradeDate" tick={{ fontSize: 10 }} minTickGap={40} />
                <YAxis domain={[0, 7]} tick={{ fontSize: 10 }} width={30} />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-card)",
                    border: "1px solid var(--color-border)",
                    fontSize: 11,
                  }}
                />
                <Line dataKey="technicalPoints" stroke="var(--color-chart-1)" dot={false} name="기술점수" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-semibold">수급 · 이격</h2>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="외국인 5일 누적" value={formatWon(snap.foreignNet5d)} />
            <Stat label="외국인 20일 누적" value={formatWon(snap.foreignNet20d)} />
            <Stat label="외국인 60일 누적" value={formatWon(snap.foreignNet60d)} />
            <Stat label="기관 20일 누적" value={formatWon(snap.institutionNet20d)} />
            <Stat label="거래량 비율(20일)" value={snap.volumeRatio20 === null ? "데이터 없음" : `${formatNumber(snap.volumeRatio20, 1)}%`} />
            <Stat label="거래대금 비율(20일)" value={snap.tradingValueRatio20 === null ? "데이터 없음" : `${formatNumber(snap.tradingValueRatio20, 1)}%`} />
            <Stat label="MA20 이격" value={formatPercent(snap.extensionFromMa20)} />
            <Stat label="ATR 이격" value={snap.atrExtension === null ? "데이터 없음" : `${formatNumber(snap.atrExtension, 2)} ATR`} />
            <Stat label="RS20" value={<Delta value={row.rs20} digits={2} />} />
            <Stat label="RS60" value={<Delta value={row.rs60} digits={2} />} />
          </div>
        </section>
      </div>

      <section className="mt-5 rounded-lg border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">설명 문장 (규칙 기반 템플릿)</h2>
        <p className="text-[13px] leading-relaxed">{explanation}</p>
        <p className="mt-2 text-[11px] text-muted-foreground">
          설명은 계산 결과 JSON만 사용하는 고정 템플릿으로 생성되며, 수치를 새로 만들어내지
          않습니다.
        </p>
      </section>

      {showLog ? (
        <section className="mt-5 rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-semibold">계산 근거 로그 (JSON)</h2>
          <pre className="max-h-[420px] overflow-auto rounded-md bg-surface-strong p-3 text-[11px] leading-relaxed">
            {JSON.stringify(log, null, 2)}
          </pre>
        </section>
      ) : null}
    </AppShell>
  );
}
