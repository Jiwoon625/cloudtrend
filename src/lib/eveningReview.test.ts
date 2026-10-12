import { describe, expect, it } from "vitest";
import {
  eveningReviewStartNotice,
  isEveningReviewCandidate,
  isTechnicalReviewReference,
  isReviewOnsetUnknown,
  matchesEtfReviewMinimum,
} from "./eveningReview";
import type { DashboardIndexRow, DashboardMarketSignals } from "./dashboardOperations";
import type { StockAssessmentDisplay } from "./stockAssessmentDisplay";
const date = "2026-10-12";
const market = { date, holdingsKnown: true } as DashboardMarketSignals;
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
    expect(isTechnicalReviewReference(row, market)).toBe(true);
    expect(isTechnicalReviewReference({ ...row, held: true }, market)).toBe(false);
    expect(isTechnicalReviewReference({ ...row, date: "2026-10-08" }, market)).toBe(false);
    expect(
      isTechnicalReviewReference(
        { ...row, assessment: { ...row.assessment!, current: false } },
        market,
      ),
    ).toBe(false);
    expect(
      isTechnicalReviewReference({ ...row, assessment: { ...row.assessment!, score: 5 } }, market),
    ).toBe(false);
    expect(
      isTechnicalReviewReference(
        { ...row, assessment: { ...row.assessment!, failed: ["시가총액 미달"] } },
        market,
      ),
    ).toBe(false);
  });
  it("excludes pre-start or unknown confirmation origins for both markets", () => {
    for (const originDate of ["2026-10-08", null]) {
      expect(
        isTechnicalReviewReference(
          {
            ...row,
            kospiEntry: { state: "confirmed", originDate } as DashboardIndexRow["kospiEntry"],
          },
          market,
        ),
      ).toBe(false);
      expect(
        isTechnicalReviewReference(
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
    expect(isTechnicalReviewReference(etf, market)).toBe(true);
    expect(etf.etfAssessment?.score).toBeNull();
    expect(
      isTechnicalReviewReference(
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

it("does not label unknown holdings or rejected confirmations as review candidates", () => {
  expect(isTechnicalReviewReference(row, { ...market, holdingsKnown: false })).toBe(false);
  expect(
    isTechnicalReviewReference(
      { ...row, kospiEntry: { date, state: "rejected" } as DashboardIndexRow["kospiEntry"] },
      market,
    ),
  ).toBe(false);
});
it("derives ETF operational exclusion notices from stored ETF entry evidence", () => {
  const etf = {
    ...row,
    market: "ETF" as const,
    etfEntry: {
      entryState: "data_pending",
      originDate: "2026-10-08",
    } as DashboardIndexRow["etfEntry"],
  };
  expect(eveningReviewStartNotice(etf)).toContain("시작 전 원신호");
  expect(
    eveningReviewStartNotice({ ...etf, etfEntry: { ...etf.etfEntry!, originDate: null } }),
  ).toContain("원신호 시점 미확인");
});

describe("raw signals and technical references are separate", () => {
  it("keeps the actual 6→8 onset even when market entry is rejected", () => {
    const onset = {
      ...row,
      assessment: { ...row.assessment!, previousScore: 6, rawOnset: true, failed: ["RISK_OFF"] },
      kospiEntry: { date, state: "rejected", originDate: date } as DashboardIndexRow["kospiEntry"],
    };
    expect(isEveningReviewCandidate(onset, market)).toBe(true);
    expect(isTechnicalReviewReference(onset, market)).toBe(false);
    expect(isEveningReviewCandidate({ ...onset, held: true }, market)).toBe(true);
    expect(isEveningReviewCandidate(onset, { ...market, holdingsKnown: false })).toBe(true);
  });
  it("never promotes maintained or falling scores or yesterday's signals", () => {
    for (const previousScore of [8, 9.5]) {
      expect(
        isEveningReviewCandidate(
          { ...row, assessment: { ...row.assessment!, previousScore, rawOnset: false } },
          market,
        ),
      ).toBe(false);
    }
    expect(
      isEveningReviewCandidate(
        { ...row, date: "2026-10-08", assessment: { ...row.assessment!, rawOnset: true } },
        market,
      ),
    ).toBe(false);
  });
  it("keeps missing ETF M0 and older cached fields unknown, not zero", () => {
    const etf = {
      ...row,
      market: "ETF" as const,
      etfAssessment: {
        current: true,
        isStrategyTarget: true,
        technical: 50,
        score: null,
        rawOnset: null,
      } as DashboardIndexRow["etfAssessment"],
    };
    expect(isEveningReviewCandidate(etf, market)).toBe(false);
    expect(isReviewOnsetUnknown(etf, market)).toBe(true);
    expect(isTechnicalReviewReference(etf, market)).toBe(true);
    expect(
      isReviewOnsetUnknown(
        {
          ...etf,
          etfAssessment: {
            ...etf.etfAssessment!,
            rawOnset: undefined,
          } as unknown as DashboardIndexRow["etfAssessment"],
        },
        market,
      ),
    ).toBe(true);
    expect(
      isReviewOnsetUnknown(
        { ...etf, etfAssessment: { ...etf.etfAssessment!, rawOnset: false } },
        market,
      ),
    ).toBe(false);
    expect(
      isEveningReviewCandidate(
        { ...etf, etfAssessment: { ...etf.etfAssessment!, rawOnset: true } },
        market,
      ),
    ).toBe(true);
  });
});

it("keeps missing ETF assessment projections explicitly unknown", () => {
  expect(isReviewOnsetUnknown({ ...row, market: "ETF", etfAssessment: undefined }, market)).toBe(
    true,
  );
});
