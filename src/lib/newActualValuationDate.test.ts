import { describe, expect, it } from "vitest";
import { newActualValuationDate } from "./newActualValuationDate";

describe("actual valuation exchange-session cutoff", () => {
  it.each([
    ["KRW", "2026-10-17T06:00:00Z", "2026-10-16"],
    ["KRW", "2026-10-18T06:00:00Z", "2026-10-16"],
    ["KRW", "2026-10-19T06:29:59Z", "2026-10-16"],
    ["KRW", "2026-10-19T06:30:00Z", "2026-10-19"],
    ["KRW", "2026-12-25T08:00:00Z", "2026-12-24"],
    ["USD", "2026-10-16T19:59:59Z", "2026-10-15"],
    ["USD", "2026-10-16T20:00:00Z", "2026-10-16"],
    ["USD", "2026-10-17T06:00:00Z", "2026-10-16"],
    ["USD", "2026-11-27T17:59:59Z", "2026-11-25"],
    ["USD", "2026-11-27T18:00:00Z", "2026-11-27"],
    ["USD", "2026-12-24T18:00:00Z", "2026-12-24"],
  ] as const)("%s at %s uses %s", async (currency, now, expected) => {
    expect(await newActualValuationDate(currency, now)).toBe(expected);
  });

  it("uses the final reviewed KR session across the 2026/2027 boundary", async () => {
    expect(await newActualValuationDate("KRW", "2027-01-02T06:00:00Z")).toBe("2026-12-30");
  });

  it.each(["invalid", "2026-11-19T08:00:00Z"])(
    "does not invent a cutoff outside reviewed calendar/hours: %s",
    async (now) => expect(await newActualValuationDate("KRW", now)).toBeNull(),
  );
});
