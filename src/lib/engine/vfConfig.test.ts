import { describe, expect, it } from "vitest";

import { getKosdaqOperationalExitSignal, KOSDAQ_MAX_HOLDING_DAYS } from "./vfConfig";

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
