import { describe, expect, it } from "vitest";
import {
  isOperationalSignalDate,
  isOperationalSignalOrigin,
  OPERATIONAL_SIGNAL_START,
} from "./operationalSignalStart";
import { ACTUAL_PERFORMANCE_START } from "./ledger/actualPerformance";

describe("shared website market-session start policy", () => {
  it("matches the allocated actual series start without using a clock", () => {
    expect(OPERATIONAL_SIGNAL_START).toBe(ACTUAL_PERFORMANCE_START);
    expect(isOperationalSignalDate("2026-10-09")).toBe(false);
    expect(isOperationalSignalDate("2026-10-12")).toBe(true);
  });
  it.each([undefined, null, "", "2026-10-12T00:00:00Z", "2026-10-32", "2026-10-09"])(
    "rejects invalid or earlier session %s",
    (date) => {
      expect(isOperationalSignalDate(date)).toBe(false);
    },
  );
  it("cannot revive an earlier or unknown onset on a new confirmation date", () => {
    expect(isOperationalSignalOrigin("2026-10-12", "2026-10-09")).toBe(false);
    expect(isOperationalSignalOrigin("2026-10-12", null)).toBe(false);
    expect(isOperationalSignalOrigin("2026-10-12", "2026-10-13")).toBe(false);
    expect(isOperationalSignalOrigin("2026-10-13", "2026-10-12")).toBe(true);
  });
});
