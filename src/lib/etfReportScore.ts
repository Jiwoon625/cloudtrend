import type { AnalysisResult, ScreeningRow } from "./engine/pipeline";
import type { ScreeningSnapshot, SnapshotEntry } from "./screeningSnapshot";
import { ETF_POLICY, ETF_MAPPING, isEtfStrategyAssetClass } from "./engine/etfStrategy";

export type EtfReportScoreStatus =
  "FINAL" | "PRELIMINARY" | "PREVIOUS_REFERENCE" | "UNAVAILABLE" | "NOT_STRATEGY_TARGET";

/**
 * Snapshot/report-only evidence. Crucially, null means "not calculated", not
 * zero; the generic SnapshotEntry.totalScore can be zero for a pending ETF.
 * No member is read by entry/exit, allocation, Shadow or actual holdings.
 */
export interface EtfReportScore {
  type: "ETF_M0_REPORT_EVIDENCE_V1";
  sessionDate: string;
  scoreStatus: EtfReportScoreStatus;
  /** Only the current session's official executable strategy calculation. */
  confirmedM0: number | null;
  /** Only the current session's dated, explicitly read-only KRX estimate. */
  preliminaryM0: number | null;
  preliminaryKrxDate: string | null;
  preliminaryStatus: "ESTIMATE" | "INCOMPLETE" | null;
  /** Raw previous-session M0; historical eligibility must be independently verified. */
  priorSessionScoreReference: number | null;
  priorSessionDate: string | null;
  priorReferenceVerified: false;
  /** The number used in this report, with provenance and no silent date shift. */
  referenceScore: number | null;
  referenceDate: string | null;
  scoreIsToday: boolean;
  officialDataStatus: string | null;
  strategyTarget: boolean;
  issues: string[];
}

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function etfReportScore(row: ScreeningRow, sessionDate: string): EtfReportScore | null {
  if (row.instrument.instrumentType !== "ETF") return null;
  const s = row.etfStrategy;
  const target =
    isEtfStrategyAssetClass(ETF_MAPPING[row.instrument.symbol]) &&
    !row.instrument.isLeveraged &&
    !row.instrument.isInverse;
  const validSession =
    s !== undefined && s.date === sessionDate && s.version === ETF_POLICY.version;
  const finalM0 = validSession && s.dataStatus === "ready" && validScore(s.score) ? s.score : null;
  const prelim = row.krxReviewReference?.preliminary;
  const preview =
    validSession &&
    target &&
    prelim?.kind === "ETF" &&
    prelim.priceDate === sessionDate &&
    prelim.status === "ESTIMATE" &&
    validScore(prelim.m0)
      ? prelim
      : null;
  const previousDate =
    validSession && s?.previousDate && s.previousDate < sessionDate ? s.previousDate : null;
  const previousScore = previousDate && validScore(s.previousScore) ? s.previousScore : null;
  const scoreStatus: EtfReportScoreStatus = !target
    ? "NOT_STRATEGY_TARGET"
    : finalM0 !== null
      ? "FINAL"
      : preview !== null
        ? "PRELIMINARY"
        : previousScore !== null
          ? "PREVIOUS_REFERENCE"
          : "UNAVAILABLE";
  const referenceScore =
    scoreStatus === "FINAL"
      ? finalM0
      : scoreStatus === "PRELIMINARY"
        ? (preview!.m0 ?? null)
        : scoreStatus === "PREVIOUS_REFERENCE"
          ? previousScore
          : null;
  const referenceDate =
    scoreStatus === "PREVIOUS_REFERENCE"
      ? previousDate
      : scoreStatus === "FINAL" || scoreStatus === "PRELIMINARY"
        ? sessionDate
        : null;
  return {
    type: "ETF_M0_REPORT_EVIDENCE_V1",
    sessionDate,
    scoreStatus,
    confirmedM0: finalM0,
    preliminaryM0: preview?.m0 ?? null,
    preliminaryKrxDate: preview?.referenceDate ?? null,
    preliminaryStatus: preview?.status ?? null,
    priorSessionScoreReference: previousScore,
    priorSessionDate: previousDate,
    priorReferenceVerified: false,
    referenceScore,
    referenceDate,
    scoreIsToday: scoreStatus === "FINAL" || scoreStatus === "PRELIMINARY",
    officialDataStatus: validSession ? s.dataStatus : null,
    strategyTarget: !!target,
    issues: [
      ...(preview?.issues ?? []),
      ...(validSession && s ? s.issues : ["당일 ETF 전략 계산 없음"]),
      ...(previousScore !== null ? ["전일 점수는 해당 일자 Final 이력에서 독립 검증 필요"] : []),
    ],
  };
}

