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
  it("labels a KOSPI 8-point threshold crossing as a new entry candidate", () => {
    expect(
      getDisplayStatus(row({ kospiEightPointEntry: true, kospi80Onset: true, rs20: 4, rs60: 5 })),
    ).toBe("KOSPI 8.0 Onset · 신규 진입");
  });

  it("adds RS confirmation when KOSPI RSAccel is positive", () => {
    expect(
      getDisplayStatus(row({ kospiEightPointEntry: true, kospi80Onset: true, rs20: 6, rs60: 2 })),
    ).toBe("KOSPI 8.0 Onset · 신규 진입 · RS 확인");
  });

  it("does not confirm relative momentum when RSAccel is zero or unavailable", () => {
    expect(
      getDisplayStatus(row({ kospiEightPointEntry: true, kospi80Onset: true, rs20: 3, rs60: 3 })),
    ).toBe("KOSPI 8.0 Onset · 신규 진입");
    expect(
      getDisplayStatus(
        row({ kospiEightPointEntry: true, kospi80Onset: true, rs20: null, rs60: 3 }),
      ),
    ).toBe("KOSPI 8.0 Onset · 신규 진입");
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
});
