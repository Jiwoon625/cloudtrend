import type { MarketDataset } from "./dataset";
import type { DailyPrice } from "./types";
import { computeIndicators } from "./indicators";
import {
  ALL_AVAILABLE,
  evaluateUniverse,
  type HardFilterStatus,
  type ScoringConfig,
} from "./scoring";
import { evaluateKospiMarketGateAtDate, type KospiMarketGateEvidence } from "./kospiMarketGate";
import { historicalInstrumentScore } from "./historicalInstrumentScore";

/** Adopted 2026-10-02 KST. This is a prospective entry policy, not a backtest rewrite. */
export const KOSPI_ENTRY_POLICY = {
  version: "kospi-e8-confirm1-rsaccel-bear-v3",
  effectiveConfirmationDate: "2026-10-02",
  entryScore: 8,
  upsideExitScore: 9.5,
} as const;
export const KOSPI_CONSISTENCY_START = "2026-10-12";
export const KOSPI_CONSISTENCY_VERSION = "kospi-e8-confirm1-bear-rs-cross-v4";
export const kospiPolicyVersionAt = (date: string) =>
  date >= KOSPI_CONSISTENCY_START ? KOSPI_CONSISTENCY_VERSION : KOSPI_ENTRY_POLICY.version;

export function requiresKospiRsAccel(
  origin: KospiMarketGateEvidence | null | undefined,
  date: string,
) {
  return date < KOSPI_CONSISTENCY_START || origin?.status === "RISK_OFF";
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
  marketGate?:
    | {
        origin: KospiMarketGateEvidence | null;
        confirmation: KospiMarketGateEvidence | null;
      }
    | undefined;
  /** Prospective, date-bound eligibility; never evidence of an actual fill. */
  eligible: boolean;
}
export interface KospiEntryObservation {
  date: string;
  eligibilityStatus?: HardFilterStatus;
  pendingRules?: string[];
  score: number | null;
  eligible: boolean;
  observed: boolean;
  rsAccel: number | null;
  marketGate?: KospiMarketGateEvidence | undefined;
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
    (b.eligible || b.eligibilityStatus === "PENDING") &&
    finite(a.score) &&
    finite(b.score) &&
    a.date < b.date &&
    a.score < KOSPI_ENTRY_POLICY.entryScore &&
    b.score >= KOSPI_ENTRY_POLICY.entryScore;
  const pending = cross(previous, current);
  const awaiting = !!previous && previous.date < current.date && cross(beforePrevious, previous);
  const result: KospiEntrySnapshot = {
    version: kospiPolicyVersionAt(current.date),
    date: current.date,
    originDate: awaiting ? previous!.date : pending ? current.date : null,
    confirmationDate: awaiting ? current.date : null,
    state: "none",
    issues: [],
    rsAccel: finite(current.rsAccel) ? current.rsAccel : null,
    score: finite(current.score) ? current.score : null,
    originScore: awaiting ? previous!.score : pending ? current.score : null,
    eligible: false,
    marketGate: {
      origin: (awaiting ? previous?.marketGate : pending ? current.marketGate : null) ?? null,
      confirmation: awaiting ? (current.marketGate ?? null) : null,
    },
  };
  const requiresRs = requiresKospiRsAccel(result.marketGate?.origin, current.date);
  if (awaiting) {
    if (current.observed && !current.eligible && current.eligibilityStatus !== "PENDING")
      result.issues.push("확인일 대상 부적격");
    if (finite(current.score) && current.score < KOSPI_ENTRY_POLICY.entryScore)
      result.issues.push("확인일 V8 8점 미만");
    if (
      finite(previous!.score) &&
      finite(current.score) &&
      previous!.score < 9.5 &&
      current.score >= 9.5
    )
      result.issues.push("확인일 U9.5 청산신호");
    if (requiresRs && finite(current.rsAccel) && current.rsAccel <= 0)
      result.issues.push("확인일 RSAccel 0 이하");
    if (result.issues.length) result.state = "rejected";
    else if (
      !current.observed ||
      !finite(current.score) ||
      (requiresRs && !finite(current.rsAccel))
    ) {
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
  const pendingEligibility = [
    ...(awaiting && previous?.eligibilityStatus === "PENDING"
      ? [{ label: "발생일", observation: previous }]
      : []),
    ...(current.eligibilityStatus === "PENDING"
      ? [{ label: awaiting ? "확인일" : "기준일", observation: current }]
      : []),
  ];
  if (pendingEligibility.length) {
    result.eligible = false;
    if (result.state !== "rejected") result.state = "unobservable";
    for (const pending of pendingEligibility)
      result.issues.push(
        `${pending.label} ${(pending.observation.pendingRules ?? ["시가총액 미확인 · 판단 보류"]).join(" · ")}`,
      );
  }
  // The dated guard is prospective. Older reconstructed states stay reference-only.
  if ((awaiting || pending) && current.date >= KOSPI_ENTRY_POLICY.effectiveConfirmationDate) {
    const checks = [
      { label: "발생일", date: result.originDate!, gate: result.marketGate!.origin },
      ...(awaiting
        ? [{ label: "확인일", date: current.date, gate: result.marketGate!.confirmation }]
        : []),
    ];
    let unknown = false;
    let bear = false;
    for (const check of checks) {
      if (
        !check.gate ||
        check.gate.date !== check.date ||
        check.gate.status === "UNKNOWN" ||
        check.gate.incomplete ||
        check.gate.evaluatedCount !== 4 ||
        check.gate.issues.length > 0
      ) {
        unknown = true;
        result.issues.push(
          `${check.label} 시장국면 미확인 · 신규매수 제한${check.gate?.issues.length ? ` (${check.gate.issues.join(", ")})` : ""}`,
        );
      } else if (check.gate.status === "RISK_OFF") {
        bear = true;
        result.issues.push(`${check.label} 불황(RISK_OFF) · 신규매수 제한 · 새 Onset 필요`);
      }
    }
    if (bear || unknown) {
      result.eligible = false;
      // An observed failure stays a rejection even if another prerequisite is unknown.
      result.state = bear || result.state === "rejected" ? "rejected" : "unobservable";
    }
  }
  return result;
}

export function isKospiEntryReady(s: KospiEntrySnapshot | undefined, asOfDate?: string): boolean {
  return (
    !!s &&
    s.version === kospiPolicyVersionAt(s.date) &&
    s.state === "confirmed" &&
    s.eligible &&
    s.date === s.confirmationDate &&
    (!asOfDate || s.date === asOfDate) &&
    s.date >= KOSPI_ENTRY_POLICY.effectiveConfirmationDate &&
    !!s.originDate &&
    s.originDate < s.date &&
    finite(s.score) &&
    s.score >= 8 &&
    (!requiresKospiRsAccel(s.marketGate?.origin, s.date) || (finite(s.rsAccel) && s.rsAccel > 0)) &&
    s.issues.length === 0 &&
    !!s.marketGate &&
    [
      [s.marketGate.origin, s.originDate],
      [s.marketGate.confirmation, s.confirmationDate],
    ].every(([gate, date]) => {
      const g = gate as KospiMarketGateEvidence | null;
      return (
        !!g &&
        g.date === date &&
        !g.incomplete &&
        g.evaluatedCount === 4 &&
        g.issues.length === 0 &&
        (g.status === "RISK_ON" || g.status === "NEUTRAL")
      );
    })
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
  const sessions = [
    ...new Set([...(ds.kospiGateDates ?? ds.tradeDates), ...benchmark.map((b) => b.tradeDate)]),
  ]
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
    const marketGate = evaluateKospiMarketGateAtDate(ds, date);
    if (!observed)
      return { date, score: null, eligible: false, observed: false, rsAccel: null, marketGate };
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
    return {
      date,
      score,
      observed,
      eligible: universe.passed && liquid,
      eligibilityStatus: liquid ? universe.status : "FAIL",
      pendingRules: universe.pendingRules,
      rsAccel: rs.rsAccel,
      marketGate,
    };
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
