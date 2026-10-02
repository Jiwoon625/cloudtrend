import {
  kospiEntryConfirmation,
  PREVIOUS_KOSPI_ENTRY_POLICY_VERSION,
} from "./kospiEntryConfirmation";
import { describe, expect, it } from "vitest";
import {
  getHeldOperationalExitSignal,
  getOperationalStatus,
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

describe("KOSPI executable strategy", () => {
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
        { date: "2026-10-05", score: 8.5, rsAccel: 1, eligible: true, observed: true },
        { date: "2026-10-02", score: 8, rsAccel: -1, eligible: true, observed: true },
        { date: "2026-10-01", score: 7.5, rsAccel: 0, eligible: true, observed: true },
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

describe("confirmation-day UP95 context", () => {
  const confirmation = kospiEntryConfirmation(
    { date: "2026-10-02", score: 9.5, rsAccel: 1, eligible: true, observed: true },
    { date: "2026-10-01", score: 8, rsAccel: -1, eligible: true, observed: true },
    { date: "2026-09-30", score: 7.5, rsAccel: 0, eligible: true, observed: true },
  );
  const signals = { ...getOperationalSignals("KOSPI", 8, 9.5, true), kospiEntry: confirmation };
  it("separates new entry readiness from the unchanged held exit", () => {
    expect(isOperationalEntry(signals, confirmation.date)).toBe(true);
    expect(getStoredOperationalExit(signals, "KOSPI")).toBe("UP95");
    expect(getHeldOperationalExitSignal("KOSPI", 9.5, 15)).toBe("UP95");
    expect(getOperationalStatus(signals, "KOSPI")).toContain(
      "미보유 다음 거래 가능 시가 진입 대기 / 보유 U9.5 청산",
    );
  });
  it("does not relax other exit signals or mismatched versions", () => {
    for (const exitSignal of ["DOWN25", "DOWN30", "UP90", "UNKNOWN"]) {
      expect(isOperationalEntry({ ...signals, exitSignal }, confirmation.date)).toBe(false);
    }
    expect(
      isOperationalEntry({
        ...signals,
        operationalSignalVersion: PREVIOUS_KOSPI_ENTRY_POLICY_VERSION,
      }),
    ).toBe(false);
    expect(
      getStoredOperationalExit(
        { ...signals, operationalSignalVersion: PREVIOUS_KOSPI_ENTRY_POLICY_VERSION },
        "KOSPI",
      ),
    ).toBe("UP95");
    const old = {
      ...signals,
      exitSignal: null,
      operationalSignalVersion: PREVIOUS_KOSPI_ENTRY_POLICY_VERSION,
      kospiEntry: { ...confirmation, score: 8.5, version: PREVIOUS_KOSPI_ENTRY_POLICY_VERSION },
    };
    expect(isOperationalEntry(old, confirmation.date)).toBe(true);
  });
});
