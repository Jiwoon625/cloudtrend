import { describe, expect, it } from "vitest";
import { dashboardInbox } from "./dashboardInbox";
import type { DashboardMarketSignals, DashboardSignal } from "./dashboardOperations";
const row = (symbol: string) =>
  ({
    symbol,
    name: symbol,
    market: "KOSDAQ",
    date: "2026-10-16",
    sector: "test",
    price: 100,
    score: 8,
    priority: 0,
    reason: "fixture",
  }) as DashboardSignal;
describe("daily signal inbox", () => {
  it("shows actual exits first, deduplicates overlapping signals, and retains raw rejected entries", () => {
    const market: DashboardMarketSignals = {
      market: "KOSDAQ",
      date: "2026-10-16",
      holdingsKnown: true,
      onsetCount: 2,
      exitCount: 1,
      exits: [row("exit")],
      onsets: [row("entry"), row("exit")],
      pending: [row("pending")],
      assessments: [
        {
          ...row("raw"),
          assessment: { current: true, rawOnset: true } as DashboardSignal["assessment"],
        },
      ],
    };
    expect(dashboardInbox([market]).map((r) => [r.symbol, r.inboxKind])).toEqual([
      ["exit", "exits"],
      ["entry", "onsets"],
      ["pending", "pending"],
      ["raw", "raw"],
    ]);
  });
});
