import type { DailyPrice, IndexSeries } from "./types";

export const SCORE_THRESHOLDS = [5, 6, 7, 8, 9];
export const SCORE_BANDS: Array<[number, number, string]> = [
  [0, 2, "0 이상 2 미만"],
  [2, 4, "2 이상 4 미만"],
  [4, 6, "4 이상 6 미만"],
  [6, 7, "6 이상 7 미만"],
  [7, 8, "7 이상 8 미만"],
  [8, 9, "8 이상 9 미만"],
  [9, 9.500001, "9 이상 9.5 이하"],
];
export type EntryState = "신규 돌파" | "지속 2~5일" | "지속 6일 이상" | "시작 불명";
export interface ScoredSeries {
  symbol: string;
  market?: "KOSPI" | "KOSDAQ";
  bars: DailyPrice[];
  scores: Array<number | null>;
}
export interface ScoreDiagnosticRow {
  split: "ALL" | "OOS";
  kind: "BAND" | "STATE";
  label: string;
  threshold: number | null;
  horizon: number;
  count: number;
  benchmarkCount: number;
  pathCount: number;
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  excessReturn: number | null;
  p5: number | null;
  loss10Rate: number | null;
  drawdown10Rate: number | null;
  drawdown20Rate: number | null;
  medianAdverse: number | null;
}
export interface ScoreDiagnostics {
  rows: ScoreDiagnosticRow[];
  validScoreDays: number;
  missingScoreDays: number;
  firstScoreDate: string | null;
  oosStart: string | null;
  roundTripCostBps: number;
}

/** A missing/initial high score cannot establish the beginning of a high-score episode. */
export function advanceScoreAge(
  previous: number | null,
  current: number | null,
  threshold: number,
  age: number | null,
): number | null {
  if (current === null) return null;
  if (current < threshold) return 0;
  if (previous === null) return null;
  if (previous < threshold) return 1;
  return age === null ? null : age + 1;
}
export function entryState(age: number | null): EntryState {
  return age === null
    ? "시작 불명"
    : age === 1
      ? "신규 돌파"
      : age <= 5
        ? "지속 2~5일"
        : "지속 6일 이상";
}

/** Signal at t close; enter t+1 open; exit t+h close (h sessions including entry day). */
export function forwardOutcome(bars: DailyPrice[], t: number, h: number, costBps = 0) {
  const entry = bars[t + 1];
  const exit = bars[t + h];
  if (
    !entry ||
    !exit ||
    !Number.isFinite(entry.open) ||
    entry.open <= 0 ||
    !Number.isFinite(exit.close) ||
    exit.close <= 0
  )
    return null;
  let minimum = entry.open;
  let completePath = true;
  for (let j = t + 1; j <= t + h; j++) {
    const low = bars[j]?.low;
    if (!Number.isFinite(low) || !(low! > 0)) completePath = false;
    else minimum = Math.min(minimum, low!);
  }
  return {
    ret: (exit.close / entry.open - 1) * 100 - costBps / 100,
    adverse: completePath ? (minimum / entry.open - 1) * 100 : null,
    entryDate: entry.tradeDate,
    exitDate: exit.tradeDate,
  };
}

const average = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i),
    hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

