import { etfPartialEvidence } from "./etfPartialEvidence";
import { stockAssessmentDisplay, type StockAssessmentDisplay } from "./stockAssessmentDisplay";
import {
  getHeldOperationalExitSignal,
  isOperationalEntry,
  STRATEGY_CONFIG,
} from "./engine/operationalStrategy";
import { ETF_POLICY } from "./engine/etfStrategy";
import type { AnalysisResult } from "./engine/pipeline";
import type { UsProspectiveCache } from "./usProspectiveCloud";
import type { PortfolioSummary } from "./portfolioStoreCore";
import type { ActualExecution } from "./portfolioLedgers";
import {
  dashboardSectorLimit,
  type DashboardSectorContext,
  type DashboardSectorLimit,
} from "./dashboardOperationsSectorLimits";

export type DashboardMarket = "KOSPI" | "KOSDAQ" | "ETF" | "US";
export interface DashboardSignal {
  symbol: string;
  name: string;
  market: DashboardMarket;
  sector: string;
  sectorCode?: string | undefined;
  sectorLimit?: DashboardSectorLimit | undefined;
  date: string;
  price: number | null;
  score: number | null;
  priority: number;
  betaRank?: number | null;
  tkRank?: number | null;
  reason: string;
  onsetProfile?: import("./onsetProfile").OnsetProfile | null;
  assessment?: StockAssessmentDisplay | undefined;
  etfAssessment?: ReturnType<typeof etfPartialEvidence> | undefined;
  held?: boolean | undefined;
}
export interface DashboardIndexRow extends Omit<DashboardSignal, "reason"> {
  onset: boolean;
  observationDates?: string[];
  kospiEntry?: import("./engine/kospiEntryConfirmation").KospiEntrySnapshot | undefined;
  exitReason: string | null;
  etfEntry?:
    | Pick<
        import("./engine/etfStrategy").EtfStrategySnapshot,
        | "version"
        | "entryState"
        | "originDate"
        | "confirmationDate"
        | "confirmationIssues"
        | "averageTradingValue20"
        | "entryWeight"
        | "dataStatus"
        | "krxReferenceDate"
      >
    | undefined;
}
/** Server-side projection only. No OHLC history, score breakdowns, or shadow fields. */
export interface DashboardIndex {
  screeningCreatedAt?: string | undefined;
  date: string;
  rows: DashboardIndexRow[];
  tradeDates: string[];
}
export interface DashboardHolding {
  symbol: string;
  name: string;
  shares: number;
  firstEntryDate: string;
}
export interface DashboardMarketSignals {
  market: DashboardMarket;
  date: string | null;
  holdingsKnown: boolean;
  onsetCount: number | null;
  exitCount: number | null;
  onsets: DashboardSignal[];
  pendingCount?: number | null;
  pending?: DashboardSignal[];
  exits: DashboardSignal[];
  assessments?: DashboardSignal[];
}
export interface DashboardOperations {
  usOrderPreview?: import("./engine/usProspectiveOrderPreview").UsOrderPreviewBundle | null;
  markets: DashboardMarketSignals[];
  usPortfolio: { capital: number; summary: PortfolioSummary; unpricedPositions: number } | null;
  etfHoldings: { symbols: string[]; updatedAt: string } | null;
  warnings: string[];
}
export const DASHBOARD_MARKETS: DashboardMarket[] = ["KOSPI", "KOSDAQ", "ETF", "US"];
export const ETF_HOLDINGS_PATH = "portfolio/etf-holdings/latest.json";

