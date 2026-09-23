import { describe, it, expect } from "vitest";
import { buildSnapshot } from "../src/lib/screeningSnapshot";
import { createPortfolioStore } from "../src/lib/portfolioCore";

describe("twice daily screening", () => {
  it("keys evening and next-morning snapshots by the same trading date", () => {
    const dates = ["2026-09-23T11:10:00Z", "2026-09-23T23:10:00Z"];
    const snapshots = dates.map((calculatedAt) =>
      buildSnapshot({
        asOfDate: "2026-09-23",
        calculatedAt,
        rows: [],
        marketGate: { status: "NEUTRAL" },
      }),
    );
    expect(snapshots.map((x) => x.date)).toEqual(["2026-09-23", "2026-09-23"]);
    expect(snapshots[0]!.savedAt).not.toBe(snapshots[1]!.savedAt);
  });
  it("loads server-side without browser or session modules", () => {
    expect(typeof createPortfolioStore).toBe("function");
  });
});
