import { describe, expect, it } from "vitest";
import { actualDateWindow, couldCashTimingExplainShortfall } from "./newActualCashTiming";
describe("cash date uncertainty windows", () => {
  it.each([
    ["2026-03-08", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    ["2026-11-01", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
    ["2026-10-13", "2026-10-13T04:00:00Z", "2026-10-14T04:00:00Z"],
  ])("resolves New York DST boundaries for %s", (date, start, end) => {
    expect(actualDateWindow(date, "America/New_York")).toEqual({
      start: Date.parse(start),
      end: Date.parse(end),
    });
  });
  it("uses the Korean date without changing recorded dates", () => {
    expect(actualDateWindow("2026-10-14", "Asia/Seoul")).toEqual({
      start: Date.parse("2026-10-13T15:00:00Z"),
      end: Date.parse("2026-10-14T15:00:00Z"),
    });
  });
  it.each(["2026-03-08", "2026-11-01"])(
    "recognizes overlapping cash and trade dates at DST boundary %s",
    (date) => {
      const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      expect(
        couldCashTimingExplainShortfall([
          { date, change: -20n, timeZone: "America/New_York" },
          { date: next, change: 100n, timeZone: "Asia/Seoul" },
        ]),
      ).toBe(true);
    },
  );
  it("does not use a credit beginning after a debit's whole date window", () => {
    expect(
      couldCashTimingExplainShortfall([
        { date: "2026-10-13", change: -20n, timeZone: "America/New_York" },
        { date: "2026-10-15", change: 100n, timeZone: "Asia/Seoul" },
      ]),
    ).toBe(false);
  });
});
