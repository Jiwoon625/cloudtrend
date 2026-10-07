import { kospiGate } from "../../../tests/kospi-policy-fixtures";
import { kospiEntryConfirmation } from "./kospiEntryConfirmation";
import { describe, expect, it } from "vitest";
import {
  getHeldOperationalExitSignal,
  getOperationalSignals,
  getStoredOperationalExit,
  isOperationalEntry,
  OPERATIONAL_SIGNAL_VERSION,
} from "./operationalStrategy";
import { getKosdaqOperationalExitSignal } from "./vfConfig";
import { getMockDataset } from "./mockProvider";
import { runFullMarketAnalysis } from "./fullMarketAnalysis";
import { runAnalysis } from "./pipeline";
import { buildSnapshot } from "../screeningSnapshot";
import { compactDashboardRow } from "../dashboardRow";
import { buildDashboardSummary } from "../screeningCacheContract";
import { buildScreeningSummary } from "../analysisRunBundle";

describe("KOSPI executable strategy", () => {
  it("vetoes pending or failed universe checks even when stale entry flags say yes", () => {
    const signals = getOperationalSignals("KOSDAQ", 7.5, 8, true);
    expect(isOperationalEntry(signals)).toBe(true); // legacy snapshots remain readable
    expect(isOperationalEntry({ ...signals, hardFilterPassed: false })).toBe(true);
    for (const guard of [
      { hardFilterStatus: "PASS" as const, hardFilterPassed: false },
      { hardFilterStatus: "PENDING" as const },
      { hardFilterStatus: "FAIL" as const },
      { hardFilterStatus: "PASS" as const, pendingRules: ["시가총액 자료 대기"] },
    ])
      expect(isOperationalEntry({ ...signals, ...guard })).toBe(false);
    expect(getHeldOperationalExitSignal("KOSDAQ", 9.5, 40)).toBe("UP90");
  });
  it("preserves pending evidence and numeric scores without counting it as failure or entry", () => {
    const analysis = runAnalysis(getMockDataset());
    const base = analysis.rows.find((r) => r.instrument.instrumentType === "STOCK")!;
    const pending = {
      ...base,
      instrument: { ...base.instrument, market: "KOSDAQ" as const },
      hardFilterPassed: false,
      hardFilterStatus: "PENDING" as const,
      pendingRules: ["시가총액 자료 대기"],
      failedRules: [],
      operatingScore10: 9.5,
      scoreDelta1d: 40,
      kosdaq80Onset: true, // defensive guard against inconsistent stored flags
      exitSignal: "UP90" as const,
    };
    analysis.rows = [pending];
    const snapshot = buildSnapshot(analysis);
    expect(snapshot.entries[0]).toMatchObject({
      hardFilterStatus: "PENDING",
      pendingRules: pending.pendingRules,
      technicalPoints: 9.5,
      scoreDelta1d: 40,
    });
    expect(isOperationalEntry(snapshot.entries[0]!)).toBe(false);
    expect(compactDashboardRow(pending)).toMatchObject({
      hardFilterStatus: "PENDING",
      pendingRules: pending.pendingRules,
      operatingScore10: 9.5,
    });
    const dashboard = buildDashboardSummary(analysis, "input", "result");
    expect(dashboard.counts).toMatchObject({
      passed: 0,
      disqualified: 0,
      pending: 1,
      kosdaq80Onsets: 0,
    });
    expect(dashboard.pendingReasons).toEqual([["시가총액 자료 대기", 1]]);
    expect(dashboard.onsetRows).toEqual([]);
    expect(dashboard.exitRows).toHaveLength(1);
    const summary = buildScreeningSummary(analysis, snapshot, null);
    expect(summary.counts).toMatchObject({
      passed: 0,
      failed: 0,
      pending: 1,
      operationalEntryCandidates: 0,
    });
    expect(summary.universePendingCandidates[0]).toMatchObject({
      hardFilterStatus: "PENDING",
      pendingRules: pending.pendingRules,
    });
  });
  it.each([
    [7.5, 8, true, null],
    [9, 9.5, false, "UP95"],
    [3, 2, false, null],
    [9.5, 9.5, false, null],
    [10, 9.5, false, null],
    [8, 8, false, null],
    [7.5, 9.5, true, null],
    [null, 8, false, null],
    [9, null, false, null],
  ])("%s -> %s: entry=%s exit=%s", (previous, current, entry, exit) => {
    const signals = getOperationalSignals("KOSPI", previous, current, true);
    expect(signals.kospi80Onset).toBe(entry);
    expect(isOperationalEntry(signals)).toBe(false); // raw onset always waits for confirmation
    expect(signals.exitSignal).toBe(exit);
    expect(getStoredOperationalExit(signals, "KOSPI")).toBe(exit);
  });
  it("rejects pre-adoption informational signals and legacy level-based exits", () => {
    expect(isOperationalEntry({ kospi80Onset: true })).toBe(false);
    expect(getStoredOperationalExit({ exitSignal: "UP95" }, "KOSPI")).toBeNull();
    expect(
      getStoredOperationalExit(
        { exitSignal: "DOWN25", operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION },
        "KOSPI",
      ),
    ).toBeNull();
    expect(isOperationalEntry(getOperationalSignals("KOSPI", 7.5, 8, false))).toBe(false);
    expect(isOperationalEntry(getOperationalSignals("ETF", 7.5, 8, true))).toBe(false);
  });
  it("reclassifies overlapping Onset as Exit only in held-position context", () => {
    const simmtech = getOperationalSignals("KOSDAQ", 5.5, 9.5, true);
    expect(simmtech.kosdaq80Onset).toBe(true);
    expect(simmtech.exitSignal).toBeNull();
    expect(getHeldOperationalExitSignal("KOSDAQ", 9.5, 40)).toBe("UP90");

    const tiger = getOperationalSignals("KOSDAQ", 8.5, 9, true);
    expect(tiger.kosdaq80Onset).toBe(false);
    expect(tiger.exitSignal).toBe("UP90");
    expect(getHeldOperationalExitSignal("KOSDAQ", 9, 5)).toBe("UP90");
  });

  it("preserves every half-point KOSDAQ score transition", () => {
    for (let prev = 0; prev <= 10; prev += 0.5)
      for (let cur = 0; cur <= 10; cur += 0.5) {
        const signals = getOperationalSignals("KOSDAQ", prev, cur, true);
        expect(signals.exitSignal).toBe(
          getKosdaqOperationalExitSignal(prev, cur, prev < 8 && cur >= 8),
        );
        expect(signals.kosdaq80Onset).toBe(prev < 8 && cur >= 8);
      }
  });
  it("preserves signals through snapshots, dashboard projections and combined counts", () => {
    const analysis = runAnalysis(getMockDataset());
    const base = analysis.rows.find((r) => r.instrument.instrumentType === "STOCK")!;
    const entry = {
      ...base,
      instrument: { ...base.instrument, market: "KOSPI" as const },
      ...getOperationalSignals("KOSPI", 8, 8.5, true),
      kospiEntry: kospiEntryConfirmation(
        {
          marketGate: kospiGate("2026-10-05"),
          date: "2026-10-05",
          score: 8.5,
          rsAccel: 1,
          eligible: true,
          observed: true,
        },
        {
          marketGate: kospiGate("2026-10-02"),
          date: "2026-10-02",
          score: 8,
          rsAccel: -1,
          eligible: true,
          observed: true,
        },
        {
          marketGate: kospiGate("2026-10-01"),
          date: "2026-10-01",
          score: 7.5,
          rsAccel: 0,
          eligible: true,
          observed: true,
        },
      ),
    };
    const exit = {
      ...entry,
      kospiEntry: undefined,
      ...getOperationalSignals("KOSPI", 9, 9.5, true),
    };
    analysis.asOfDate = "2026-10-05";
    analysis.rows = [entry, exit];
    const snapshot = buildSnapshot(analysis);
    expect(isOperationalEntry(snapshot.entries[0]!)).toBe(true);
    expect(getStoredOperationalExit(snapshot.entries[1]!, "KOSPI")).toBe("UP95");
    expect(isOperationalEntry(compactDashboardRow(entry))).toBe(true);
    const dashboard = buildDashboardSummary(analysis, "test", "test");
    expect(dashboard.counts.kospiEightPointEntries).toBe(1);
    expect(dashboard.counts.upsideExits).toBe(1);
    expect(dashboard.exitRows).toHaveLength(1);
  });
  it("does not overwrite V8 statuses with legacy orchestration labels", () => {
    const { analysis } = runFullMarketAnalysis(getMockDataset());
    for (const row of analysis.rows.filter((r) => r.instrument.instrumentType === "STOCK")) {
      expect(row.actionLabelText).not.toMatch(/우선진입후보|모멘텀 위험|^진입후보$/);
      expect(row.operationalSignalVersion).toBe(OPERATIONAL_SIGNAL_VERSION);
    }
  });
});
