import { describe, expect, it } from "vitest";
import { shadowTimelineAxis } from "./shadowTimelineAxis";
describe("Shadow calendar axis", () => {
  it("labels every calendar day over short periods, with actual weekend spacing", () => {
    const axis = shadowTimelineAxis("2026-10-12", "2026-10-21");
    expect(axis.ticks).toHaveLength(10);
    expect(axis.ticks).toContain("2026-10-17");
    expect(axis.label("2026-10-17")).toBe("10-17");
    expect(axis.fraction("2026-10-19") - axis.fraction("2026-10-16")).toBeCloseTo(
      3 * (axis.fraction("2026-10-16") - axis.fraction("2026-10-15")),
    );
  });
  it("uses aligned weekly labels for longer periods", () => {
    const axis = shadowTimelineAxis("2026-10-13", "2026-12-20");
    expect(axis.ticks.length).toBeLessThanOrEqual(13);
    expect(axis.ticks.every((date) => new Date(date + "T00:00:00Z").getUTCDay() === 1)).toBe(true);
    expect(axis.interval).toContain("1주");
  });
  it("bounds labels for two-year and decade-long histories", () => {
    const months = shadowTimelineAxis("2026-10-12", "2028-10-10");
    expect(months.ticks.length).toBeLessThanOrEqual(13);
    expect(months.ticks.every((date) => date.endsWith("-01"))).toBe(true);
    const years = shadowTimelineAxis("2026-10-12", "2046-10-12");
    expect(years.ticks.length).toBeLessThanOrEqual(11);
    expect(years.label(years.ticks[0]!)).toHaveLength(4);
  });
  it("centers a single observation and rejects malformed ranges", () => {
    expect(shadowTimelineAxis("2026-10-12", "2026-10-12").fraction("2026-10-12")).toBe(0.5);
    expect(() => shadowTimelineAxis("2026-10-13", "2026-10-12")).toThrow();
    expect(() => shadowTimelineAxis("bad", "2026-10-12")).toThrow();
  });
});
