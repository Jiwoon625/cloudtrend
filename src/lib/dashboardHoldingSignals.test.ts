import { describe, expect, it } from "vitest";
import type { ScreeningRow } from "./engine/pipeline";
import type { PortfolioState } from "./portfolioStoreCore";
import type { DashboardSummary } from "./screeningCacheContract";
import { applyHoldingSignalPriority } from "./dashboardHoldingSignals";

function row(
  symbol: string,
  score: number,
  delta: number,
  onset: boolean,
  exitSignal: ScreeningRow["exitSignal"] = null,
): ScreeningRow {
  return {
    instrument: {
      symbol,
      name: symbol,
      market: "KOSDAQ",
      instrumentType: "STOCK",
      sectorCode: "IT_HW",
      sectorName: "IT·전자부품",
    },
    operatingScore10: score,
    scoreDelta1d: delta,
    kosdaq80Onset: onset,
    kospi80Onset: false,
    kospiEightPointEntry: false,
    exitSignal,
  } as ScreeningRow;
}

function portfolio(symbols: string[]): PortfolioState {
  return {
    trades: symbols.map(
      (symbol) =>
        ({
          symbol,
          status: "OPEN",
          shares: 10,
        }) as PortfolioState["trades"][number],
    ),
  } as PortfolioState;
}

describe("dashboard holding-aware signal priority", () => {
  it("moves held overlapping Onset to Exit while preserving an existing Exit", () => {
    const simmtech = row("222800", 9.5, 40, true, null);
    const tiger = row("219130", 9, 5, false, "UP90");
    const summary = {
      counts: {
        total: 2,
        passed: 2,
        disqualified: 0,
        kosdaq80Onsets: 1,
        kospiEightPointEntries: 0,
        kospiRelativeQualityConfirmed: 0,
        upsideExits: 1,
        downsideExits: 0,
        incomplete: 0,
      },
      onsetRows: [simmtech],
      kospiEntryRows: [],
      exitRows: [tiger],
      top: [simmtech, tiger],
    } as DashboardSummary;

    const adjusted = applyHoldingSignalPriority(summary, portfolio(["222800", "219130"]));

    expect(adjusted.counts.kosdaq80Onsets).toBe(0);
    expect(adjusted.counts.upsideExits).toBe(2);
    expect(adjusted.onsetRows).toHaveLength(0);
    expect(adjusted.exitRows.map((item) => item.instrument.symbol).sort()).toEqual([
      "219130",
      "222800",
    ]);
    expect(adjusted.exitRows.find((item) => item.instrument.symbol === "222800")).toMatchObject({
      kosdaq80Onset: false,
      exitSignal: "UP90",
    });
  });

  it("keeps the generic Onset unchanged when the stock is not held", () => {
    const simmtech = row("222800", 9.5, 40, true, null);
    const summary = {
      counts: {
        total: 1,
        passed: 1,
        disqualified: 0,
        kosdaq80Onsets: 1,
        kospiEightPointEntries: 0,
        kospiRelativeQualityConfirmed: 0,
        upsideExits: 0,
        downsideExits: 0,
        incomplete: 0,
      },
      onsetRows: [simmtech],
      kospiEntryRows: [],
      exitRows: [],
      top: [simmtech],
    } as DashboardSummary;

    const adjusted = applyHoldingSignalPriority(summary, portfolio([]));
    expect(adjusted.onsetRows).toHaveLength(1);
    expect(adjusted.exitRows).toHaveLength(0);
    expect(adjusted.counts.kosdaq80Onsets).toBe(1);
  });
});
