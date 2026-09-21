import { loadPortfolioState } from "@/lib/portfolioStore";
import { StrategyDescription } from "@/components/StrategyDescription";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { DataError } from "@/components/DataError";
import { BreakdownTable } from "@/components/BreakdownTable";
import { Delta, GradeBadge } from "@/components/ScreenerTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { analysisQueryOptions, withThreeDecimalClv } from "@/lib/analysisQuery";
import { formatNumber, formatPercent, formatPrice, formatWon } from "@/lib/format";
import { getDisplayStatus } from "@/lib/statusDisplay";
import { getDisplayWarnings } from "@/lib/warningDisplay";

const InstrumentCharts = lazy(() => import("@/components/InstrumentCharts"));

export const Route = createFileRoute("/instrument/$symbol")({
  ssr: false,
  loader: async ({ params, context }) => {
    const payload = await context.queryClient.ensureQueryData(analysisQueryOptions);
    const row = payload.analysis.rows.find((item) => item.instrument.symbol === params.symbol);
    if (!row) throw notFound();
    return { name: row.instrument.name, symbol: row.instrument.symbol };
  },
  head: ({ loaderData }) => {
    if (!loaderData)
      return {
        meta: [{ title: "종목 정보 없음 | TrendScore KR" }, { name: "robots", content: "noindex" }],
      };
    const title = `${loaderData.name}(${loaderData.symbol}) 점수 근거 | TrendScore KR`;
    const description = `${loaderData.name} 종목의 V8 Final 기술점수·일목균형표·볼린저밴드·이동평균·거래량 조건과 경고 신호를 확인합니다.`;
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
  const { data: payload, dataUpdatedAt } = useSuspenseQuery(analysisQueryOptions);
  const { data: portfolio } = useQuery({
    queryKey: ["portfolio-state"],
    queryFn: loadPortfolioState,
  });
  const [showLog, setShowLog] = useState(false);
  const [watched, setWatched] = useState(false);
  const holding = portfolio?.trades.find(
    (trade) => trade.symbol === symbol && trade.status === "OPEN" && trade.shares > 0,
  );
  const analysis = payload.analysis;
  const originalRow = analysis.rows.find((item) => item.instrument.symbol === symbol);
  if (!originalRow) throw notFound();
  const clv = originalRow.snapshot.closeLocationValue;
  const row =
    clv === null || !Number.isFinite(clv)
      ? originalRow
      : {
          ...originalRow,
          technical: withThreeDecimalClv(originalRow.technical, clv),
          vf: originalRow.vf ? withThreeDecimalClv(originalRow.vf, clv) : originalRow.vf,
        };

  const score = row.vf ?? row.technical;
  const snap = row.snapshot;
  const ich = snap.ichimoku;
  const displayWarnings = getDisplayWarnings(row);

  const log = {
    strategyVersion: analysis.strategyVersion,
    dataVersion: analysis.dataVersion,
    asOfDate: analysis.asOfDate,
    parameters: {
      bollinger: { period: 20, mult: 2 },
      ichimoku: { 9: 9, 26: 26, 52: 52, shift: 26 },
      atr: { period: 14, method: "wilder" },
    },
    rawInputs: {
      close: snap.close,
      volumeRatio20: snap.volumeRatio20,
      tradingValueRatio20: snap.tradingValueRatio20,
    },
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
    ruleEvaluations: [
      ...(row.vf?.rows ?? []),
      ...row.technical.rows,
      ...row.priority.rows,
      ...row.quality.rows,
    ],
    finalScores: {
      operatingScore10: row.operatingScore10,
      technicalRaw: row.vf
        ? `${row.vf.points}/${row.vf.maxPoints}`
        : `${row.technical.points}/${row.technical.maxPoints}`,
      priority: `${row.priority.points}/${row.priority.maxPoints}`,
      quality: row.qualityScore,
      marketSector: row.marketSectorScore,
    },
    signals: {
      kosdaq80Onset: row.kosdaq80Onset,
      kospiEightPointEntry: row.kospiEightPointEntry,
      kospi80Onset: row.kospi80Onset,
      operationalSignalVersion: row.operationalSignalVersion,
      exitSignal: row.exitSignal,
    },
    failedRules: row.failedRules,
    warnings: row.warnings,
    displayWarnings,
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
            ? "종가가 일목 구름 내부에 있습니다"
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
    const momentum = row.technical.rows.find(
      (r) => r.group === "Momentum Confirmation" || r.group === "Vf Momentum",
    );
    if (momentum) parts.push(`Momentum Confirmation: ${momentum.actual} → ${momentum.points}점.`);
    const bb = row.technical.rows.find((r) => r.group === "Breakout" || r.group === "Vf Breakout");
    if (bb) parts.push(`볼린저 상단 돌파 판정: ${bb.actual} (획득 ${bb.points}점).`);
    parts.push(
      row.operatingScore10 === null
        ? `V8 Final 원점수는 ${score.points}/${score.maxPoints}점이지만 핵심 피처 결측 때문에 운영 기술점수는 산정 불가입니다.`
        : `V8 Final 운영 기술점수는 ${row.operatingScore10.toFixed(1)}/10점입니다.`,
    );
    return parts.join(" ");
  })();

  return (
    <AppShell>
      <StrategyDescription />
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            {row.instrument.name}
            <span className="text-sm font-normal text-muted-foreground">
              {row.instrument.symbol} · {row.instrument.market} · {row.instrument.sectorName}
            </span>
          </h1>
          <p className="text-[12px] text-muted-foreground">
            기준일 {analysis.asOfDate} · 모델 {analysis.strategyVersion} · 벤치마크{" "}
            {row.benchmarkCode}
            {row.benchmarkFallback ? " (대체 벤치마크 사용)" : ""} · 데이터 완전성{" "}
            {formatNumber(row.dataCompletenessRatio * 100, 0)}%
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={watched ? "secondary" : "default"}
            onClick={() => setWatched((w) => !w)}
          >
            {watched ? "관심종목에 추가됨" : "관심종목 추가"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowLog((s) => !s)}>
            계산 근거 보기
          </Button>
        </div>
      </header>

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="현재가" value={formatPrice(snap.close)} />
        <Stat
          label="기술점수"
          value={
            row.operatingScore10 === null
              ? "산정 불가"
              : `${formatNumber(row.operatingScore10, 1)} / 10`
          }
        />
        <Stat
          label="우선점수"
          value={`${formatNumber(row.priority.points, 2)} / ${formatNumber(row.priority.maxPoints, 1)}`}
        />
        <Stat label="모델등급" value={<GradeBadge grade={row.grade} />} />
        <Stat
          label="상태"
          value={
            holding
              ? row.exitSignal
                ? `청산 대기 · ${getDisplayStatus(row)}`
                : "보유"
              : getDisplayStatus(row)
          }
        />
        <Stat label="52주 고점 거리" value={<Delta value={snap.distanceFrom52wHigh} />} />
      </div>

      {displayWarnings.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {displayWarnings.map((warning) => (
            <Badge
              key={warning}
              variant="outline"
              className="border-warn/30 bg-warn-soft text-[11px] text-warn"
            >
              {warning}
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

      <Suspense
        fallback={
          <div className="mt-5 rounded-lg border border-border p-4" role="status">
            차트를 불러오는 중입니다…
          </div>
        }
      >
        <InstrumentCharts key={symbol} symbol={symbol} payload={payload} revision={dataUpdatedAt} />
      </Suspense>

      <div className="mt-5 space-y-4">
        <BreakdownTable
          block={row.technical}
          title={`기술점수 (${row.technical.maxPoints}점 만점)${row.vf ? " · V8 Final 8개 항목" : ""}`}
          asOfDate={analysis.asOfDate}
          source={analysis.dataProvider}
        />
        {row.vf ? (
          <p className="text-xs text-muted-foreground">
            주식은 V8 Final raw 0~10 기술점수를 그대로 운영점수로 사용합니다. 핵심 피처가 하나라도
            결측이면 남은 피처만으로 재정규화하지 않고 기술점수 산정 불가로 처리합니다. 우선점수와
            펀더멘털 점수는 기술점수에 추가 합산하지 않습니다. 산정 가능 {row.vf.availableMaxPoints}
            /{row.vf.maxPoints}점.
            {snap.high52w === null
              ? " 52주 신고가에는 기준일 포함 252거래일 일봉이 필요합니다."
              : ""}
            {snap.foreignNet20d === null
              ? " 외국인 수급은 최근 20거래일 순매수 금액이 모두 필요합니다."
              : ""}
          </p>
        ) : null}
        <BreakdownTable
          block={row.priority}
          title={`우선점수 · 참고 (${row.priority.maxPoints}점 만점)`}
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

      <div className="mt-5 grid gap-4">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-semibold">수급 · 이격</h2>
          <div className="grid grid-cols-2 gap-2">
            <Stat label="외국인 5일 누적" value={formatWon(snap.foreignNet5d)} />
            <Stat label="외국인 20일 누적" value={formatWon(snap.foreignNet20d)} />
            <Stat label="외국인 60일 누적" value={formatWon(snap.foreignNet60d)} />
            <Stat label="기관 20일 누적" value={formatWon(snap.institutionNet20d)} />
            <Stat
              label="거래량 비율(20일)"
              value={
                snap.volumeRatio20 === null
                  ? "데이터 없음"
                  : `${formatNumber(snap.volumeRatio20, 1)}%`
              }
            />
            <Stat
              label="거래대금 비율(20일)"
              value={
                snap.tradingValueRatio20 === null
                  ? "데이터 없음"
                  : `${formatNumber(snap.tradingValueRatio20, 1)}%`
              }
            />
            <Stat label="MA20 이격" value={formatPercent(snap.extensionFromMa20)} />
            <Stat
              label="ATR 이격"
              value={
                snap.atrExtension === null
                  ? "데이터 없음"
                  : `${formatNumber(snap.atrExtension, 2)} ATR`
              }
            />
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