/** Daily observations; no five-day-grid approximation of onset or persistence. */
export function buildScoreDiagnostics(
  series: ScoredSeries[],
  horizons: number[],
  indexSeries: IndexSeries[] = [],
  oosStart: string | null = null,
  costBps = 0,
): ScoreDiagnostics {
  const indexes = new Map(
    indexSeries.map((s) => [
      s.indexCode.toUpperCase(),
      new Map(s.bars.map((b) => [b.tradeDate, b])),
    ]),
  );
  type Group = {
    row: Pick<ScoreDiagnosticRow, "split" | "kind" | "label" | "threshold" | "horizon">;
    returns: number[];
    excess: number[];
    adverse: number[];
  };
  const groups = new Map<string, Group>();
  for (const split of ["ALL", "OOS"] as const)
    for (const horizon of horizons) {
      for (const [, , label] of SCORE_BANDS)
        groups.set(`${split}|${horizon}|BAND|${label}`, {
          row: { split, horizon, kind: "BAND", label, threshold: null },
          returns: [],
          excess: [],
          adverse: [],
        });
      for (const threshold of SCORE_THRESHOLDS)
        for (const label of [
          "신규 돌파",
          "지속 2~5일",
          "지속 6일 이상",
          "시작 불명",
        ] as EntryState[]) {
          groups.set(`${split}|${horizon}|${threshold}|${label}`, {
            row: { split, horizon, kind: "STATE", label, threshold },
            returns: [],
            excess: [],
            adverse: [],
          });
        }
    }
  let validScoreDays = 0,
    missingScoreDays = 0;
  let firstScoreDate: string | null = null;
  for (const s of series) {
    const benchmark = indexes.get(s.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI");
    const ages = SCORE_THRESHOLDS.map(() => null as number | null);
    for (let i = 0; i < s.bars.length; i++) {
      const score = s.scores[i] ?? null;
      SCORE_THRESHOLDS.forEach((threshold, j) => {
        ages[j] = advanceScoreAge(s.scores[i - 1] ?? null, score, threshold, ages[j]!);
      });
      if (score === null) {
        missingScoreDays++;
        continue;
      }
      validScoreDays++;
      const date = s.bars[i]!.tradeDate;
      if (firstScoreDate === null || date < firstScoreDate) firstScoreDate = date;
      const band = SCORE_BANDS.find(([lo, hi]) => score >= lo && score < hi);
      if (!band) continue;
      for (const h of horizons) {
        const outcome = forwardOutcome(s.bars, i, h, costBps);
        if (!outcome) continue; // Censored tails are never treated as zero returns.
        const be = benchmark?.get(outcome.entryDate)?.open;
        const bx = benchmark?.get(outcome.exitDate)?.close;
        const excess =
          be && bx && Number.isFinite(be) && Number.isFinite(bx) && be > 0 && bx > 0
            ? outcome.ret - (bx / be - 1) * 100
            : null;
        const splits: Array<"ALL" | "OOS"> =
          oosStart && date >= oosStart ? ["ALL", "OOS"] : ["ALL"];
        for (const split of splits) {
          const keys = [`${split}|${h}|BAND|${band[2]}`];
          SCORE_THRESHOLDS.forEach((threshold, j) => {
            if (score >= threshold) keys.push(`${split}|${h}|${threshold}|${entryState(ages[j]!)}`);
          });
          for (const key of keys) {
            const g = groups.get(key)!;
            g.returns.push(outcome.ret);
            if (excess !== null) g.excess.push(excess);
            if (outcome.adverse !== null) g.adverse.push(outcome.adverse);
          }
        }
      }
    }
  }
  const rows = [...groups.values()].map(({ row, returns, excess, adverse }): ScoreDiagnosticRow => {
    returns.sort((a, b) => a - b);
    adverse.sort((a, b) => a - b);
    const rate = (xs: number[], f: (x: number) => boolean) =>
      xs.length ? (xs.filter(f).length / xs.length) * 100 : null;
    return {
      ...row,
      count: returns.length,
      benchmarkCount: excess.length,
      pathCount: adverse.length,
      avgReturn: average(returns),
      medianReturn: percentile(returns, 0.5),
      winRate: rate(returns, (x) => x > 0),
      excessReturn: average(excess),
      p5: percentile(returns, 0.05),
      loss10Rate: rate(returns, (x) => x <= -10 + 1e-9),
      drawdown10Rate: rate(adverse, (x) => x <= -10 + 1e-9),
      drawdown20Rate: rate(adverse, (x) => x <= -20 + 1e-9),
      medianAdverse: percentile(adverse, 0.5),
    };
  });
  return {
    rows,
    validScoreDays,
    missingScoreDays,
    firstScoreDate,
    oosStart,
    roundTripCostBps: costBps,
  };
}