const finite = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function projectKrDashboard(analysis: AnalysisResult): DashboardIndex {
  const rows: DashboardIndexRow[] = [];
  for (const r of analysis.rows) {
    const etf = r.instrument.instrumentType === "ETF";
    const market = etf ? "ETF" : r.instrument.market;
    if (market !== "ETF" && market !== "KOSPI" && market !== "KOSDAQ") continue;
    if (!etf && r.instrument.instrumentType !== "STOCK") continue;
    const strategy = r.etfStrategy;
    const currentEtf = strategy?.version === ETF_POLICY.version;
    rows.push({
      symbol: r.instrument.symbol,
      name: r.instrument.name,
      market,
      sector: r.instrument.sectorName ?? "-",
      sectorCode: r.instrument.sectorCode,
      date: etf
        ? (strategy?.date ?? analysis.asOfDate)
        : (r.snapshot.tradeDate ?? analysis.asOfDate),
      ...(analysis.observationDates?.[r.instrument.symbol]
        ? { observationDates: analysis.observationDates[r.instrument.symbol] }
        : {}),
      kospiEntry: r.kospiEntry,
      assessment: etf
        ? undefined
        : stockAssessmentDisplay(r, analysis.asOfDate, analysis.tradeDates),
      etfAssessment: etf ? etfPartialEvidence(r, analysis.asOfDate) : undefined,
      onsetProfile: etf ? null : (r.onsetProfile ?? null),
      price: finite(r.snapshot.close),
      score: finite(etf ? strategy?.score : r.operatingScore10),
      priority: finite(etf ? strategy?.averageTradingValue20 : r.priority.points) ?? 0,
      etfEntry:
        etf && strategy
          ? {
              version: strategy.version,
              dataStatus: strategy.dataStatus,
              krxReferenceDate: strategy.krxReferenceDate,
              entryState: strategy.entryState,
              originDate: strategy.originDate,
              confirmationDate: strategy.confirmationDate,
              confirmationIssues: strategy.confirmationIssues,
              averageTradingValue20: strategy.averageTradingValue20,
              entryWeight: strategy.entryWeight,
            }
          : undefined,
      onset: etf
        ? Boolean(
            currentEtf &&
            strategy?.eligible &&
            strategy.onset &&
            strategy.dataStatus !== "krx_batch_pending",
          )
        : isOperationalEntry(r, analysis.asOfDate),
      exitReason: etf
        ? currentEtf
          ? (strategy?.exit ?? null)
          : null
        : getHeldOperationalExitSignal(market, r.operatingScore10, r.scoreDelta1d),
    });
  }
  return { date: analysis.asOfDate, rows, tradeDates: analysis.tradeDates };
}

export function projectUsDashboard(cache: UsProspectiveCache): DashboardIndex {
  return {
    date: cache.analysis.date,
    tradeDates: [],
    rows: cache.analysis.rows
      .filter((r) => r.symbol !== "SPY")
      .map((r) => ({
        symbol: r.symbol,
        name: r.name,
        market: "US",
        sector: r.sector ?? "-",
        date: r.date || cache.analysis.date,
        price: finite(r.close),
        score: finite(r.coreRank),
        priority: finite(r.coreRank) ?? -1,
        betaRank: finite(r.betaRank),
        tkRank: finite(r.tkRank),
        onset: r.a0Entry === true,
        // Read frozen A0 results. Never infer A0 from primarySignal, A2, B3, or Onset80 alone.
        exitReason:
          r.a0Exit || r.a0BetaExit
            ? [
                r.coreRank === null ? "Core 산정 불가" : r.coreRank < 0.7 ? "Core 상위 30% 밖" : "",
                r.a0BetaExit ? "Beta 상위 40% 밖 3거래일 연속" : "",
              ]
                .filter(Boolean)
                .join(" · ") || "A0 청산 신호"
            : null,
      })),
  };
}

export function exitLabel(reason: string): string {
  return (
    (
      {
        UP95: "9.5점 상향돌파",
        UP90: "9.0점 상향 재돌파",
        DOWN30: "3.0점 하향 이탈",
        H60: "최대 보유 60거래일",
        MA60: "기초지수 MA60 하회",
        DATA_UNAVAILABLE: "데이터 오류 · 청산 점검",
      } as Record<string, string>
    )[reason] ?? reason
  );
}

/** Count the complete projection first; pagination belongs exclusively to the UI. */
export function soldSymbolsSinceSignal(
  executions: Pick<ActualExecution<string>, "symbol" | "market" | "date" | "side" | "shares">[],
  market: DashboardMarket,
  signalDate: string,
): Set<string> {
  // A sale consumes the same dated entry signal, including a prior-close signal sold
  // the following morning. A newer screening date can produce a fresh entry again.
  return new Set(
    executions
      .filter(
        (e) => e.market === market && e.side === "SELL" && e.shares > 0 && e.date >= signalDate,
      )
      .map((e) => e.symbol),
  );
}

