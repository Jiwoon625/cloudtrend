import { useMemo, useState } from "react";

import type {
  CrashStopTradeRow,
  ExitOverlayComparisonRow,
  PortfolioMetricRow,
  PositionCapComparisonRow,
  RegimeGateComparisonRow,
  SegmentPerformanceRow,
  StrategyValidation,
  StrategyValidationRow,
} from "@/lib/engine/strategyValidation";

const pct = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "—"
    : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
const num = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(digits);
const days = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}D`;
const price = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="border-b border-border bg-surface-strong px-3 py-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {note ? (
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{note}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function StrategyName({
  row,
}: {
  row: { upsideExitThreshold?: number; strategyLabel?: string; label?: string };
}) {
  const up = row.upsideExitThreshold;
  return (
    <span className="whitespace-nowrap font-medium">
      {up === 90
        ? "기본 추천 · ↑90"
        : up === 80
          ? "안정성 우선 · ↑80"
          : row.strategyLabel ?? row.label ?? "전략"}
    </span>
  );
}

function strategyUp(strategy: string) {
  return strategy.includes("u90") ? 90 : 80;
}

function CoreSummary({ row }: { row: StrategyValidationRow }) {
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <StrategyName row={row} />
        <span className="rounded border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground">
          70 / 40D / ↑{row.upsideExitThreshold} / ↓30
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[11px] sm:grid-cols-6">
        {[
          ["거래", row.trades.toLocaleString("ko-KR")],
          ["평균", pct(row.avgReturn)],
          ["중앙", pct(row.medianReturn)],
          ["승률", pct(row.winRate)],
          ["손익비", num(row.payoff)],
          ["평균보유", days(row.averageHoldingDays)],
        ].map(([label, value]) => (
          <div key={label}>
            <p className="text-[9px] text-muted-foreground">{label}</p>
            <p className="num font-semibold">{value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SegmentTable({
  rows,
  kind,
}: {
  rows: SegmentPerformanceRow[];
  kind: "year" | "regime";
}) {
  const ordered = [...rows].sort((a, b) => {
    if (a.segment !== b.segment) return a.segment.localeCompare(b.segment);
    return a.strategyLabel.localeCompare(b.strategyLabel);
  });
  const regimeLabel: Record<string, string> = {
    RISK_ON: "상승",
    NEUTRAL: "중립",
    RISK_OFF: "하락",
    UNKNOWN: "판정불가",
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-[11px]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left">{kind === "year" ? "연도" : "시장국면"}</th>
            <th className="px-2 py-1.5 text-left">전략</th>
            <th className="px-2 py-1.5 text-right">거래</th>
            <th className="px-2 py-1.5 text-right">평균</th>
            <th className="px-2 py-1.5 text-right">중앙</th>
            <th className="px-2 py-1.5 text-right">승률</th>
            <th className="px-2 py-1.5 text-right">평균손실</th>
            <th className="px-2 py-1.5 text-right">최악거래</th>
            <th className="px-2 py-1.5 text-right">손익비</th>
            <th className="px-2 py-1.5 text-right">평균보유</th>
            <th className="px-2 py-1.5 text-right">평균 MAE</th>
            {kind === "year" ? (
              <th className="px-2 py-1.5 text-right">연간 포트폴리오</th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => (
            <tr key={`${r.segment}-${r.strategy}`} className="border-t border-border/60">
              <td className="px-2 py-1.5 font-medium">
                {kind === "regime" ? regimeLabel[r.segment] ?? r.segment : r.segment}
              </td>
              <td className="px-2 py-1.5">
                <StrategyName
                  row={{ strategyLabel: r.strategyLabel, upsideExitThreshold: strategyUp(r.strategy) }}
                />
              </td>
              <td className="num px-2 py-1.5 text-right">{r.trades.toLocaleString("ko-KR")}</td>
              <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.avgReturn)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.medianReturn)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.winRate)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.avgLoss)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.worstReturn)}</td>
              <td className="num px-2 py-1.5 text-right">{num(r.payoff)}</td>
              <td className="num px-2 py-1.5 text-right">{days(r.averageHoldingDays)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.avgMae)}</td>
              {kind === "year" ? (
                <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.portfolioReturn)}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PortfolioTable({ rows }: { rows: PortfolioMetricRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-[11px]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left">상승청산</th>
            <th className="px-2 py-1.5 text-right">최대보유</th>
            <th className="px-2 py-1.5 text-right">거래</th>
            <th className="px-2 py-1.5 text-right">CAGR</th>
            <th className="px-2 py-1.5 text-right">MDD</th>
            <th className="px-2 py-1.5 text-right">Sharpe</th>
            <th className="px-2 py-1.5 text-right">총수익</th>
            <th className="px-2 py-1.5 text-right">평균보유</th>
            <th className="px-2 py-1.5 text-right">자금점유일</th>
            <th className="px-2 py-1.5 text-right">평균 동시포지션</th>
            <th className="px-2 py-1.5 text-right">최대 동시포지션</th>
          </tr>
        </thead>
        <tbody>
          {[...rows]
            .sort(
              (a, b) =>
                a.upsideExitThreshold - b.upsideExitThreshold ||
                a.maxHoldingDays - b.maxHoldingDays,
            )
            .map((r) => (
              <tr
                key={`${r.strategy}-${r.maxHoldingDays}`}
                className={`border-t border-border/60 ${r.maxHoldingDays === 40 ? "bg-primary/5" : ""}`}
              >
                <td className="px-2 py-1.5 font-medium">↑{r.upsideExitThreshold}</td>
                <td className="num px-2 py-1.5 text-right font-semibold">{r.maxHoldingDays}D</td>
                <td className="num px-2 py-1.5 text-right">{r.trades.toLocaleString("ko-KR")}</td>
                <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.cagr)}</td>
                <td className="num px-2 py-1.5 text-right">{pct(r.mdd)}</td>
                <td className="num px-2 py-1.5 text-right">{num(r.sharpe)}</td>
                <td className="num px-2 py-1.5 text-right">{pct(r.totalReturn)}</td>
                <td className="num px-2 py-1.5 text-right">{days(r.averageHoldingDays)}</td>
                <td className="num px-2 py-1.5 text-right">{pct(r.activeDayRate, 1)}</td>
                <td className="num px-2 py-1.5 text-right">{num(r.avgActivePositions, 1)}</td>
                <td className="num px-2 py-1.5 text-right">{r.peakActivePositions}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function OverlayTable({
  rows,
  title,
}: {
  rows: ExitOverlayComparisonRow[];
  title: "fixed" | "atr";
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1120px] text-[11px]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left">전략</th>
            <th className="px-2 py-1.5 text-left">추가 청산</th>
            <th className="px-2 py-1.5 text-right">거래</th>
            <th className="px-2 py-1.5 text-right">평균</th>
            <th className="px-2 py-1.5 text-right">중앙</th>
            <th className="px-2 py-1.5 text-right">승률</th>
            <th className="px-2 py-1.5 text-right">평균손실</th>
            <th className="px-2 py-1.5 text-right">최악거래</th>
            <th className="px-2 py-1.5 text-right">손익비</th>
            <th className="px-2 py-1.5 text-right">손절비율</th>
            <th className="px-2 py-1.5 text-right">CAGR</th>
            <th className="px-2 py-1.5 text-right">MDD</th>
            <th className="px-2 py-1.5 text-right">Sharpe</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.scenario}-${r.overlayId}`}
              className={`border-t border-border/60 ${r.overlayId === "none" ? "bg-muted/20" : ""}`}
            >
              <td className="px-2 py-1.5"><StrategyName row={r} /></td>
              <td className="whitespace-nowrap px-2 py-1.5 font-medium">{r.overlayLabel}</td>
              <td className="num px-2 py-1.5 text-right">{r.trades.toLocaleString("ko-KR")}</td>
              <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.avgReturn)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.medianReturn)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.winRate)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.avgLoss)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.worstReturn)}</td>
              <td className="num px-2 py-1.5 text-right">{num(r.payoff)}</td>
              <td className="num px-2 py-1.5 text-right">
                {pct(title === "fixed" ? r.priceStopRate : r.atrStopRate)}
              </td>
              <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.portfolioCagr)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.portfolioMdd)}</td>
              <td className="num px-2 py-1.5 text-right">{num(r.portfolioSharpe)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RegimeGateTable({ rows }: { rows: RegimeGateComparisonRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-[11px]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left">전략</th>
            <th className="px-2 py-1.5 text-left">진입 Gate</th>
            <th className="px-2 py-1.5 text-right">거래</th>
            <th className="px-2 py-1.5 text-right">평균</th>
            <th className="px-2 py-1.5 text-right">중앙</th>
            <th className="px-2 py-1.5 text-right">승률</th>
            <th className="px-2 py-1.5 text-right">CAGR</th>
            <th className="px-2 py-1.5 text-right">MDD</th>
            <th className="px-2 py-1.5 text-right">Sharpe</th>
            <th className="px-2 py-1.5 text-right">평균 동시포지션</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .slice()
            .sort((a, b) => strategyUp(a.strategy) - strategyUp(b.strategy) || a.gate.localeCompare(b.gate))
            .map((r) => (
              <tr key={`${r.strategy}-${r.gate}`} className={`border-t border-border/60 ${r.gate === "NO_RISK_OFF" ? "bg-primary/5" : ""}`}>
                <td className="px-2 py-1.5"><StrategyName row={{ strategyLabel: r.strategyLabel, upsideExitThreshold: strategyUp(r.strategy) }} /></td>
                <td className="px-2 py-1.5 font-medium">{r.gateLabel}</td>
                <td className="num px-2 py-1.5 text-right">{r.trades.toLocaleString("ko-KR")}</td>
                <td className="num px-2 py-1.5 text-right">{pct(r.avgReturn)}</td>
                <td className="num px-2 py-1.5 text-right">{pct(r.medianReturn)}</td>
                <td className="num px-2 py-1.5 text-right">{pct(r.winRate)}</td>
                <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.cagr)}</td>
                <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.mdd)}</td>
                <td className="num px-2 py-1.5 text-right font-semibold">{num(r.sharpe)}</td>
                <td className="num px-2 py-1.5 text-right">{num(r.avgActivePositions, 1)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function CrashStopTable({ rows }: { rows: CrashStopTradeRow[] }) {
  const ordered = [...rows].sort(
    (a, b) => b.exitDate.localeCompare(a.exitDate) || a.symbol.localeCompare(b.symbol),
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1320px] text-[10px]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left">전략</th>
            <th className="px-2 py-1.5 text-left">종목</th>
            <th className="px-2 py-1.5 text-left">시장</th>
            <th className="px-2 py-1.5 text-left">신호일</th>
            <th className="px-2 py-1.5 text-left">진입일</th>
            <th className="px-2 py-1.5 text-left">손절일</th>
            <th className="px-2 py-1.5 text-right">진입가</th>
            <th className="px-2 py-1.5 text-right">-40%선</th>
            <th className="px-2 py-1.5 text-right">실제체결</th>
            <th className="px-2 py-1.5 text-right">손절 수익</th>
            <th className="px-2 py-1.5 text-right">손절 없을 때</th>
            <th className="px-2 py-1.5 text-right">손절일 갭</th>
            <th className="px-2 py-1.5 text-right">보유중 최대 1D 변동</th>
            <th className="px-2 py-1.5 text-left">원자료 점검</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r, i) => (
            <tr key={`${r.strategy}-${r.symbol}-${r.signalDate}-${i}`} className="border-t border-border/60">
              <td className="px-2 py-1.5"><StrategyName row={{ strategyLabel: r.strategyLabel, upsideExitThreshold: r.upsideExitThreshold }} /></td>
              <td className="whitespace-nowrap px-2 py-1.5 font-medium">{r.name ? `${r.name} (${r.symbol})` : r.symbol}</td>
              <td className="px-2 py-1.5">{r.market}</td>
              <td className="px-2 py-1.5">{r.signalDate}</td>
              <td className="px-2 py-1.5">{r.entryDate}</td>
              <td className="px-2 py-1.5">{r.exitDate}</td>
              <td className="num px-2 py-1.5 text-right">{price(r.entryPrice)}</td>
              <td className="num px-2 py-1.5 text-right">{price(r.stopPrice)}</td>
              <td className="num px-2 py-1.5 text-right">{price(r.exitPrice)}{r.exitWasGap ? " · GAP" : ""}</td>
              <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.stopReturn)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.baselineReturn)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.exitOpenGapPct)}</td>
              <td className="num px-2 py-1.5 text-right">{pct(r.maxAbsCloseMovePct)}</td>
              <td className={`px-2 py-1.5 ${r.suspiciousPriceBreak ? "font-semibold text-warn" : "text-muted-foreground"}`}>
                {r.suspiciousPriceBreak ? "25%+ 가격단절 · 확인 필요" : "뚜렷한 가격단절 없음"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PositionCapTable({ rows }: { rows: PositionCapComparisonRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[940px] text-[11px]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left">전략</th>
            <th className="px-2 py-1.5 text-left">동시보유</th>
            <th className="px-2 py-1.5 text-right">체결 거래</th>
            <th className="px-2 py-1.5 text-right">슬롯부족 제외</th>
            <th className="px-2 py-1.5 text-right">CAGR</th>
            <th className="px-2 py-1.5 text-right">MDD</th>
            <th className="px-2 py-1.5 text-right">Sharpe</th>
            <th className="px-2 py-1.5 text-right">총수익</th>
            <th className="px-2 py-1.5 text-right">자금점유일</th>
            <th className="px-2 py-1.5 text-right">평균 보유종목</th>
            <th className="px-2 py-1.5 text-right">최대 보유종목</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .slice()
            .sort(
              (a, b) =>
                strategyUp(a.strategy) - strategyUp(b.strategy) ||
                (a.cap ?? 999) - (b.cap ?? 999),
            )
            .map((r) => (
              <tr key={`${r.strategy}-${r.capLabel}`} className={`border-t border-border/60 ${r.cap === 20 ? "bg-primary/5" : ""}`}>
                <td className="px-2 py-1.5"><StrategyName row={{ strategyLabel: r.strategyLabel, upsideExitThreshold: strategyUp(r.strategy) }} /></td>
                <td className="px-2 py-1.5 font-medium">{r.capLabel}</td>
                <td className="num px-2 py-1.5 text-right">{r.trades.toLocaleString("ko-KR")}</td>
                <td className="num px-2 py-1.5 text-right">{r.skippedForCapacity.toLocaleString("ko-KR")}</td>
                <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.cagr)}</td>
                <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.mdd)}</td>
                <td className="num px-2 py-1.5 text-right font-semibold">{num(r.sharpe)}</td>
                <td className="num px-2 py-1.5 text-right">{pct(r.totalReturn)}</td>
                <td className="num px-2 py-1.5 text-right">{pct(r.activeDayRate, 1)}</td>
                <td className="num px-2 py-1.5 text-right">{num(r.avgActivePositions, 1)}</td>
                <td className="num px-2 py-1.5 text-right">{r.peakActivePositions}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export function StrategyValidationResults({
  validation,
  horizons: _horizons,
}: {
  validation: StrategyValidation;
  horizons: number[];
}) {
  const [split, setSplit] = useState<"ALL" | "OOS">("ALL");

  const coreRows = useMemo(
    () =>
      validation.rows
        .filter((r) => r.split === split && r.market === "ALL" && r.maxHoldingDays === 40)
        .sort((a, b) => b.upsideExitThreshold - a.upsideExitThreshold),
    [validation.rows, split],
  );
  const yearly = validation.yearlyRows.filter((r) => r.split === split);
  const regimes = validation.regimeRows.filter((r) => r.split === split);
  const risks = validation.riskRows.filter((r) => r.split === split);
  const portfolios = validation.portfolioRows.filter((r) => r.split === split);
  const fixedStops = validation.fixedStopRows.filter((r) => r.split === split);
  const atrStops = validation.atrStopRows.filter((r) => r.split === split);
  const regimeGates = validation.regimeGateRows.filter((r) => r.split === split);
  const crashStops = validation.crashStopTrades.filter((r) => split === "ALL" || r.inOos);
  const positionCaps = validation.positionCapRows.filter((r) => r.split === split);

  return (
    <section className="space-y-4 rounded-lg border border-primary/30 bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">V6 대표전략 강건성 검증</h2>
            <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              FINAL CANDIDATES
            </span>
          </div>
          <p className="mt-1 max-w-4xl text-[11px] leading-relaxed text-muted-foreground">
            기술점수 배점은 1 / 1 / 1.5 / 1 / 0.5 / 2.5 / 2로 고정합니다. 매수는 70점 Onset,
            하락 청산은 30점 이탈, 최대 보유는 40D를 대표 규칙으로 두고 ↑90과 ↑80 두 전략을 비교합니다.
          </p>
        </div>
        <label className="text-[11px]" data-no-print>
          검증 구간{" "}
          <select
            className="rounded border border-border bg-card p-1"
            value={split}
            onChange={(e) => setSplit(e.target.value as "ALL" | "OOS")}
          >
            <option value="ALL">전체</option>
            <option value="OOS">OOS</option>
          </select>
        </label>
      </div>

      <div className="rounded-md border border-info/30 bg-info/5 p-3 text-[10px] leading-relaxed text-muted-foreground">
        <b className="text-foreground">↑90 전략의 거래 수가 ↑80보다 많을 수 있는 이유:</b>{" "}
        현재 V6 정의는 70점 Onset 당일 점수가 이미 선택한 상승청산선 이상이면 진입하지 않습니다.
        예를 들어 점수가 65→85로 뛰면 ↑80 전략은 신규진입을 건너뛰지만 ↑90 전략은 진입합니다.
        따라서 표의 “거래”는 80/90 도달 횟수가 아니라 각 규칙으로 실제 생성된 총 매매 횟수입니다.
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        {coreRows.map((row) => <CoreSummary key={row.scenario} row={row} />)}
      </div>

      <Panel title="1. 연도별 성과" note="신호 발생 연도 기준입니다. 특정 연도에만 ↓30 청산이 작동하는지 평균·중앙·승률·꼬리손실과 연간 동일가중 포트폴리오 수익을 함께 봅니다.">
        <SegmentTable rows={yearly} kind="year" />
      </Panel>

      <Panel title="2. 시장국면별 성과" note="진입 신호일의 시장국면(RISK_ON / NEUTRAL / RISK_OFF) 기준입니다. 상승·중립·하락장에서 대표 전략의 일관성을 확인합니다.">
        <SegmentTable rows={regimes} kind="regime" />
      </Panel>

      <Panel title="3. MDD · 평균 손실 · 손실 꼬리" note="MDD는 포트폴리오 고점에서 이후 저점까지의 최대 낙폭입니다. MAE는 개별 거래 보유 중 진입가 대비 최대 불리한 가격 변동이며 P5 MAE는 하위 5% 꼬리입니다.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[11px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left">전략</th>
                <th className="px-2 py-1.5 text-right">거래</th>
                <th className="px-2 py-1.5 text-right">평균손실</th>
                <th className="px-2 py-1.5 text-right">최악거래</th>
                <th className="px-2 py-1.5 text-right">평균 MAE</th>
                <th className="px-2 py-1.5 text-right">P5 MAE</th>
                <th className="px-2 py-1.5 text-right">평균 MFE</th>
                <th className="px-2 py-1.5 text-right">포트폴리오 MDD</th>
              </tr>
            </thead>
            <tbody>
              {risks.map((r) => (
                <tr key={r.strategy} className="border-t border-border/60">
                  <td className="px-2 py-1.5"><StrategyName row={{ strategyLabel: r.strategyLabel, upsideExitThreshold: strategyUp(r.strategy) }} /></td>
                  <td className="num px-2 py-1.5 text-right">{r.trades.toLocaleString("ko-KR")}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(r.avgLoss)}</td>
                  <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.worstReturn)}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(r.avgMae)}</td>
                  <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.tailMaeP5)}</td>
                  <td className="num px-2 py-1.5 text-right">{pct(r.avgMfe)}</td>
                  <td className="num px-2 py-1.5 text-right font-semibold">{pct(r.portfolioMdd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="4. 포트폴리오 성과 · 40D 검증" note="70 Onset / ↓30을 고정하고 최대 보유 20·30·40·50D를 비교합니다. 매 거래일 활성 종목을 동일가중하며 신호가 없는 날은 현금으로 둡니다.">
        <PortfolioTable rows={portfolios} />
      </Panel>

      <Panel title="5. 진입가 기준 고정 손절" note="대표 40D 전략 각각에 추가 가격 손절 -10% / -20% / -30% / -40%를 적용합니다. 갭 하락 시 손절선이 아니라 당일 시가 체결로 계산합니다.">
        <OverlayTable rows={fixedStops} title="fixed" />
      </Panel>

      <Panel title="6. ATR trailing stop" note="ATR은 최근 변동폭을 가격 단위로 측정합니다. Wilder ATR14 × 2 / 3 / 4를 사용하며, 고점이 올라가면 stop도 올라가되 다시 낮아지지는 않습니다. 당일 종가까지 확인된 정보는 다음 거래일부터 적용합니다.">
        <OverlayTable rows={atrStops} title="atr" />
      </Panel>

      <Panel title="7. RISK_OFF 신규진입 금지 검증" note="기존 포지션은 그대로 관리하고, 진입 신호일 시장국면이 RISK_OFF인 신규매수만 건너뜁니다. 제한 없음과 CAGR/MDD/Sharpe를 직접 비교합니다.">
        <RegimeGateTable rows={regimeGates} />
      </Panel>

      <Panel title="8. -40% catastrophe stop 실제 거래 점검" note="-40% 손절이 실제로 발생한 종목·날짜·가격을 표시합니다. 손절 없는 동일 신호의 최종수익도 함께 보여 줍니다. 25% 이상 일간 가격단절은 액면분할·권리락·조정주가 오류 등 원자료 확인 후보로 표시하며, 오류라고 단정하지 않습니다.">
        {crashStops.length ? (
          <CrashStopTable rows={crashStops} />
        ) : (
          <p className="p-3 text-[11px] text-muted-foreground">선택 구간에서 -40% 손절 체결이 없습니다.</p>
        )}
      </Panel>

      <Panel title="9. 실전 동시보유 10 / 20 / 30종목 제한" note="동시에 보유할 수 있는 종목 수를 제한합니다. 같은 날 슬롯보다 후보가 많으면 신호점수 → 최근 5D 점수상승 → 10D 점수상승 → 종목코드 순으로 우선 선택하며, 탈락 신호는 다음 날로 이월하지 않습니다. 제한 없음 행이 비교 기준입니다.">
        <PositionCapTable rows={positionCaps} />
      </Panel>

      <details data-no-print className="rounded border border-border p-3 text-[10px] text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">계산 가정 보기</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          {validation.assumptions.map((a) => <li key={a}>{a}</li>)}
          <li>왕복 비용: {validation.roundTripCostBps}bps</li>
          <li>OOS 시작: {validation.oosStart ?? "없음"}</li>
          <li>동시보유 표의 슬롯부족 제외 건수는 전체 시뮬레이션 경로에서 발생한 수치입니다.</li>
        </ul>
      </details>
    </section>
  );
}
