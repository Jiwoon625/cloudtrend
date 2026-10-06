import { kospiEntryConfirmation } from "./engine/kospiEntryConfirmation";
import {
  OPERATIONAL_SIGNAL_VERSION,
  PREVIOUS_KOSPI_ENTRY_POLICY_VERSION,
} from "./engine/operationalStrategy";
import { describe, expect, it } from "vitest";

import type { ScreeningRow } from "./engine/pipeline";
import type { Instrument } from "./engine/types";
import {
  getDisplayStatus,
  getPortfolioAwareDisplayStatus,
  isPortfolioAwareOperationalEntry,
} from "./statusDisplay";
import type { DomesticPositionContext } from "./positionSignalContext";

function instrument(market: "KOSPI" | "KOSDAQ"): Instrument {
  return {
    id: market === "KOSPI" ? "kospi-test" : "kosdaq-test",
    symbol: market === "KOSPI" ? "000000" : "111111",
    name: market === "KOSPI" ? "테스트" : "코스닥 테스트",
    market,
    instrumentType: "STOCK",
    sectorCode: "ETC",
    sectorName: "기타",
    isPreferredStock: false,
    isManagementIssue: false,
    isInvestmentWarning: false,
    isLeveraged: false,
    isInverse: false,
    isActive: true,
    indexMemberships: [],
  };
}

function row(overrides: Partial<ScreeningRow> = {}): ScreeningRow {
  return {
    instrument: instrument("KOSPI"),
    operationalSignalVersion: "kospi-e8-u95-dx-v1",
    kosdaq80Onset: false,
    kospiEightPointEntry: false,
    exitSignal: null,
    grade: "A",
    rs20: null,
    rs60: null,
    ...overrides,
  } as ScreeningRow;
}

describe("V8 display status", () => {
  it("does not promote old raw KOSPI onset to a new-policy entry", () => {
    expect(
      getDisplayStatus(row({ kospiEightPointEntry: true, kospi80Onset: true, rs20: 4, rs60: 5 })),
    ).toBe("KOSPI 8.0 Onset · 확인 기록 없음 · 진입 제외");
  });

  it("does not promote onset-day positive RS without next-day confirmation", () => {
    expect(
      getDisplayStatus(row({ kospiEightPointEntry: true, kospi80Onset: true, rs20: 6, rs60: 2 })),
    ).toBe("KOSPI 8.0 Onset · 확인 기록 없음 · 진입 제외");
  });

  it("does not confirm relative momentum when RSAccel is zero or unavailable", () => {
    expect(
      getDisplayStatus(row({ kospiEightPointEntry: true, kospi80Onset: true, rs20: 3, rs60: 3 })),
    ).toBe("KOSPI 8.0 Onset · 확인 기록 없음 · 진입 제외");
    expect(
      getDisplayStatus(
        row({ kospiEightPointEntry: true, kospi80Onset: true, rs20: null, rs60: 3 }),
      ),
    ).toBe("KOSPI 8.0 Onset · 확인 기록 없음 · 진입 제외");
  });

  it("keeps bear-blocked raw onset visibly excluded", () => {
    const candidate = row({
      operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
      kospi80Onset: true,
      kospiEntry: {
        ...kospiEntryConfirmation(
          { date: "2026-10-02", score: 8, rsAccel: 1, eligible: true, observed: true },
          { date: "2026-10-01", score: 7.5, rsAccel: 1, eligible: true, observed: true },
          null,
        ),
        state: "rejected",
        issues: ["발생일 불황(RISK_OFF) · 신규매수 제한 · 새 Onset 필요"],
      },
    });
    expect(getDisplayStatus(candidate)).toContain("확인 실패 · 진입 제외");
    expect(getDisplayStatus(candidate)).toContain("발생일 불황");
    expect(getDisplayStatus(candidate)).not.toContain("확인 대기");
    expect(isPortfolioAwareOperationalEntry(candidate, null, "2026-10-02")).toBe(false);
  });

  it("preserves the reason when market evidence is unobservable", () => {
    const candidate = row({
      operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
      kospi80Onset: true,
      kospiEntry: kospiEntryConfirmation(
        { date: "2026-10-02", score: 8, rsAccel: 1, eligible: true, observed: true },
        { date: "2026-10-01", score: 7.5, rsAccel: 1, eligible: true, observed: true },
        null,
      ),
    });
    expect(getDisplayStatus(candidate)).toContain("진입 제외");
    expect(getDisplayStatus(candidate)).toContain("시장국면 미확인");
    expect(getDisplayStatus(candidate)).not.toContain("확인 대기");
  });

  it("retains previous-policy held exit signals after entry policy migration", () => {
    expect(
      getDisplayStatus(
        row({
          operationalSignalVersion: PREVIOUS_KOSPI_ENTRY_POLICY_VERSION,
          exitSignal: "UP95",
        }),
      ),
    ).toBe("KOSPI 청산 · 9.5점 상향돌파");
  });

  it("uses the operational KOSDAQ 8.0 Onset · 신규 진입 label", () => {
    expect(
      getDisplayStatus(
        row({
          instrument: instrument("KOSDAQ"),
          kosdaq80Onset: true,
          rs20: 6,
          rs60: 2,
        }),
      ),
    ).toBe("KOSDAQ 8.0 Onset · 신규 진입");
  });

  it("shows the validated KOSDAQ aggressive exit labels", () => {
    expect(getDisplayStatus(row({ instrument: instrument("KOSDAQ"), exitSignal: "UP90" }))).toBe(
      "KOSDAQ 청산 · 9.0점 상향 재돌파",
    );
    expect(getDisplayStatus(row({ instrument: instrument("KOSDAQ"), exitSignal: "DOWN30" }))).toBe(
      "KOSDAQ 청산 · 3.0점 하향 이탈",
    );
  });
  it("suppresses a fresh Onset when the canonical actual ledger already holds the symbol", () => {
    const held: DomesticPositionContext = { heldSymbols: ["000000"], lastSellDateBySymbol: {} };
    const candidate = row({
      kospiEightPointEntry: true,
      kospi80Onset: true,
      operatingScore10: 8,
      scoreDelta1d: 25,
    });
    expect(isPortfolioAwareOperationalEntry(candidate, held, "2026-09-30")).toBe(false);
    expect(getPortfolioAwareDisplayStatus(candidate, held, "2026-09-30")).toBe("보유");
  });

  it("suppresses same-day re-entry after an actual sale", () => {
    const sold: DomesticPositionContext = {
      heldSymbols: [],
      lastSellDateBySymbol: { "000000": "2026-09-30" },
    };
    const candidate = row({
      kospiEightPointEntry: false,
      kospi80Onset: true,
      operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
      kospiEntry: kospiEntryConfirmation(
        { date: "2026-09-30", score: 8, rsAccel: 1, eligible: true, observed: true },
        { date: "2026-09-29", score: 7.5, rsAccel: 1, eligible: true, observed: true },
        null,
      ),
    });
    expect(isPortfolioAwareOperationalEntry(candidate, sold, "2026-09-30")).toBe(false);
    expect(getPortfolioAwareDisplayStatus(candidate, sold, "2026-09-30")).toBe(
      "당일 매도 · 재진입 제외",
    );
  });

  it("gives held-position exit priority over a same-day KOSDAQ Onset", () => {
    const held: DomesticPositionContext = { heldSymbols: ["111111"], lastSellDateBySymbol: {} };
    const candidate = row({
      instrument: instrument("KOSDAQ"),
      kosdaq80Onset: true,
      operatingScore10: 9.5,
      scoreDelta1d: 40,
    });
    expect(getPortfolioAwareDisplayStatus(candidate, held, "2026-09-30")).toBe(
      "청산 대기 · KOSDAQ 9.0점 상향 재돌파",
    );
  });
});

