import { describe, expect, it } from "vitest";

import type { ScreeningRow } from "./engine/pipeline";
import type { Instrument } from "./engine/types";
import { getDisplayStatus } from "./statusDisplay";

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
  it("labels a KOSPI 8-point threshold crossing as a new entry candidate", () => {
    expect(getDisplayStatus(row({ kospiEightPointEntry: true, rs20: 4, rs60: 5 }))).toBe(
      "8점 신규 진입 후보",
    );
  });

  it("adds RS confirmation when KOSPI RSAccel is positive", () => {
    expect(getDisplayStatus(row({ kospiEightPointEntry: true, rs20: 6, rs60: 2 }))).toBe(
      "8점 신규 진입 후보 · RS 확인",
    );
  });

  it("does not confirm relative momentum when RSAccel is zero or unavailable", () => {
    expect(getDisplayStatus(row({ kospiEightPointEntry: true, rs20: 3, rs60: 3 }))).toBe(
      "8점 신규 진입 후보",
    );
    expect(getDisplayStatus(row({ kospiEightPointEntry: true, rs20: null, rs60: 3 }))).toBe(
      "8점 신규 진입 후보",
    );
  });

  it("keeps the official KOSDAQ onset label unchanged", () => {
    expect(
      getDisplayStatus(
        row({
          instrument: instrument("KOSDAQ"),
          kosdaq80Onset: true,
          rs20: 6,
          rs60: 2,
        }),
      ),
    ).toBe("KOSDAQ80 Onset");
  });
});
