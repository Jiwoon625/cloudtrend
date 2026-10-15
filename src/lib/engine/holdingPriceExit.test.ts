import { describe, it, expect } from "vitest";
import { evaluateHoldingPriceExit as evaluate, replayHoldingPriceExit } from "./holdingPriceExit";
import type { HoldingPriceExitInput } from "./holdingPriceExit";
import type { DailyPrice } from "./types";

const base: HoldingPriceExitInput = {
  market: "KOSPI",
  date: "2026-10-15",
  entryDate: "2026-10-12",
  entryPrice: "100000",
  quantity: "10",
  costBasis: "1001500",
  close: "92138",
  confirmedClose: true,
  historyComplete: true,
};
describe("prospective K4 / E4 holding exits", () => {
  it("includes actual entry fees and triggers at the exact -8% boundary", () => {
    expect(evaluate(base)).toMatchObject({ reason: "K4", threshold: "92138" });
    expect(evaluate({ ...base, close: "92138.00000001" }).reason).toBeNull();
    expect(evaluate({ ...base, close: "92137.99999999" }).reason).toBe("K4");
  });
  it("does not round fractional unit acquisition cost before comparison", () => {
    expect(
      evaluate({ ...base, quantity: "3", costBasis: "1", close: "0.30666667" }).reason,
    ).toBeNull();
    expect(evaluate({ ...base, quantity: "3", costBasis: "1", close: "0.30666666" }).reason).toBe(
      "K4",
    );
  });
  it("cannot backdate a signal and cannot use an unconfirmed close", () => {
    expect(evaluate({ ...base, date: "2026-10-14" }).status).toBe("NOT_EFFECTIVE");
    expect(evaluate({ ...base, confirmedClose: false }).reason).toBeNull();
    for (const close of [null, "0", "-1", "NaN"])
      expect(evaluate({ ...base, close }).reason).toBeNull();
  });
  it("uses entry and closes, retains the high water mark, and latches the first signal", () => {
    const input = { ...base, market: "ETF" as const, entryPrice: "10000", close: "12000" };
    const first = evaluate(input);
    expect(first.threshold).toBe("10800");
    const hit = evaluate({ ...input, date: "2026-10-16", close: "10800", state: first.state });
    expect(hit.reason).toBe("E4");
    const recovered = evaluate({ ...input, date: "2026-10-19", close: "14000", state: hit.state });
    expect(recovered.state).toMatchObject({
      peak: "14000",
      signalDate: "2026-10-16",
      signalThreshold: "10800",
    });
  });
  it("does not invent ETF peaks from truncated history or missing acquisition costs", () => {
    expect(evaluate({ ...base, market: "ETF", historyComplete: false }).status).toBe(
      "BASIS_PENDING",
    );
    expect(evaluate({ ...base, costBasis: null }).status).toBe("BASIS_PENDING");
  });
  it("replays only dated closes, excludes future and intraday high, and rejects gaps", () => {
    const bars = [
      { tradeDate: "2026-10-12", close: 100, high: 500 },
      { tradeDate: "2026-10-13", close: 120, high: 500 },
      { tradeDate: "2026-10-14", close: 119, high: 500 },
      { tradeDate: "2026-10-15", close: 108, high: 500 },
      { tradeDate: "2026-10-16", close: 1000, high: 1000 },
    ] as DailyPrice[];
    const holding = {
      market: "ETF" as const,
      entryDate: base.entryDate,
      entryPrice: "100",
      quantity: "10",
      costBasis: "1001.5",
    };
    const dates = bars.map((b) => b.tradeDate);
    expect(replayHoldingPriceExit(holding, bars, "2026-10-15", dates)).toMatchObject({
      reason: "E4",
      threshold: "108",
    });
    expect(
      replayHoldingPriceExit(
        holding,
        bars.filter((b) => b.tradeDate !== "2026-10-13"),
        "2026-10-15",
        dates,
      )?.reason,
    ).toBeNull();
  });
  it("rejects reverse chronology and invalid policy state", () => {
    const state = evaluate(base).state;
    expect(() => evaluate({ ...base, date: "2026-10-14", state })).toThrow();
    expect(() => evaluate({ ...base, date: "bad" })).toThrow();
  });
});