describe("KOSPI held entry and exit remain distinct", () => {
  const held: DomesticPositionContext = { heldSymbols: ["000000"], lastSellDateBySymbol: {} };
  const candidate = (score: number, previous: number) =>
    row({
      operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
      kospi80Onset: true,
      operatingScore10: score,
      scoreDelta1d: (score - previous) * 10,
      kospiEntry: {
        ...kospiEntryConfirmation(
          { date: "2026-10-02", score, rsAccel: 1, eligible: true, observed: true },
          { date: "2026-10-01", score: previous, rsAccel: 1, eligible: true, observed: true },
          null,
        ),
        state: "rejected",
        issues: ["발생일 불황(RISK_OFF) · 신규매수 제한 · 새 Onset 필요"],
      },
    });

  it("keeps an already-held sub-9.5 raw Onset as held, with no fresh entry or fabricated exit", () => {
    const input = candidate(8, 5.5);
    expect(getPortfolioAwareDisplayStatus(input, held, "2026-10-02")).toBe("보유");
    expect(isPortfolioAwareOperationalEntry(input, held, "2026-10-02")).toBe(false);
    expect(isPortfolioAwareOperationalEntry(input, null, "2026-10-02")).toBe(false);
  });

  it("retains KOSPI 9.5 upward-cross exit priority despite rejected raw entry evidence", () => {
    const input = candidate(9.5, 5.5);
    expect(getPortfolioAwareDisplayStatus(input, held, "2026-10-02")).toBe(
      "청산 대기 · KOSPI 9.5점 상향돌파",
    );
    expect(isPortfolioAwareOperationalEntry(input, held, "2026-10-02")).toBe(false);
  });

  it("does not emit a new exit merely for remaining at or above 9.5", () => {
    expect(getPortfolioAwareDisplayStatus(candidate(9.5, 9.5), held, "2026-10-02")).toBe("보유");
  });
});
