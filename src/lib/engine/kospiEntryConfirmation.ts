import type { MarketDataset } from "./dataset";
import type { DailyPrice } from "./types";
import { computeIndicators } from "./indicators";
import { ALL_AVAILABLE, evaluateUniverse, type ScoringConfig } from "./scoring";
import { historicalInstrumentScore } from "./historicalInstrumentScore";

/** Adopted 2026-10-02 KST. This is a prospective entry policy, not a backtest rewrite. */
export const KOSPI_ENTRY_POLICY = {
  version: "kospi-e8-confirm1-rsaccel-up95-v3",
  effectiveConfirmationDate: "2026-10-02",
  entryScore: 8,
  upsideExitScore: 9.5,
} as const;
/** v2 confirmed records keep their stricter original rule; rejected records are never upgraded. */
export const PREVIOUS_KOSPI_ENTRY_POLICY_VERSION = "kospi-e8-confirm1-rsaccel-v2";

export function isSupportedKospiEntryVersion(version: string | undefined): boolean {
  return version === KOSPI_ENTRY_POLICY.version || version === PREVIOUS_KOSPI_ENTRY_POLICY_VERSION;
}

export interface KospiEntrySnapshot {
  version: string;
  date: string;
  originDate: string | null;
  confirmationDate: string | null;
  state: "none" | "pending" | "confirmed" | "rejected" | "unobservable";
  issues: string[];
  rsAccel: number | null;
  score: number | null;
  originScore: number | null;
  /** Prospective, date-bound eligibility; never evidence of an actual fill. */
  eligible: boolean;
}
export interface KospiEntryObservation {
  date: string;
  score: number | null;
  eligible: boolean;
  observed: boolean;
  rsAccel: number | null;
}
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && x > 0;

/** Arguments must be exact adjacent market sessions; never adjacent available stock bars. */
export function kospiEntryConfirmation(
  current: KospiEntryObservation,
  previous: KospiEntryObservation | null,
  beforePrevious: KospiEntryObservation | null,
): KospiEntrySnapshot {
  const cross = (a: KospiEntryObservation | null, b: KospiEntryObservation | null) =>
    !!a &&
    !!b &&
    a.observed &&
    b.observed &&
    b.eligible &&
    finite(a.score) &&
    finite(b.score) &&
    a.date < b.date &&
    a.score < KOSPI_ENTRY_POLICY.entryScore &&
    b.score >= KOSPI_ENTRY_POLICY.entryScore;
  const pending = cross(previous, current);
  const awaiting = !!previous && previous.date < current.date && cross(beforePrevious, previous);
  const result: KospiEntrySnapshot = {
    version: KOSPI_ENTRY_POLICY.version,
    date: current.date,
    originDate: awaiting ? previous!.date : pending ? current.date : null,
    confirmationDate: awaiting ? current.date : null,
    state: "none",
    issues: [],
    rsAccel: finite(current.rsAccel) ? current.rsAccel : null,
    score: finite(current.score) ? current.score : null,
    originScore: awaiting ? previous!.score : pending ? current.score : null,
    eligible: false,
  };
  if (awaiting) {
    if (current.observed && !current.eligible) result.issues.push("확인일 대상 부적격");
    if (finite(current.score) && current.score < KOSPI_ENTRY_POLICY.entryScore)
      result.issues.push("확인일 V8 8점 미만");
    // UP95 on this close is an exit for an existing holding, not a new-entry veto.
    if (finite(current.rsAccel) && current.rsAccel <= 0)
      result.issues.push("확인일 RSAccel 0 이하");
    if (result.issues.length) result.state = "rejected";
    else if (!current.observed || !finite(current.score) || !finite(current.rsAccel)) {
      result.state = "unobservable";
      result.issues.push("확인일 종목·지수·점수·RS 자료 미확인 · 지연 진입 불가");
    } else {
      result.state = "confirmed";
      result.eligible = current.date >= KOSPI_ENTRY_POLICY.effectiveConfirmationDate;
      if (!result.eligible) result.issues.push("도입일 이전 재구성 · 과거 참고만, 운영 진입 제외");
    }
  } else if (pending) result.state = "pending";
  else if (
    !current.observed ||
    !previous?.observed ||
    !finite(current.score) ||
    !finite(previous?.score)
  ) {
    result.state = "unobservable";
    result.issues.push("연속 거래일 관측 부족 · 신규 돌파/확인 여부 미확인");
  }
  return result;
}

