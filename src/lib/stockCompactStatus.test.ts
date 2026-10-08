import { describe, expect, it } from "vitest";
import type { ScreeningRow } from "./engine/pipeline";
import { OPERATIONAL_SIGNAL_VERSION } from "./engine/operationalStrategy";
import { getCompactStockStatus, getCompactStockWarnings } from "./stockCompactStatus";
const date = "2026-10-08";
const row = (overrides: Partial<ScreeningRow> = {}): ScreeningRow =>
  ({
    instrument: { symbol: "S", market: "KOSPI", instrumentType: "STOCK" },
    snapshot: { tradeDate: date, close: 100, volumeRatio20: 140 },
    operatingScore10: 9.5,
    previousOperatingScore10: 7,
    scoreDelta1d: 25,
    grade: "A",
    hardFilterPassed: false,
    hardFilterStatus: "PENDING",
    pendingRules: ["기준일 시가총액 미확인"],
    failedRules: [],
    warnings: [],
    sectorPriceLeadership: null,
    operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
    exitSignal: "UP95",
    ...overrides,
  }) as ScreeningRow;
const empty = { heldSymbols: [], lastSellDateBySymbol: {} };
const held = { heldSymbols: ["S"], lastSellDateBySymbol: {} };
const rejected = () => ({
  version: OPERATIONAL_SIGNAL_VERSION,
  date,
  originDate: date,
  confirmationDate: null,
  state: "rejected" as const,
  issues: ["발생일 불황(RISK_OFF) · 신규매수 제한", "기준일 시가총액 미확인"],
  rsAccel: 2,
  score: 9.5,
  originScore: 9.5,
  eligible: false,
});
describe("stock list two-line status", () => {
  it("keeps observed RISK_OFF rejection ahead of pending market cap", () => {
    const r = row({ kospiEntry: rejected() });
    const original = structuredClone(r);
    expect(getCompactStockStatus(r, empty, date)).toEqual({
      primary: "8.0 신규 돌파 · 진입 제외",
      secondary: "시장 RISK_OFF · 자료 대기",
      tone: "danger",
    });
    expect(r).toEqual(original);
  });
  it("keeps universe failures ahead of missing prerequisites", () => {
    expect(
      getCompactStockStatus(
        row({ hardFilterStatus: "FAIL", failedRules: ["유동성 부족"] }),
        empty,
        date,
      ),
    ).toMatchObject({ primary: "8.0 신규 돌파 · 진입 제외", secondary: "유동성 부족 · 자료 대기" });
  });
  it("does not label unheld/unknown 9.5 crossings as a sell instruction", () => {
    for (const context of [empty, null, undefined]) {
      const result = getCompactStockStatus(row(), context, date);
      expect(result.primary).toBe("8.0 신규 돌파 · 진입 미확정");
      expect(JSON.stringify(result)).not.toMatch(/청산|Exit|매도/);
    }
    expect(getCompactStockWarnings(row())).toEqual([]);
  });
  it("keeps actual-held exit priority", () => {
    expect(getCompactStockStatus(row(), held, date)).toEqual({
      primary: "보유 · 청산 조건 충족",
      secondary: "9.5점 상향돌파",
      tone: "danger",
    });
  });
  it("keeps held 5.5 to 8 as no technical exit and no repeated entry", () => {
    expect(
      getCompactStockStatus(
        row({ operatingScore10: 8, previousOperatingScore10: 5.5, exitSignal: null }),
        held,
        date,
      ),
    ).toMatchObject({
      primary: "보유 · 기술청산 없음",
      secondary: "8.0 신규 돌파 · 추가 진입 제외",
    });
  });
  it("does not infer a new signal from stale/nonadjacent evidence", () => {
    const stale = row({
      snapshot: { tradeDate: "2026-10-07", close: 100 } as ScreeningRow["snapshot"],
    });
    expect(getCompactStockStatus(stale, empty, date).primary).toBe("판단 미확인");
    const gap = row({ previousOperatingScoreDate: "2026-10-06" });
    expect(
      getCompactStockStatus(gap, empty, date, ["2026-10-06", "2026-10-07", date]).primary,
    ).toBe("진입 미확정");
  });
  it("keeps sold signal suppression and missing score separate", () => {
    expect(
      getCompactStockStatus(row(), { heldSymbols: [], lastSellDateBySymbol: { S: date } }, date)
        .primary,
    ).toBe("매도한 신호 · 재진입 제외");
    expect(getCompactStockStatus(row({ operatingScore10: null }), held, date).primary).toBe(
      "보유 · 청산 판단 미확인",
    );
  });
  it("preserves other important warnings without global warning-policy changes", () => {
    const r = row({ warnings: ["HEAD_FAKE", "DATA_INCOMPLETE"] });
    const warnings = getCompactStockWarnings(r);
    expect(warnings.length).toBe(2);
    expect(warnings.join(" ")).toMatch(/Head Fake/);
    expect(warnings.join(" ")).not.toMatch(/Exit|청산/);
    expect(r.exitSignal).toBe("UP95");
  });
  it("requires known holdings for entry-ready language", () => {
    const r = row({
      instrument: { ...row().instrument, market: "KOSDAQ" },
      hardFilterPassed: true,
      hardFilterStatus: "PASS",
      pendingRules: [],
      kosdaq80Onset: true,
    });
    expect(getCompactStockStatus(r, empty, date).primary).toContain("진입 준비");
    expect(getCompactStockStatus(r, undefined, date).secondary).toBe("보유정보 확인 필요");
  });
});
