import { describe, expect, it } from "vitest";

import {
  getKosdaqOperationalExitSignal,
  KOSDAQ_MAX_HOLDING_DAYS,
  selectV8SectorPriceLeadership,
  VF_ETF_PL_OVERHEAT_THRESHOLD_BY_MARKET,
  VF_STOCK_PL_FALLBACK_THRESHOLD,
} from "./vfConfig";

describe("KOSDAQ aggressive operating exit", () => {
  it("suppresses a same-day 8.0 onset overshoot", () => {
    expect(getKosdaqOperationalExitSignal(7.5, 9, true)).toBeNull();
  });

  it("fires only on a fresh 9.0 upward recross", () => {
    expect(getKosdaqOperationalExitSignal(8.5, 9, false)).toBe("UP90");
    expect(getKosdaqOperationalExitSignal(9.5, 9.5, false)).toBeNull();
  });

  it("fires only on a fresh 3.0 downward cross", () => {
    expect(getKosdaqOperationalExitSignal(3.5, 3, false)).toBe("DOWN30");
    expect(getKosdaqOperationalExitSignal(2.5, 2.5, false)).toBeNull();
  });

  it("keeps the validated maximum holding period at 60 trading days", () => {
    expect(KOSDAQ_MAX_HOLDING_DAYS).toBe(60);
  });
});


describe("V8 ETF-primary Sector Price Leadership", () => {
  it("uses ETF PL first with KOSPI 84 and KOSDAQ 85 thresholds", () => {
    expect(selectV8SectorPriceLeadership("KOSPI", 83.5, 40)).toEqual({
      value: 83.5,
      source: "ETF",
      threshold: VF_ETF_PL_OVERHEAT_THRESHOLD_BY_MARKET.KOSPI,
    });
    expect(selectV8SectorPriceLeadership("KOSDAQ", 84.5, 40)).toEqual({
      value: 84.5,
      source: "ETF",
      threshold: VF_ETF_PL_OVERHEAT_THRESHOLD_BY_MARKET.KOSDAQ,
    });
  });

  it("falls back to Stock PL at 80 only when ETF PL is unavailable", () => {
    expect(selectV8SectorPriceLeadership("KOSPI", null, 79.5)).toEqual({
      value: 79.5,
      source: "STOCK",
      threshold: VF_STOCK_PL_FALLBACK_THRESHOLD,
    });
    expect(selectV8SectorPriceLeadership("KOSDAQ", Number.NaN, 82)).toEqual({
      value: 82,
      source: "STOCK",
      threshold: VF_STOCK_PL_FALLBACK_THRESHOLD,
    });
  });

  it("returns no PL selection when both sources are unavailable", () => {
    expect(selectV8SectorPriceLeadership("KOSPI", null, null)).toEqual({
      value: null,
      source: null,
      threshold: null,
    });
  });
});
