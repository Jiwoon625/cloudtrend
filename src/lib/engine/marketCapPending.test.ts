import { describe, expect, it } from "vitest";
import { getMockDataset } from "./mockProvider";
import { computeIndicators } from "./indicators";
import { ALL_AVAILABLE, DEFAULT_SCORING_CONFIG, evaluateUniverse } from "./scoring";
import { runAnalysis } from "./pipeline";
import { getHeldOperationalExitSignal, isOperationalEntry } from "./operationalStrategy";
import {
  buildKospiEntrySnapshot,
  isKospiEntryReady,
  kospiEntryConfirmation,
} from "./kospiEntryConfirmation";
import { kospiGate } from "../../../tests/kospi-policy-fixtures";

const dataset = () => structuredClone(getMockDataset());
const validStock = () => {
  const ds = dataset();
  const instrument = ds.instruments.find(
    (i) => i.market === "KOSDAQ" && i.instrumentType === "STOCK",
  )!;
  const bars = ds.bars[instrument.symbol]!;
  return { instrument, snapshot: computeIndicators(bars, bars.length - 1) };
};

describe("current-session stock market-cap prerequisite", () => {
  it.each([null, 0, -1, NaN, Infinity])(
    "keeps unavailable cap %s pending, not failed or passed",
    (cap) => {
      const { instrument, snapshot } = validStock();
      const result = evaluateUniverse(
        instrument,
        snapshot,
        cap,
        0,
        300,
        undefined,
        DEFAULT_SCORING_CONFIG.universe,
      );
      expect(result).toMatchObject({
        passed: false,
        status: "PENDING",
        failedRules: [],
        skippedRules: [],
      });
      expect(result.pendingRules).toEqual(["기준일 시가총액 미확인 · 판단 보류"]);
    },
  );
  it("does not bypass cap validation when the dataset capability is absent", () => {
    const { instrument, snapshot } = validStock();
    expect(
      evaluateUniverse(
        instrument,
        snapshot,
        1e12,
        0,
        300,
        undefined,
        DEFAULT_SCORING_CONFIG.universe,
        { ...ALL_AVAILABLE, marketCap: false },
      ).status,
    ).toBe("PENDING");
  });
  it("keeps a known filter failure distinct while retaining the missing prerequisite", () => {
    const { instrument, snapshot } = validStock();
    const result = evaluateUniverse(
      instrument,
      { ...snapshot, close: 1 },
      null,
      0,
      300,
      undefined,
      DEFAULT_SCORING_CONFIG.universe,
    );
    expect(result.status).toBe("FAIL");
    expect(result.pendingRules).toHaveLength(1);
    expect(result.failedRules).toEqual(["주가 3,000원 미만"]);
  });
  it("resolves a same-date cap to pass or threshold failure", () => {
    const { instrument, snapshot } = validStock();
    const evaluate = (cap: number) =>
      evaluateUniverse(
        instrument,
        snapshot,
        cap,
        0,
        300,
        undefined,
        DEFAULT_SCORING_CONFIG.universe,
      );
    expect(evaluate(300e9)).toMatchObject({ passed: true, status: "PASS", pendingRules: [] });
    expect(evaluate(300e9 - 1)).toMatchObject({
      passed: false,
      status: "FAIL",
      pendingRules: [],
      failedRules: ["시가총액 기준 미달"],
    });
  });
  it("applies to every stock while preserving raw scores, NO_DATA and held exits", () => {
    const ds = dataset();
    const before = runAnalysis(ds);
    for (const i of ds.instruments.filter((i) => i.instrumentType === "STOCK"))
      ds.bars[i.symbol]!.at(-1)!.marketCap = null;
    const after = runAnalysis(ds);
    for (const row of after.rows.filter((r) => r.instrument.instrumentType === "STOCK")) {
      const old = before.rows.find((r) => r.instrument.symbol === row.instrument.symbol)!;
      expect(row.marketCap).toBeNull();
      expect(row.hardFilterPassed).toBe(false);
      expect(row.hardFilterStatus).toBe(row.failedRules.length ? "FAIL" : "PENDING");
      expect(row.pendingRules).toHaveLength(1);
      expect(row.operatingScore10).toBe(old.operatingScore10);
      expect(row.technical).toEqual(old.technical);
      expect(row.scoreDelta1d).toBe(old.scoreDelta1d);
      expect(row.dataCompletenessRatio).toBe(old.dataCompletenessRatio);
      expect(isOperationalEntry(row, ds.asOfDate)).toBe(false);
      expect(
        getHeldOperationalExitSignal(row.instrument.market, row.operatingScore10, row.scoreDelta1d),
      ).toBe(
        getHeldOperationalExitSignal(old.instrument.market, old.operatingScore10, old.scoreDelta1d),
      );
    }
    expect(after.rows.filter((r) => r.instrument.instrumentType === "ETF")).toEqual(
      before.rows.filter((r) => r.instrument.instrumentType === "ETF"),
    );
  });
  it("does not carry yesterday's cap into a stale stock's current row", () => {
    const ds = dataset();
    const i = ds.instruments.find((i) => i.market === "KOSDAQ" && i.instrumentType === "STOCK")!;
    ds.bars[i.symbol]!.pop();
    expect(ds.bars[i.symbol]!.at(-1)!.marketCap).toBeGreaterThan(0);
    const row = runAnalysis(ds).rows.find((r) => r.instrument.symbol === i.symbol)!;
    expect(row.marketCap).toBeNull();
    expect(row.hardFilterStatus).toBe("PENDING");
    expect(isOperationalEntry(row)).toBe(false);
  });
  it("rechecks the exact same session when its cap arrives, without a new price bar", () => {
    const ds = dataset();
    const i = ds.instruments.find((i) => i.market === "KOSPI" && i.instrumentType === "STOCK")!;
    const bar = ds.bars[i.symbol]!.at(-1)!;
    const cap = bar.marketCap;
    const baseline = runAnalysis(ds).rows.find((r) => r.instrument.symbol === i.symbol)!;
    bar.marketCap = null;
    expect(
      runAnalysis(ds).rows.find((r) => r.instrument.symbol === i.symbol)!.hardFilterStatus,
    ).toBe("PENDING");
    expect(
      buildKospiEntrySnapshot(ds, i.symbol, DEFAULT_SCORING_CONFIG).current.eligibilityStatus,
    ).toBe("PENDING");
    bar.marketCap = cap;
    expect(runAnalysis(ds).rows.find((r) => r.instrument.symbol === i.symbol)).toEqual(baseline);
  });
});

