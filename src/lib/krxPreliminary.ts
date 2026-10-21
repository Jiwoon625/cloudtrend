import type { AnalysisResult, ScreeningRow } from "./engine/pipeline";
import type { MarketDataset } from "./engine/dataset";
import type { DailyPrice } from "./engine/types";
import { ETF_MAPPING, ETF_POLICY, isEtfStrategyAssetClass } from "./engine/etfStrategy";
import type { KrxReviewReference } from "./krxReviewReference";

/**
 * Read-only evening calculation using the latest *actually dated* KRX observations.
 * This is deliberately not an entry signal, official M0, valuation mark, order or
 * MODEL input. Do not write these estimates to executable price bars.
 */
export interface KrxPreliminary {
  kind: "STOCK" | "ETF";
  priceDate: string;
  referenceDate: string;
  status: "ESTIMATE" | "INCOMPLETE";
  marketCap: number | null;
  marketCapDate: string | null;
  stockUniverse?: "PASS" | "FAIL" | "UNKNOWN";
  stockThreshold?: number;
  preliminarySizePoints?: number;
  averageTradingValue20?: number | null;
  tradingValueThrough?: string | null;
  healthPoints?: number | null;
  m0?: number | null;
  previousM0?: number | null;
  preliminaryOnset?: boolean | null;
  underlyingClose?: number | null;
  underlyingMa60?: number | null;
  underlyingDate?: string | null;
  issues: string[];
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const nonnegative = (n: unknown): n is number => finite(n) && n >= 0;

/** Only a real exchange session, never a calendar-day subtraction. */
export function previousKrxSession(dates: readonly string[], asOfDate: string): string | null {
  const ordered = [...new Set(dates.filter((d) => d <= asOfDate))].sort();
  return ordered.at(-1) === asOfDate ? (ordered.at(-2) ?? null) : null;
}

function exactTradeValue(bar: DailyPrice | undefined): number | null {
  return bar?.tradingValueSource === "KRX_ETF" && nonnegative(bar.etfTradingValue)
    ? bar.etfTradingValue
    : null;
}
function exactUnderlying(bar: DailyPrice | undefined): number | null {
  return bar?.etfUnderlyingIndexSource === "KRX_ETF" && positive(bar.etfUnderlyingIndexClose)
    ? bar.etfUnderlyingIndexClose
    : null;
}
function recentValues(
  bars: readonly DailyPrice[],
  dates: readonly string[],
  count: number,
  observation: (bar: DailyPrice | undefined) => number | null,
): number[] | null {
  if (dates.length < count) return null;
  const wanted = dates.slice(-count);
  const byDate = new Map(
    bars.filter((b) => b.tradeDate <= wanted[wanted.length - 1]!).map((b) => [b.tradeDate, b]),
  );
  const values = wanted.map((d) => observation(byDate.get(d)));
  return values.every((v): v is number => v !== null) ? (values as number[]) : null;
}

export function calculateKrxPreliminary(
  row: ScreeningRow,
  analysis: Pick<AnalysisResult, "asOfDate" | "tradeDates" | "scoringConfig">,
  dataset: MarketDataset,
  reference: KrxReviewReference,
): KrxPreliminary | undefined {
  if (!dataset.isLive || !row.snapshot || row.snapshot.tradeDate !== analysis.asOfDate) return;
  const previous = previousKrxSession(analysis.tradeDates, analysis.asOfDate);
  if (!previous) return;
  const cap = reference.fields.marketCap;
  const marketCapDate = cap?.date === analysis.asOfDate || cap?.date === previous ? cap.date : null;
  const marketCap = marketCapDate && positive(cap?.value) ? (cap!.value as number) : null;
  const carried = marketCapDate === previous;
  const issues: string[] = [];
  if (row.instrument.instrumentType === "STOCK") {
    // A confirmed current-session cap is handled by the existing official engine.
    if (row.marketCap !== null) return;
    if (!carried) issues.push("직전 정규거래일 KRX 시가총액 근거 없음");
    const knownFailure = row.failedRules.length > 0;
    const otherPending = (row.pendingRules ?? []).some((p) => !p.includes("시가총액"));
    const threshold = analysis.scoringConfig.universe.minMarketCap;
    const stockUniverse =
      marketCap === null || otherPending
        ? "UNKNOWN"
        : knownFailure || marketCap < threshold
          ? "FAIL"
          : "PASS";
    if (knownFailure) issues.push("다른 확정 실격 조건 유지");
    if (otherPending) issues.push("시가총액 이외의 필수조건도 미확정");
    if (marketCap !== null && marketCap < threshold) issues.push("직전 시가총액이 최소기준 미달");
    return {
      kind: "STOCK",
      priceDate: analysis.asOfDate,
      referenceDate: previous,
      status: marketCap === null ? "INCOMPLETE" : "ESTIMATE",
      marketCap,
      marketCapDate,
      stockUniverse,
      stockThreshold: threshold,
      preliminarySizePoints:
        marketCap !== null && marketCap >= analysis.scoringConfig.priority.minMarketCap
          ? analysis.scoringConfig.priority.sizePoints
          : 0,
      issues,
    };
  }

  if (row.instrument.instrumentType !== "ETF") return;
  const strategy = row.etfStrategy;
  if (!strategy || strategy.version !== ETF_POLICY.version || strategy.date !== analysis.asOfDate)
    return;
  const currentBar = dataset.bars[row.instrument.symbol]?.find(
    (b) => b.tradeDate === analysis.asOfDate,
  );
  if (!currentBar || !positive(currentBar.close)) return;
  const currentCap = marketCapDate === analysis.asOfDate;
  const target =
    isEtfStrategyAssetClass(ETF_MAPPING[row.instrument.symbol]) &&
    !row.instrument.isLeveraged &&
    !row.instrument.isInverse;
  // Do not relabel fully calculated morning results as preliminary.
  if (strategy.dataStatus === "ready" && currentCap && exactTradeValue(currentBar) !== null) return;
  if (!target) return;
  const bars = (dataset.bars[row.instrument.symbol] ?? []).filter(
    (b) => b.tradeDate <= analysis.asOfDate,
  );
  const calendar = [...new Set(dataset.tradeDates.filter((d) => d <= analysis.asOfDate))].sort();
  if (calendar.at(-1) !== analysis.asOfDate) return;
  const current20 = recentValues(bars, calendar, 20, exactTradeValue);
  const priorCalendar = calendar.filter((d) => d <= previous);
  const prior20 = recentValues(bars, priorCalendar, 20, exactTradeValue);
  // A current real 20-session window always has precedence. Otherwise use the
  // preceding 20 *observed* sessions. Never duplicate yesterday as today's row.
  const values20 = current20 ?? prior20;
  const tradingValueThrough = current20 ? analysis.asOfDate : prior20 ? previous : null;
  const averageTradingValue20 =
    values20 === null ? null : values20.reduce((sum, value) => sum + value, 0) / 20;
  if (!marketCapDate) issues.push("전일/당일 KRX 시가총액 근거 없음");
  if (averageTradingValue20 === null) issues.push("연속 20거래일 KRX 거래대금 근거 없음");
  const lastUnderlying = reference.fields.underlyingIndexClose;
  const underlyingDate =
    lastUnderlying?.date === previous || lastUnderlying?.date === analysis.asOfDate
      ? lastUnderlying.date
      : null;
  const underlyingClose =
    underlyingDate && positive(lastUnderlying?.value) ? (lastUnderlying!.value as number) : null;
  const underlyingCalendar = calendar.filter((d) => d <= (underlyingDate ?? previous));
  const values60 = recentValues(bars, underlyingCalendar, 60, exactUnderlying);
  const underlyingMa60 = values60 ? values60.reduce((sum, value) => sum + value, 0) / 60 : null;
  if (underlyingClose === null || underlyingMa60 === null)
    issues.push("기초지수 마지막 확정 관측/MA60 이력 부족 · 청산 예측 불가");

  const health =
    marketCap !== null && averageTradingValue20 !== null
      ? (((marketCap >= 50e9 ? 20 : 0) +
          (marketCap >= 100e9 ? 10 : 0) +
          (averageTradingValue20 >= 1e9 ? 20 : 0) +
          10) /
          60) *
        100
      : null;
  const numericScore = (value: number | null): number | null =>
    finite(value) && value >= 0 && value <= 100 ? value : null;
  const technical = numericScore(strategy.technical);
  const priority = numericScore(strategy.priority);
  const environment = numericScore(strategy.environment);
  if (technical === null || priority === null || environment === null)
    issues.push("당일 기술·Priority·환경점수 중 미확정 항목 존재");
  const m0 =
    health !== null && technical !== null && priority !== null && environment !== null
      ? technical * 0.625 + priority * 0.075 + health * 0.15 + environment * 0.15
      : null;
  // True onset requires the previous *complete* official M0. If unknown, do
  // not convert the first observation or an earlier pending origin to onset.
  const previousM0 =
    strategy.previousDate === previous ? numericScore(strategy.previousScore) : null;
  const preliminaryOnset =
    m0 !== null && previousM0 !== null
      ? previousM0 < ETF_POLICY.entryScore && m0 >= ETF_POLICY.entryScore
      : null;
  if (previousM0 === null) issues.push("직전 확정 M0 미확인 · 신규 돌파 판정 불가");
  if (carried && marketCap !== null && Math.abs(marketCap - 50e9) / 50e9 < 0.05)
    issues.push("시총 500억원 경계 ±5% · 다음 아침 재검증");
  if (carried && marketCap !== null && Math.abs(marketCap - 100e9) / 100e9 < 0.05)
    issues.push("시총 1,000억원 경계 ±5% · 다음 아침 재검증");
  if (m0 !== null && Math.abs(m0 - ETF_POLICY.entryScore) < 2)
    issues.push("M0 80점 경계 ±2점 · 다음 아침 재검증");
  return {
    kind: "ETF",
    priceDate: analysis.asOfDate,
    referenceDate: previous,
    status: m0 === null ? "INCOMPLETE" : "ESTIMATE",
    marketCap,
    marketCapDate,
    averageTradingValue20,
    tradingValueThrough,
    healthPoints: health === null ? null : health * 0.15,
    m0,
    previousM0,
    preliminaryOnset,
    underlyingClose,
    underlyingMa60,
    underlyingDate,
    issues,
  };
}
