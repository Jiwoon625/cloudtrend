import { KrxReviewReferenceDetails } from "./KrxReviewReferenceDetails";
import { etfDataJudgment, etfOperationalDisplay } from "@/lib/etfOperationalDisplay";
import { isOperationalSignalDate, BEFORE_OPERATIONAL_START } from "@/lib/operationalSignalStart";
import { AppShell } from "./AppShell";
import { Link } from "@tanstack/react-router";
import type { ScreeningRow } from "@/lib/engine/pipeline";
import { etfSignalDateLabels } from "@/lib/etfSignalDatePresentation";
import { etfPartialEvidence } from "@/lib/etfPartialEvidence";
import { formatKstDateTime } from "@/lib/format";
import { lazy, Suspense, type ReactNode } from "react";
import type { AnalysisPayload } from "@/lib/marketPayload";
import type { EtfInstrumentChartBundle } from "@/lib/engine/etfInstrumentChart";
import { ETF_POLICY } from "@/lib/engine/etfStrategy";

const loadEtfInstrumentCharts = () => import("./EtfInstrumentCharts");
const EtfInstrumentCharts = lazy(loadEtfInstrumentCharts);
const value = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "미관측"
    : n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });

export function EtfM0Summary({
  row,
  signalDate,
  held,
  bundle,
  priceExit,
}: {
  row: ScreeningRow;
  signalDate: string;
  held: boolean | undefined;
  bundle?: EtfInstrumentChartBundle | undefined;
  priceExit?: { reason: string | null; signalDate: string | null } | undefined;
}) {
  const evidence = etfPartialEvidence(row, signalDate);
  const previous = bundle?.previousM0;
  const currentBundle =
    evidence.score === null &&
    bundle?.symbol === row.instrument.symbol &&
    bundle.asOfDate === signalDate &&
    bundle.version === ETF_POLICY.version;
  const previousReference =
    currentBundle &&
    previous &&
    previous.date === bundle.previousTradingDate &&
    previous.date < signalDate &&
    Number.isFinite(previous.score) &&
    previous.score >= 0 &&
    previous.score <= 100
      ? previous
      : null;
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <section className="rounded-lg border p-3 sm:p-4">
        <h2 className="text-sm font-semibold">M0 총점</h2>
        <p className="text-3xl font-bold">
          {value(evidence.score)} <span className="text-sm">/ 100</span>
        </p>
        <p className="text-sm">{etfOperationalDisplay(row, signalDate, held, false, priceExit)}</p>
        {previousReference ? (
          <p className="mt-2 text-xs text-muted-foreground" title="해당 날짜 자료로 재계산한 M0">
            전 거래일 M0 {value(previousReference.score)} / 100 · {previousReference.date} · 참고
          </p>
        ) : currentBundle &&
          previous === null &&
          bundle.previousTradingDate &&
          bundle.previousTradingDate < signalDate ? (
          <p className="mt-2 text-xs text-muted-foreground">
            직전 거래일 M0 미관측 · {bundle.previousTradingDate}
          </p>
        ) : null}
      </section>
      <section className="rounded-lg border p-3 sm:p-4">
        {etfDataJudgment(row, signalDate) ? (
          <p className="mb-2 text-xs text-muted-foreground">{etfDataJudgment(row, signalDate)}</p>
        ) : null}
        <h2 className="mb-2 text-sm font-semibold">구성요소</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["기술", evidence.technical],
            ["우선", evidence.priority],
            ["건전성", evidence.health],
            ["환경", evidence.environment],
          ].map(([label, n]) => (
            <div key={String(label)}>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="font-semibold">{value(n as number | null | undefined)}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function EtfInstrumentDetail({
  row,
  asOfDate,
  calculatedAt,
  held,
  holdingsNotice,
  payload,
  priceExit,
}: {
  row: ScreeningRow;
  asOfDate?: string;
  calculatedAt: string;
  held: boolean | undefined;
  holdingsNotice?: ReactNode;
  payload?: AnalysisPayload;
  priceExit?: { reason: string | null; signalDate: string | null } | undefined;
}) {
  const s = row.etfStrategy;
  const signalDate = asOfDate ?? s?.date ?? row.snapshot.tradeDate;
  const evidence = etfPartialEvidence(row, signalDate);
  const signalDates = etfSignalDateLabels(row, signalDate);
  const summary = (bundle?: EtfInstrumentChartBundle) => (
    <EtfM0Summary
      row={row}
      signalDate={signalDate}
      held={held}
      bundle={bundle}
      priceExit={priceExit}
    />
  );
  return (
    <AppShell>
      <header className="mb-4">
        <h1 className="text-xl font-bold">
          {row.instrument.name}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            {row.instrument.symbol} · ETF
          </span>
        </h1>
        <p className="text-xs text-muted-foreground">
          기준일 {signalDate} · {s?.version ?? "전략 기록 없음"} · 자료 {s?.dataStatus ?? "미확인"}
        </p>
      </header>
      <KrxReviewReferenceDetails reference={row.krxReviewReference} etf />
      {holdingsNotice}
      <div className="space-y-4">
        {payload ? (
          <Suspense
            fallback={
              <>
                {summary()}
                <p className="py-4 text-xs text-muted-foreground" role="status">
                  차트 화면을 준비하는 중…
                </p>
              </>
            }
          >
            <EtfInstrumentCharts
              key={row.instrument.symbol}
              symbol={row.instrument.symbol}
              payload={payload}
              renderSummary={summary}
            />
          </Suspense>
        ) : (
          summary()
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <section className="rounded-lg border p-3 sm:p-4">
            <h2 className="text-sm font-semibold">원신호 · 확인일</h2>
            <p className="mt-2 text-sm">
              원신호 {signalDates.origin} · 확인일 {signalDates.confirmation}
            </p>
            <p className="text-xs text-muted-foreground">{s?.confirmationIssues?.join(" · ")}</p>
          </section>
          {!payload ? (
            <section className="rounded-lg border p-3 sm:p-4">
              <h2 className="text-sm font-semibold">기초지수 MA60</h2>
              <p className="mt-2 text-sm">
                기초지수 {value(evidence.underlyingClose)} · MA60 {value(evidence.underlyingMa60)}
              </p>
            </section>
          ) : null}
          <section className="rounded-lg border p-3 sm:p-4">
            <h2 className="text-sm font-semibold">보유 시 행동</h2>
            <p className="mt-2 text-sm">
              {!isOperationalSignalDate(signalDate)
                ? BEFORE_OPERATIONAL_START
                : held === undefined
                  ? "보유 확인 중"
                  : !held
                    ? "미보유"
                    : priceExit?.reason &&
                        priceExit.signalDate &&
                        priceExit.signalDate <= signalDate
                      ? etfOperationalDisplay(row, signalDate, true, false, priceExit)
                      : !evidence.current
                        ? "보유 · 판단 미확인"
                        : etfOperationalDisplay(row, signalDate, true)}
            </p>
            <Link to="/portfolio" className="text-xs text-primary hover:underline">
              포트폴리오에서 보유·체결 확인
            </Link>
          </section>
        </div>
        <details className="rounded-lg border p-4">
          <summary className="text-sm font-semibold">원자료</summary>
          <p className="my-2 text-xs">
            실제 계산시각 {formatKstDateTime(calculatedAt)} · 전략의 직전 비교 거래일{" "}
            {s?.previousDate ?? "미관측"}
          </p>
          <pre className="overflow-auto text-xs">
            {JSON.stringify({ strategy: s, snapshot: row.snapshot }, null, 2)}
          </pre>
        </details>
      </div>
    </AppShell>
  );
}