describe("KOSPI confirmation with a missing market-cap prerequisite", () => {
  const observation = (date: string, score: number) => ({
    date,
    score,
    eligible: true,
    observed: true,
    rsAccel: 1,
    marketGate: kospiGate(date),
  });
  const before = observation("2026-10-01", 7.5);
  const onset = observation("2026-10-02", 8);
  const confirm = observation("2026-10-05", 8.5);
  it.each(["origin", "confirmation"])(
    "cannot confirm when %s cap is pending, but resolves on same-date repair",
    (phase) => {
      const pending = {
        eligible: false,
        eligibilityStatus: "PENDING" as const,
        pendingRules: ["기준일 시가총액 미확인 · 판단 보류"],
      };
      const result = kospiEntryConfirmation(
        phase === "confirmation" ? { ...confirm, ...pending } : confirm,
        phase === "origin" ? { ...onset, ...pending } : onset,
        before,
      );
      expect(result.state).toBe("unobservable");
      expect(result.issues.join(" ")).toContain("판단 보류");
      expect(result.originDate).toBe(onset.date);
      expect(isKospiEntryReady(result, confirm.date)).toBe(false);
      expect(isKospiEntryReady(kospiEntryConfirmation(confirm, onset, before), confirm.date)).toBe(
        true,
      );
    },
  );
  it("retains an observed confirmation failure alongside cap unavailability", () => {
    const result = kospiEntryConfirmation(
      { ...confirm, rsAccel: -1, eligible: false, eligibilityStatus: "PENDING" },
      onset,
      before,
    );
    expect(result.state).toBe("rejected");
    expect(result.issues).toContain("확인일 RSAccel 0 이하");
    expect(result.issues).not.toContain("확인일 대상 부적격");
  });
});
