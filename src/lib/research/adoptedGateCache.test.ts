import { afterEach, describe, expect, it, vi } from "vitest";
import { buildKospiEntrySnapshot } from "../engine/kospiEntryConfirmation";
import * as marketGate from "../engine/kospiMarketGate";
import { getMockDataset } from "../engine/mockProvider";
import { CURRENT_RULES_RESEARCH } from "../engine/operatingPolicyContext";
import { runAnalysis } from "../engine/pipeline";
import { DEFAULT_SCORING_CONFIG } from "../engine/scoring";
import { adoptedDatasetAsOf } from "./adoptedBacktestInput";

afterEach(() => vi.restoreAllMocks());

describe("call-scoped current-rules research market gates", () => {
  it("evaluates each date once and preserves every uncached KOSPI entry", () => {
    const dataset = structuredClone(getMockDataset());
    const evaluate = vi.spyOn(marketGate, "evaluateKospiMarketGateAtDate");
    const analysis = runAnalysis(dataset, DEFAULT_SCORING_CONFIG, CURRENT_RULES_RESEARCH);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(evaluate.mock.calls.map(([, date]) => date).sort()).toEqual(
      dataset.tradeDates.slice(-3),
    );
    for (const row of analysis.rows.filter((row) => row.instrument.market === "KOSPI")) {
      const uncached = buildKospiEntrySnapshot(
        dataset,
        row.instrument.symbol,
        DEFAULT_SCORING_CONFIG,
        CURRENT_RULES_RESEARCH,
      );
      expect(row.kospiEntry).toEqual(uncached.entry);
      expect(row.rs20).toEqual(uncached.rs20);
      expect(row.rs60).toEqual(uncached.rs60);
    }
    expect(analysis.kospiMarketGate).toEqual(
      marketGate.evaluateKospiMarketGateAtDate(dataset, dataset.asOfDate),
    );
  });

  it("never shares cached evidence across calls, dates, or an in-place source update", () => {
    const dataset = structuredClone(getMockDataset());
    const evaluate = vi.spyOn(marketGate, "evaluateKospiMarketGateAtDate");
    const first = runAnalysis(dataset, DEFAULT_SCORING_CONFIG, CURRENT_RULES_RESEARCH);
    expect(evaluate).toHaveBeenCalledTimes(3);
    const todayVolatility = dataset.vkospiObservations!.find(
      (point) => point.date === dataset.asOfDate,
    )!;
    todayVolatility.value = 99;
    evaluate.mockClear();
    const changed = runAnalysis(dataset, DEFAULT_SCORING_CONFIG, CURRENT_RULES_RESEARCH);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(changed.kospiMarketGate!.vkospi).toBe(99);
    expect(first.kospiMarketGate!.vkospi).not.toBe(99);

    const other = structuredClone(dataset);
    other.vkospiObservations = [];
    evaluate.mockClear();
    const missing = runAnalysis(other, DEFAULT_SCORING_CONFIG, CURRENT_RULES_RESEARCH);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(missing.kospiMarketGate).toMatchObject({ status: "UNKNOWN", vkospi: null });

    const previousDate = dataset.tradeDates.at(-2)!;
    const previous = adoptedDatasetAsOf(dataset, previousDate);
    evaluate.mockClear();
    const earlier = runAnalysis(previous, DEFAULT_SCORING_CONFIG, CURRENT_RULES_RESEARCH);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(evaluate.mock.calls.map(([, date]) => date).sort()).toEqual(
      dataset.tradeDates.slice(-4, -1),
    );
    expect(earlier.kospiMarketGate!.date).toBe(previousDate);
    expect(earlier.kospiMarketGate!.vkospi).not.toBe(99);
  });

  it("retains the uncached operating path and ignores a research evaluator without opt-in", () => {
    const dataset = structuredClone(getMockDataset());
    const evaluate = vi.spyOn(marketGate, "evaluateKospiMarketGateAtDate");
    const analysis = runAnalysis(dataset, DEFAULT_SCORING_CONFIG);
    const kospiRows = analysis.rows.filter((row) => row.instrument.market === "KOSPI");
    expect(evaluate).toHaveBeenCalledTimes(kospiRows.length * 3 + 1);
    const researchEvaluator = vi.fn(() => {
      throw new Error("The operating path must not consult a research cache");
    });
    const operating = buildKospiEntrySnapshot(
      dataset,
      kospiRows[0]!.instrument.symbol,
      DEFAULT_SCORING_CONFIG,
      undefined,
      researchEvaluator,
    );
    expect(researchEvaluator).not.toHaveBeenCalled();
    expect(operating.entry).toEqual(kospiRows[0]!.kospiEntry);
  });
});
