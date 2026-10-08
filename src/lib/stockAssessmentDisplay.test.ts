import { describe, expect, it } from "vitest";
import type { ScreeningRow, AnalysisResult } from "./engine/pipeline";
import { stockAssessmentDisplay } from "./stockAssessmentDisplay";
import { projectKrDashboard, marketSignals } from "./dashboardOperations";
import { isOperationalEntry, OPERATIONAL_SIGNAL_VERSION } from "./engine/operationalStrategy";
import { kospiEntryConfirmation } from "./engine/kospiEntryConfirmation";
const date = "2026-10-08";
export const partialStock = (overrides: Partial<ScreeningRow> = {}): ScreeningRow =>
  ({
    instrument: {
      symbol: "036930",
      name: "주성엔지니어링",
      market: "KOSDAQ",
      instrumentType: "STOCK",
      sectorName: "반도체",
    },
    snapshot: { tradeDate: date, close: 35000, volumeRatio20: 150 },
    operatingScore10: 8,
    previousOperatingScore10: 5.5,
    previousOperatingScoreDate: "2026-10-07",
    scoreDelta1d: 25,
    grade: "A",
    priority: { points: 4 },
    hardFilterPassed: false,
    hardFilterStatus: "PENDING",
    pendingRules: ["기준일 시가총액 미확인 · 판단 보류"],
    failedRules: [],
    kosdaq80Onset: false,
    exitSignal: null,
    operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
    ...overrides,
  }) as ScreeningRow;
const analysis = (rows: ScreeningRow[]): AnalysisResult =>
  ({ rows, asOfDate: date, tradeDates: ["2026-10-06", "2026-10-07", date] }) as AnalysisResult;

describe("completed evening screening evidence", () => {
  it("shows 5.5→8 technical crossing while missing market cap still blocks final entry", () => {
    const row = partialStock();
    const before = structuredClone(row);
    expect(stockAssessmentDisplay(row, date)).toMatchObject({
      score: 8,
      previousScore: 5.5,
      grade: "A",
      rawOnset: true,
      volumeRatio20: 150,
      finalEntry: "최종 진입 미확정 · 필수 자료 확인 대기",
      exit: "기술청산 조건 없음",
    });
    expect(isOperationalEntry(row, date)).toBe(false);
    expect(row).toEqual(before);
  });
  it("retains independent observed universe failures alongside pending inputs", () => {
    const assessment = stockAssessmentDisplay(
      partialStock({ hardFilterStatus: "FAIL", failedRules: ["유동성 부족"] }),
      date,
    );
    expect(assessment.rawOnset).toBe(true);
    expect(assessment.failed).toEqual(["유동성 부족"]);
    expect(assessment.pending).toHaveLength(1);
    expect(assessment.finalEntry).toContain("조건 미충족");
  });
  it.each([null, NaN, Infinity])(
    "keeps incomplete/non-finite technical score unknown: %s",
    (score) => {
      const result = stockAssessmentDisplay(partialStock({ operatingScore10: score }), date);
      expect(result.score).toBeNull();
      expect(result.grade).toBeNull();
      expect(result.rawOnset).toBeNull();
      expect(result.exit).toBe("기술청산 판단 미확인");
    },
  );
  it("preserves a real zero score and its downward exit", () => {
    const result = stockAssessmentDisplay(
      partialStock({
        operatingScore10: 0,
        previousOperatingScore10: 4,
        scoreDelta1d: -40,
        grade: "C",
      }),
      date,
    );
    expect(result.score).toBe(0);
    expect(result.exit).toContain("3.0점 하향 이탈");
  });
  it("does not present stale quotes or nonadjacent bars as today's crossing", () => {
    const stale = partialStock({
      snapshot: { tradeDate: "2026-10-07", close: 35000 } as ScreeningRow["snapshot"],
    });
    expect(stockAssessmentDisplay(stale, date).score).toBeNull();
    expect(stockAssessmentDisplay(stale, date).finalEntry).toContain("기준일 가격 미확인");
    const gap = partialStock({ previousOperatingScoreDate: "2026-10-06" });
    expect(stockAssessmentDisplay(gap, date, analysis([]).tradeDates).rawOnset).toBeNull();
  });
  it("uses the stored delta for older projections without introducing a new scoring run", () => {
    const row = partialStock();
    delete row.previousOperatingScore10;
    const result = stockAssessmentDisplay(row, date);
    expect(result.previousScore).toBe(5.5);
    expect(result.rawOnset).toBe(true);
  });
  it("shows negative RSAccel, score-maintenance and RISK_OFF rejections even with cap pending", () => {
    const gate = (d: string) => ({
      date: d,
      status: "RISK_OFF" as const,
      incomplete: false,
      evaluatedCount: 4,
      issues: [],
    });
    const entry = kospiEntryConfirmation(
      {
        date,
        score: 8.5,
        rsAccel: -1,
        eligible: false,
        eligibilityStatus: "PENDING",
        observed: true,
        marketGate: gate(date) as never,
      },
      {
        date: "2026-10-07",
        score: 8,
        rsAccel: 1,
        eligible: true,
        observed: true,
        marketGate: gate("2026-10-07") as never,
      },
      { date: "2026-10-06", score: 7, rsAccel: 1, eligible: true, observed: true },
    );
    const row = partialStock({
      instrument: { ...partialStock().instrument, market: "KOSPI", name: "한국화장품제조" },
      operatingScore10: 8.5,
      previousOperatingScore10: 8,
      scoreDelta1d: 5,
      kospiEntry: entry,
    });
    const result = stockAssessmentDisplay(row, date);
    expect(result.conditions.join(" ")).toContain("확인일 8점 유지 충족");
    expect(result.conditions.join(" ")).toContain("RSAccel > 0 미충족");
    expect(result.conditions.join(" ")).toContain("RISK_OFF · 미충족");
    expect(result.finalEntry).toContain("신규 진입 제외");
    expect(isOperationalEntry(row, date)).toBe(false);
  });
  it("makes all 614 stocks inspectable without creating eligible candidates or changing source", () => {
    const rows = Array.from({ length: 614 }, (_, i) =>
      partialStock({
        instrument: { ...partialStock().instrument, symbol: String(i).padStart(6, "0") },
        ...(i < 35 ? { hardFilterStatus: "FAIL" as const, failedRules: ["유동성 부족"] } : {}),
      }),
    );
    const input = analysis(rows);
    const before = structuredClone(input);
    const result = marketSignals(projectKrDashboard(input), "KOSDAQ", [
      { symbol: "000036", name: "보유", shares: 3, firstEntryDate: "2026-10-07" },
    ]);
    expect(result.assessments).toHaveLength(614);
    expect(result.assessments?.[0]?.held).toBe(true);
    expect(result.assessments?.[0]?.assessment?.exit).toBe("기술청산 조건 없음");
    expect(result.onsetCount).toBe(0);
    expect(result.exitCount).toBe(0);
    expect(input).toEqual(before);
  });
  it("keeps held-position exit priority despite pending cap and coincident raw onset", () => {
    const row = partialStock({ operatingScore10: 9.5, scoreDelta1d: 40 });
    const result = marketSignals(projectKrDashboard(analysis([row])), "KOSDAQ", [
      { symbol: "036930", name: row.instrument.name, shares: 3, firstEntryDate: "2026-10-07" },
    ]);
    expect(result.exitCount).toBe(1);
    expect(result.onsetCount).toBe(0);
    expect(result.assessments?.[0]?.assessment?.exit).toContain("9.0점 상향 재돌파");
  });
});