/** Compact summary for AI reports; never label missing ETF M0 as 0. */
export function etfReportScoreSummary(rows: readonly ScreeningRow[], date: string) {
  const observations = rows.flatMap((row) => {
    const e = etfReportScore(row, date);
    return e ? [{ symbol: row.instrument.symbol, name: row.instrument.name, evidence: e }] : [];
  });
  const counts = Object.fromEntries(
    (
      ["FINAL", "PRELIMINARY", "PREVIOUS_REFERENCE", "UNAVAILABLE", "NOT_STRATEGY_TARGET"] as const
    ).map((k) => [k, observations.filter((v) => v.evidence.scoreStatus === k).length]),
  ) as Record<EtfReportScoreStatus, number>;
  // Avoid copying all ~1200 score rows into the run summary. The full, dated
  // evidence belongs to the immutable execution archive.
  const ranked = observations
    .filter((item) => item.evidence.strategyTarget && item.evidence.referenceScore !== null)
    .sort(
      (a, b) =>
        (b.evidence.referenceScore ?? -1) - (a.evidence.referenceScore ?? -1) ||
        a.symbol.localeCompare(b.symbol),
    )
    .slice(0, 25);
  return {
    version: "etf-m0-report-20261021-v1",
    sessionDate: date,
    totalEtfs: observations.length,
    counts,
    noAvailableScoreIsNotZero: true,
    instructions:
      "Use evidence.etfReportScore.confirmedM0 for official Final. Read-only preliminaryM0 is not a confirmed entry, exit or order. priorSessionScoreReference is historical and requires independent prior-Final verification; never display totalScore=0 as the current ETF M0 when official score is null.",
    topReferenceEtfs: ranked,
  };
}

/**
 * Attach report evidence only AFTER the frozen core snapshot has been built.
 * This wrapper is never used by MODEL, economic replay, or actual executions.
 */
export function appendEtfReportEvidence(
  snapshot: ScreeningSnapshot,
  analysis: Pick<AnalysisResult, "asOfDate" | "rows">,
): ScreeningSnapshot {
  if (!snapshot.runId || snapshot.market !== "KR") return snapshot;
  if (snapshot.asOfDate !== analysis.asOfDate)
    throw new Error("ETF report evidence session mismatch");
  const bySymbol = new Map(
    analysis.rows
      .filter((row) => row.instrument.instrumentType === "ETF")
      .map((row) => [row.instrument.symbol, row]),
  );
  const withEvidence = (entry: SnapshotEntry): SnapshotEntry => {
    if (entry.instrumentType !== "ETF") return entry;
    const row = bySymbol.get(entry.symbol);
    if (!row) return entry;
    const scored = etfReportScore(row, analysis.asOfDate);
    return scored === null
      ? entry
      : {
          ...entry,
          evidence: { ...entry.evidence, etfReportScore: scored },
        };
  };
  return {
    ...snapshot,
    entries: snapshot.entries.map(withEvidence),
    ...(snapshot.topEtfs ? { topEtfs: snapshot.topEtfs.map(withEvidence) } : {}),
  };
}
