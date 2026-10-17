import {
  OPERATIONAL_SIGNAL_START,
  isOperationalSignalDate,
  isOperationalSignalOrigin,
  operationalEntryStartNotice,
} from "./operationalSignalStart";
import { etfPartialEvidence } from "./etfPartialEvidence";
import { validDate } from "./ledger/date";
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
  entryDecision?: import("./actualEntryDecisions").EntryDecision;
  krxReviewReference?: import("./krxReviewReference").KrxReviewReference | undefined;
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
  signalOriginDate?: string | undefined;
  actualQuantity?: number | undefined;
  actualEntryDate?: string | undefined;
  actualState?: "READY" | "HELD" | "CONSUMED" | "UNKNOWN" | undefined;
  operationalEntryNotice?: string | null | undefined;
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
  sourceCollectedAt?: string | undefined;
  sourceRegisteredAt?: string | undefined;
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
  notPurchased?: DashboardSignal[];
  market: DashboardMarket;
  date: string | null;
  holdingsKnown: boolean;
  conditionCount?: number | null;
  conditions?: DashboardSignal[];
  onsetCount: number | null;
  exitCount: number | null;
  onsets: DashboardSignal[];
  /** Current strategy-target ETFs missing current data; distinct from next-session confirmation. */
  dataUnconfirmedCount?: number | null;
  pendingCount?: number | null;
  pending?: DashboardSignal[];
  exits: DashboardSignal[];
  assessments?: DashboardSignal[];
}
export interface DashboardActualPoolSummary {
  currency: import("./newActualPortfolio").NewActualCurrency;
  fundingStatus: import("./newActualPortfolio").NewActualPool["fundingStatus"];
  netContributions: string | null;
  cash: string | null;
  openPositions: number;
  assetPositions: Record<import("./newActualPortfolio").NewActualAsset, number>;
}
export interface DashboardOperations {
  publications?: {
    KR: { collectedAt: string | null; registeredAt: string | null; calculatedAt: string | null };
    US: { collectedAt: string | null; registeredAt: string | null; calculatedAt: string | null };
  };
  actualAllocation?: Awaited<
    ReturnType<typeof import("./dashboardActualAllocation.server").projectDashboardActualAllocation>
  > | null;
  newActualPools?: { KRW: DashboardActualPoolSummary; USD: DashboardActualPoolSummary } | null;
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
      krxReviewReference: r.krxReviewReference,
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
      // Missing inputs are diagnostics, not an observed sell signal. This is
      // consistent with the adopted ETF engine, which only exits on MA60.
      // Actual verified E4 signals are attached independently by the server.
      exitReason: etf
        ? currentEtf && strategy?.exit === "MA60"
          ? "MA60"
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
        DATA_UNAVAILABLE: "자료 확인 대기 · 청산 판단 보류",
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
  signalStartDate?: string,
): DashboardMarketSignals {
  const result: DashboardMarketSignals = {
    market,
    date: index?.date ?? null,
    holdingsKnown: holdings !== null,
    conditionCount: index ? 0 : null,
    conditions: [],
    onsetCount: index && holdings !== null ? 0 : null,
    exitCount: index && holdings !== null ? 0 : null,
    onsets: [],
    pendingCount: index ? 0 : null,
    pending: [],
    exits: [],
    assessments: [],
    ...(market === "ETF" ? { dataUnconfirmedCount: null } : {}),
  };
  if (
    !index ||
    (signalStartDate &&
      (signalStartDate === OPERATIONAL_SIGNAL_START
        ? !isOperationalSignalDate(index.date)
        : !validDate(index.date) || index.date < signalStartDate))
  )
    return result;
  const held = new Map((holdings ?? []).filter((p) => p.shares > 0).map((p) => [p.symbol, p]));
  const sold = soldSymbolsSinceSignal(executions, market, index.date);
  const rows = new Map(index.rows.filter((r) => r.market === market).map((r) => [r.symbol, r]));
  // Missing/legacy/stale evidence cannot establish an observed zero. Counts refer to
  // the displayed analysis session, never the browser clock or a holdings estimate.
  if (market === "ETF" && validDate(index.date) && rows.size > 0) {
    const etfs = [...rows.values()];
    if (
      etfs.every(
        (row) =>
          row.date === index.date &&
          row.etfAssessment?.current &&
          row.etfEntry?.version === ETF_POLICY.version,
      )
    ) {
      result.dataUnconfirmedCount = etfs.filter(
        (row) =>
          row.etfAssessment?.isStrategyTarget &&
          (row.etfEntry?.dataStatus === "incomplete" ||
            row.etfEntry?.dataStatus === "krx_batch_pending"),
      ).length;
    }
  }
  const dates = [...new Set(index.tradeDates)].filter((d) => d <= index.date).sort();
  const previousSession = dates.at(-1) === index.date ? dates.at(-2) : undefined;
  for (const row of rows.values()) {
    if (row.assessment || row.etfAssessment) {
      const isHeld = held.has(row.symbol);
      result.assessments!.push({
        ...row,
        held: isHeld,
        operationalEntryNotice: signalStartDate
          ? operationalEntryStartNotice(
              index.date,
              row.kospiEntry?.originDate,
              row.kospiEntry?.state === "confirmed" || row.kospiEntry?.state === "pending",
            )
          : null,
        reason: isHeld ? "보유 · 추가 진입 제외" : holdings === null ? "보유 미확인" : "미보유",
      });
    }
    // A stale individual quote cannot create today's signal.
    if (row.date !== index.date) continue;
    const holding = held.get(row.symbol);
    const originDate =
      market === "KOSPI"
        ? row.kospiEntry?.originDate
        : market === "ETF"
          ? row.etfEntry?.originDate
          : row.date;
    // Confirmation after the restart cannot revive a pre-start (or unknown) origin.
    // This is a website action-list boundary, not a change to the strategy engine.
    const entryInSeries =
      !signalStartDate ||
      (signalStartDate === OPERATIONAL_SIGNAL_START
        ? isOperationalSignalOrigin(index.date, originDate)
        : Boolean(
            originDate &&
            validDate(originDate) &&
            originDate >= signalStartDate &&
            originDate <= index.date,
          ));
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
    if (
      entryInSeries &&
      market === "KOSPI" &&
      row.kospiEntry?.state === "pending" &&
      !holding &&
      !consumed
    )
      result.pending!.push({
        ...row,
        sectorLimit,
        reason: "8.0 원신호 · 다음 거래일 종가 확인 대기",
      });
    // The engine preserves a previously observed crossover as data_pending while
    // the confirmation session's KRX batch is unpublished. This is still the same
    // waiting setup, not a new onset or a confirmed order. Require the immediately
    // preceding session and matching current evidence; never revive an older setup.
    const etfKrxConfirmationPending =
      market === "ETF" &&
      row.etfEntry?.entryState === "data_pending" &&
      row.etfEntry.dataStatus === "krx_batch_pending" &&
      row.etfAssessment?.current === true &&
      row.etfAssessment.krxPending === true &&
      previousSession !== undefined &&
      validDate(previousSession) &&
      row.etfAssessment.previousDate === previousSession &&
      row.etfAssessment.previousScore !== null &&
      row.etfAssessment.previousScore >= ETF_POLICY.entryScore &&
      row.etfEntry.originDate === previousSession &&
      row.etfEntry.krxReferenceDate === previousSession &&
      row.etfEntry.confirmationDate === index.date &&
      !row.onset &&
      row.exitReason === null;
    if (
      entryInSeries &&
      market === "ETF" &&
      row.etfEntry?.version === ETF_POLICY.version &&
      ((row.etfEntry.entryState === "pending" &&
        row.etfEntry.dataStatus === "ready" &&
        row.etfEntry.originDate === index.date) ||
        etfKrxConfirmationPending) &&
      !holding &&
      !consumed
    )
      result.pending!.push({
        ...row,
        signalOriginDate: row.etfEntry.originDate ?? undefined,
        reason: etfKrxConfirmationPending
          ? "KRX 자료 대기 · 기존 확인대기 유지"
          : "M0 80점 원신호 · 다음 거래일 종가 확인 대기",
      });
    if (entryInSeries && row.onset) {
      const actualState =
        holdings === null ? "UNKNOWN" : holding ? "HELD" : consumed ? "CONSUMED" : "READY";
      result.conditions!.push({
        ...row,
        sectorLimit,
        held: Boolean(holding),
        actualState,
        signalOriginDate: originDate ?? undefined,
        actualQuantity: holding?.shares,
        actualEntryDate: holding?.firstEntryDate,
        reason:
          actualState === "HELD"
            ? "진입 조건 충족 · 실제 보유 중, 추가 진입 제외"
            : actualState === "CONSUMED"
              ? "진입 조건 충족 · 실제 매도로 소진된 신호, 새 원신호 대기"
              : actualState === "UNKNOWN"
                ? "진입 조건 충족 · 실제 보유정보 미확인"
                : "진입 조건 충족 · 실제 미보유 후보",
      });
    }
    if (entryInSeries && row.onset && holdings !== null && !holding && !consumed) {
      result.onsets.push({
        ...row,
        actualState: "READY",
        signalOriginDate: originDate ?? undefined,
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
    if (reason)
      result.exits.push({
        ...row,
        actualQuantity: holding.shares,
        actualEntryDate: holding.firstEntryDate,
        reason: exitLabel(reason),
      });
  }
  result.assessments!.sort(
    (a, b) =>
      Number(b.held) - Number(a.held) ||
      Number(b.assessment?.rawOnset) - Number(a.assessment?.rawOnset) ||
      (b.assessment?.score ?? -Infinity) - (a.assessment?.score ?? -Infinity) ||
      a.symbol.localeCompare(b.symbol),
  );
  result.conditions!.sort(compareDashboardCandidates);
  result.conditionCount = result.conditions!.length;
  result.onsets.sort(compareDashboardCandidates);
  result.exits.sort((a, b) => a.symbol.localeCompare(b.symbol));
  result.pending!.sort(compareDashboardCandidates);
  result.pendingCount = result.pending!.length;
  if (holdings !== null) result.onsetCount = result.onsets.length;
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