export function isKospiEntryReady(s: KospiEntrySnapshot | undefined, asOfDate?: string): boolean {
  return (
    !!s &&
    isSupportedKospiEntryVersion(s.version) &&
    // Accept old confirmations only under their original no-UP95 rule.
    (s.version !== PREVIOUS_KOSPI_ENTRY_POLICY_VERSION ||
      (finite(s.originScore) &&
        !(
          s.originScore < KOSPI_ENTRY_POLICY.upsideExitScore &&
          finite(s.score) &&
          s.score >= KOSPI_ENTRY_POLICY.upsideExitScore
        ))) &&
    s.state === "confirmed" &&
    s.eligible &&
    s.date === s.confirmationDate &&
    (!asOfDate || s.date === asOfDate) &&
    s.date >= KOSPI_ENTRY_POLICY.effectiveConfirmationDate &&
    !!s.originDate &&
    s.originDate < s.date &&
    finite(s.score) &&
    s.score >= 8 &&
    finite(s.rsAccel) &&
    s.rsAccel > 0 &&
    s.issues.length === 0
  );
}

/** Session-aligned 20/60 excess price returns, percentage points; missing data stays null. */
export function kospiRelativeReturns(
  bars: DailyPrice[],
  benchmark: DailyPrice[],
  sessions: string[],
  date: string,
) {
  const dates = sessions.filter((d) => d <= date).slice(-61);
  const stock = new Map(bars.map((b) => [b.tradeDate, b.close]));
  const market = new Map(benchmark.map((b) => [b.tradeDate, b.close]));
  const excess = (period: number): number | null => {
    const window = dates.slice(-period - 1);
    if (
      window.length !== period + 1 ||
      window.at(-1) !== date ||
      !window.every((d) => positive(stock.get(d)) && positive(market.get(d)))
    )
      return null;
    const first = window[0]!;
    return (
      (stock.get(date)! / stock.get(first)! - 1 - (market.get(date)! / market.get(first)! - 1)) *
      100
    );
  };
  const rs20 = excess(20),
    rs60 = excess(60);
  return { rs20, rs60, rsAccel: rs20 === null || rs60 === null ? null : rs20 - rs60 };
}

/** Reconstruct only the three required closes from dated source data, not run counts or saved labels. */
export function buildKospiEntrySnapshot(ds: MarketDataset, symbol: string, cfg: ScoringConfig) {
  const benchmark = ds.indexSeries.find((s) => s.indexCode === "KOSPI")?.bars ?? [];
  const sessions = [...new Set([...ds.tradeDates, ...benchmark.map((b) => b.tradeDate)])]
    .filter((d) => d <= ds.asOfDate)
    .sort();
  const bars = ds.bars[symbol] ?? [];
  const instrument = ds.instruments.find((i) => i.symbol === symbol)!;
  const observation = (date: string | undefined): KospiEntryObservation | null => {
    if (!date) return null;
    const index = bars.findIndex((b) => b.tradeDate === date);
    const bar = bars[index];
    const observed = !!bar && benchmark.some((b) => b.tradeDate === date && positive(b.close));
    const rs = kospiRelativeReturns(bars, benchmark, sessions, date);
    if (!observed) return { date, score: null, eligible: false, observed: false, rsAccel: null };
    const snap = computeIndicators(bars, index);
    const score = historicalInstrumentScore(ds, symbol, index, cfg, snap).points;
    const universe = evaluateUniverse(
      instrument,
      snap,
      bar!.marketCap,
      bar!.tradingValue,
      index + 1,
      undefined,
      cfg.universe,
      ds.isLive ? { marketCap: ds.capabilities.marketCap, etfFacts: false } : ALL_AVAILABLE,
    );
    const prior20 = bars.slice(Math.max(0, index - 20), index);
    const liquid = prior20.length < 20 || prior20.filter((b) => b.volume > 0).length >= 10;
    return { date, score, observed, eligible: universe.passed && liquid, rsAccel: rs.rsAccel };
  };
  // asOfDate must itself have a market observation, even when all symbol bars are stale.
  const i = sessions.indexOf(ds.asOfDate);
  const current = observation(ds.asOfDate)!;
  const previous = i > 0 ? observation(sessions[i - 1]) : null;
  const before = i > 1 ? observation(sessions[i - 2]) : null;
  const entry = kospiEntryConfirmation(current, previous, before);
  const relative = kospiRelativeReturns(bars, benchmark, sessions, ds.asOfDate);
  return { entry, current, previous, ...relative };
}