export function marketSignals(
  index: DashboardIndex | null,
  market: DashboardMarket,
  holdings: DashboardHolding[] | null,
  executions: Pick<
    ActualExecution<string>,
    "symbol" | "market" | "date" | "side" | "shares"
  >[] = [],
  sectorContext: DashboardSectorContext | null = null,
): DashboardMarketSignals {
  const result: DashboardMarketSignals = {
    market,
    date: index?.date ?? null,
    holdingsKnown: holdings !== null,
    onsetCount: index ? 0 : null,
    exitCount: index && holdings !== null ? 0 : null,
    onsets: [],
    pendingCount: index ? 0 : null,
    pending: [],
    exits: [],
    assessments: [],
  };
  if (!index) return result;
  const held = new Map((holdings ?? []).filter((p) => p.shares > 0).map((p) => [p.symbol, p]));
  const sold = soldSymbolsSinceSignal(executions, market, index.date);
  const rows = new Map(index.rows.filter((r) => r.market === market).map((r) => [r.symbol, r]));
  const dates = [...new Set(index.tradeDates)].filter((d) => d <= index.date).sort();
  for (const row of rows.values()) {
    if (row.assessment || row.etfAssessment) {
      const isHeld = held.has(row.symbol);
      result.assessments!.push({
        ...row,
        held: isHeld,
        reason: isHeld ? "보유 · 추가 진입 제외" : holdings === null ? "보유 미확인" : "미보유",
      });
    }
    // A stale individual quote cannot create today's signal.
    if (row.date !== index.date) continue;
    const holding = held.get(row.symbol);
    const consumed =
      (market === "ETF" && row.etfEntry?.originDate) ||
      (market === "KOSPI" && row.kospiEntry?.originDate)
        ? soldSymbolsSinceSignal(
            executions,
            market,
            (row.kospiEntry?.originDate ?? row.etfEntry?.originDate)!,
          ).has(row.symbol)
        : sold.has(row.symbol);
    const sectorLimit = dashboardSectorLimit(row, sectorContext);
    if (market === "KOSPI" && row.kospiEntry?.state === "pending" && !holding && !consumed)
      result.pending!.push({
        ...row,
        sectorLimit,
        reason: "8.0 원신호 · 다음 거래일 종가 확인 대기",
      });
    if (
      market === "ETF" &&
      row.etfEntry?.version === ETF_POLICY.version &&
      row.etfEntry.entryState === "pending" &&
      row.etfEntry.dataStatus === "ready" &&
      row.etfEntry.originDate === index.date &&
      !holding &&
      !consumed
    )
      result.pending!.push({ ...row, reason: "M0 80점 원신호 · 다음 거래일 종가 확인 대기" });
    if (row.onset && !holding && !consumed) {
      result.onsets.push({
        ...row,
        sectorLimit,
        reason:
          market === "US"
            ? "A0 신규 진입"
            : market === "ETF"
              ? "진입 준비 · 다음 거래일 시가 진입"
              : market === "KOSPI"
                ? "진입 준비 · 다음 거래 가능 시가 진입 대기"
                : "8.0 원신호",
      });
    }
    if (!holding || holding.firstEntryDate > index.date) continue;
    let reason = row.exitReason;
    if (
      (market === "KOSPI" || market === "KOSDAQ") &&
      holding.firstEntryDate &&
      (row.observationDates ?? (index.date < "2026-10-12" ? dates : [])).filter(
        (d) => d >= holding.firstEntryDate && d <= index.date,
      ).length >= STRATEGY_CONFIG[market].maxHoldingDays
    ) {
      reason = reason ? `${exitLabel(reason)} · ${exitLabel("H60")}` : "H60";
    }
    if (reason) result.exits.push({ ...row, reason: exitLabel(reason) });
  }
  result.assessments!.sort(
    (a, b) =>
      Number(b.held) - Number(a.held) ||
      Number(b.assessment?.rawOnset) - Number(a.assessment?.rawOnset) ||
      (b.assessment?.score ?? -Infinity) - (a.assessment?.score ?? -Infinity) ||
      a.symbol.localeCompare(b.symbol),
  );
  result.onsets.sort(compareDashboardCandidates);
  result.exits.sort((a, b) => a.symbol.localeCompare(b.symbol));
  result.pending!.sort(compareDashboardCandidates);
  result.pendingCount = result.pending!.length;
  result.onsetCount = result.onsets.length;
  if (holdings !== null) result.exitCount = result.exits.length;
  return result;
}

export function validateEtfHoldingSymbols(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > 100 ||
    input.some((s) => typeof s !== "string" || !/^[0-9A-Z]{6}$/.test(s))
  ) {
    throw new Error("ETF 보유종목은 6자리 종목코드로 입력해 주세요.");
  }
  return [...new Set(input as string[])].sort();
}

/** Same-market allocation order; KR mixed-book candidates compete across KOSPI/KOSDAQ. */
export function compareDashboardCandidates(a: DashboardSignal, b: DashboardSignal) {
  const group = (market: DashboardMarket) => (market === "US" ? 2 : market === "ETF" ? 1 : 0);
  const different = group(a.market) - group(b.market);
  if (different) return different;
  return (
    (a.market !== "ETF" ? (b.score ?? -Infinity) - (a.score ?? -Infinity) : 0) ||
    (a.market === "US"
      ? (b.betaRank ?? -Infinity) - (a.betaRank ?? -Infinity) ||
        (b.tkRank ?? -Infinity) - (a.tkRank ?? -Infinity)
      : 0) ||
    b.priority - a.priority ||
    a.symbol.localeCompare(b.symbol)
  );
}
