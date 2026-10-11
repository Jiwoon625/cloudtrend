import { describe, expect, it } from "vitest";
import { isEveningReviewCandidate, matchesEtfReviewMinimum } from "./eveningReview";
import type { DashboardIndexRow, DashboardMarketSignals } from "./dashboardOperations";
import type { StockAssessmentDisplay } from "./stockAssessmentDisplay";
const date = "2026-10-12";
const market = { date } as DashboardMarketSignals;
const row = {
  date,
  market: "KOSPI",
  assessment: {
    current: true,
    score: 8,
    rawOnset: false,
    failed: [],
    pending: ["시가총액 미확인"],
  } as unknown as StockAssessmentDisplay,
} as DashboardIndexRow & { reason: string };
describe("review selection never creates operational signals", () => {
  it("keeps strong stored technical evidence while KRX is pending", () => {
    expect(isEveningReviewCandidate(row, market)).toBe(true);
    expect(isEveningReviewCandidate({ ...row, held: true }, market)).toBe(false);
    expect(isEveningReviewCandidate({ ...row, date: "2026-10-08" }, market)).toBe(false);
    expect(
      isEveningReviewCandidate(
        { ...row, assessment: { ...row.assessment!, current: false } },
        market,
      ),
    ).toBe(false);
    expect(
      isEveningReviewCandidate({ ...row, assessment: { ...row.assessment!, score: 5 } }, market),
    ).toBe(false);
    expect(
      isEveningReviewCandidate(
        { ...row, assessment: { ...row.assessment!, failed: ["시가총액 미달"] } },
        market,
      ),
    ).toBe(false);
  });
  it("excludes pre-start or unknown confirmation origins for both markets", () => {
    for (const originDate of ["2026-10-08", null]) {
      expect(
        isEveningReviewCandidate(
          {
            ...row,
            kospiEntry: { state: "confirmed", originDate } as DashboardIndexRow["kospiEntry"],
          },
          market,
        ),
      ).toBe(false);
      expect(
        isEveningReviewCandidate(
          {
            ...row,
            market: "ETF",
            etfEntry: { entryState: "data_pending", originDate } as DashboardIndexRow["etfEntry"],
            etfAssessment: {
              current: true,
              isStrategyTarget: true,
              technical: 50,
            } as DashboardIndexRow["etfAssessment"],
          },
          market,
        ),
      ).toBe(false);
    }
  });
  it("does not invent an ETF M0 from partial components", () => {
    const etf = {
      ...row,
      market: "ETF" as const,
      etfAssessment: {
        current: true,
        isStrategyTarget: true,
        technical: 50,
        score: null,
      } as DashboardIndexRow["etfAssessment"],
    };
    expect(isEveningReviewCandidate(etf, market)).toBe(true);
    expect(etf.etfAssessment?.score).toBeNull();
    expect(
      isEveningReviewCandidate(
        { ...etf, etfAssessment: { ...etf.etfAssessment!, isStrategyTarget: false } },
        market,
      ),
    ).toBe(false);
  });
  it("skips only missing values on explicitly selected partial review", () => {
    expect(matchesEtfReviewMinimum(null, 80, true)).toBe(true);
    expect(matchesEtfReviewMinimum(null, 80, false)).toBe(false);
    expect(matchesEtfReviewMinimum(70, 80, true)).toBe(false);
    expect(matchesEtfReviewMinimum(90, 80, false)).toBe(true);
  });
});
