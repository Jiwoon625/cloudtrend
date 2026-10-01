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

export type DashboardMarket = "KOSPI" | "KOSDAQ" | "ETF" | "US";
export interface DashboardSignal {
  symbol: string;
  name: string;
  market: DashboardMarket;
  sector: string;
  date: string;
  price: number | null;
  score: number | null;
  priority: number;
  reason: string;
}
export interface DashboardIndexRow extends Omit<DashboardSignal, "reason"> {
  onset: boolean;
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
}
export interface DashboardOperations {
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
      date: etf
        ? (strategy?.date ?? analysis.asOfDate)
        : (r.snapshot.tradeDate ?? analysis.asOfDate),
      kospiEntry: r.kospiEntry,
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
  };
  if (!index) return result;
  const held = new Map((holdings ?? []).filter((p) => p.shares > 0).map((p) => [p.symbol, p]));
  const sold = soldSymbolsSinceSignal(executions, market, index.date);
  const rows = new Map(index.rows.filter((r) => r.market === market).map((r) => [r.symbol, r]));
  const dates = [...new Set(index.tradeDates)].filter((d) => d <= index.date).sort();
  for (const row of rows.values()) {
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
    if (market === "KOSPI" && row.kospiEntry?.state === "pending" && !holding && !consumed)
      result.pending!.push({ ...row, reason: "8.0 Onset · 다음 거래일 종가 확인 대기" });
    if (row.onset && !holding && !consumed) {
      result.onsets.push({
        ...row,
        reason:
          market === "US"
            ? "A0 신규 진입"
            : market === "ETF"
              ? "하루 확인 완료 · 다음 거래일 시가 진입"
              : market === "KOSPI"
                ? "하루·RS 확인 완료 · 다음 거래 가능 시가 진입 대기"
                : "8.0 Onset",
      });
    }
    if (!holding || holding.firstEntryDate > index.date) continue;
    let reason = row.exitReason;
    if (
      (market === "KOSPI" || market === "KOSDAQ") &&
      holding.firstEntryDate &&
      dates.filter((d) => d >= holding.firstEntryDate).length >=
        STRATEGY_CONFIG[market].maxHoldingDays
    ) {
      reason = reason ? `${exitLabel(reason)} · ${exitLabel("H60")}` : "H60";
    }
    if (reason) result.exits.push({ ...row, reason: exitLabel(reason) });
  }
  result.onsets.sort((a, b) => b.priority - a.priority || a.symbol.localeCompare(b.symbol));
  result.exits.sort((a, b) => a.symbol.localeCompare(b.symbol));
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
