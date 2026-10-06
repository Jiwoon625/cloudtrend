import { describe, expect, it } from "vitest";
import { simulateStrategy, type ProspectiveKrReplayPolicy } from "../portfolioLedgers";
import { getOperationalSignals } from "../engine/operationalStrategy";
import type { DailyPrice } from "../engine/types";
import type { ScreeningSnapshot, SnapshotEntry } from "../screeningSnapshot";
const settings = {
  initialCapital: 100_000_000,
  maxPositions: 30,
  sectorCap: 0.3,
  roundTripCostRate: 0.003,
};
const policy: ProspectiveKrReplayPolicy = {
  version: "kr-adopted-shadow-20261005-v1",
  startDate: "2026-10-05",
  throughDate: "2026-10-08",
  scope: "KOSDAQ",
};
const entry = (symbol: string, sectorCode = "s"): SnapshotEntry => ({
  symbol,
  name: symbol,
  instrumentType: "STOCK",
  sectorCode,
  sectorName: sectorCode,
  grade: "A",
  status: "",
  totalScore: 80,
  scoreDelta1d: 5,
  technicalPoints: 8,
  priorityPoints: 5,
  hardFilterPassed: true,
  ...getOperationalSignals("KOSDAQ", 7.5, 8, true),
});
const snapshot = (date: string, entries: SnapshotEntry[]): ScreeningSnapshot => ({
  date,
  asOfDate: date,
  savedAt: `${date}T09:00:00Z`,
  entries,
  marketGateStatus: "",
  totalCount: entries.length,
  passedCount: entries.length,
  gradeACount: entries.length,
  gradeBCount: 0,
});
const bar = (tradeDate: string, price: number) =>
  ({
    tradeDate,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 1e6,
    tradingValue: 1e9,
    marketCap: null,
    foreignNetBuyValue: null,
    institutionNetBuyValue: null,
  }) satisfies DailyPrice;
describe("new KR adopted-series opt-in", () => {
  it("waits for post-start onset and next observed open, never uses future bars", () => {
    const result = simulateStrategy(
      settings,
      [snapshot("2026-10-02", [entry("OLD")]), snapshot("2026-10-06", [entry("NEW")])],
      {
        OLD: [bar("2026-10-06", 100)],
        NEW: [bar("2026-10-06", 100), bar("2026-10-07", 100), bar("2026-10-09", 999)],
      },
      { OLD: "KOSDAQ", NEW: "KOSDAQ" },
      "frozen",
      [],
      {},
      policy,
    );
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.symbol).toBe("NEW");
    expect(result.trades[0]!.entryDate).toBe("2026-10-07");
    expect(result.trades[0]!.currentPrice).toBe(100);
  });
  it("budgets initial capital/30 including fees and never rounds up one expensive share", () => {
    const run = (price: number) =>
      simulateStrategy(
        settings,
        [snapshot("2026-10-06", [entry("NEW")])],
        { NEW: [bar("2026-10-06", price), bar("2026-10-07", price)] },
        { NEW: "KOSDAQ" },
        "frozen",
        [],
        {},
        policy,
      );
    const result = run(2_000_000);
    expect(result.trades[0]!.shares).toBe(1);
    expect(result.trades[0]!.buyAmount + result.trades[0]!.entryFee).toBeLessThanOrEqual(
      settings.initialCapital / 30,
    );
    expect(run(4_000_000).trades).toHaveLength(0);
  });
  it("enforces independent KOSDAQ sector six and no foreign-market candidates", () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(`X${i}`));
    const result = simulateStrategy(
      settings,
      [snapshot("2026-10-06", entries)],
      Object.fromEntries(
        entries.map((e) => [e.symbol, [bar("2026-10-06", 100), bar("2026-10-07", 100)]]),
      ),
      Object.fromEntries(entries.map((e, i) => [e.symbol, i === 7 ? "KOSPI" : "KOSDAQ"])),
      "frozen",
      [],
      {},
      policy,
    );
    expect(result.trades).toHaveLength(6);
    expect(result.candidates).toHaveLength(7);
  });
  it("requires a new contract for year two or changed initial settings", () => {
    expect(() =>
      simulateStrategy(settings, [], {}, {}, "", [], {}, { ...policy, throughDate: "2027-10-05" }),
    ).toThrow();
    expect(() =>
      simulateStrategy({ ...settings, initialCapital: 1 }, [], {}, {}, "", [], {}, policy),
    ).toThrow();
  });
});

import { freezeAdoptedSeries } from "./modelSeries";
import { stepAdoptedKrSeries } from "./krAdoptedShadow";
const hash = `sha256:${"a".repeat(64)}` as const;
it("freezes daily KR prefixes, enforces T+1 finalization and reuses immutable same-date runs", async () => {
  const series = await freezeAdoptedSeries({
    kind: "KR_KOSDAQ",
    codeHash: hash,
    sourceHash: hash,
    frozenAt: "2026-10-08T12:00:00Z",
  });
  const calendar = {
    market: "KR" as const,
    sourceHash: hash,
    coverageStart: "2026-10-12",
    coverageEnd: "2026-10-14",
    regularSessions: ["2026-10-12", "2026-10-13", "2026-10-14"],
  };
  const firstSnapshot = {
    ...snapshot("2026-10-12", [entry("NEW")]),
    savedAt: "2026-10-12T22:50:00Z",
  };
  const firstInput = {
    date: "2026-10-12",
    codeHash: hash,
    sourceHash: hash,
    configHash: series.configHash,
    availableAt: "2026-10-12T22:50:00Z",
    decisionAt: "2026-10-12T23:10:00Z",
    confirmedClose: true,
    snapshots: [firstSnapshot],
    bars: { NEW: [bar("2026-10-12", 100)] },
    markets: { NEW: "KOSDAQ" as const },
    marketGates: {},
    calendar,
  };
  const first = await stepAdoptedKrSeries(series, firstInput);
  expect(first.run.result.trades).toHaveLength(0);
  expect((await stepAdoptedKrSeries(series, firstInput, first.run)).status).toBe("REUSE");
  const nextSnapshot = {
    ...snapshot("2026-10-13", []),
    savedAt: "2026-10-13T22:50:00Z",
  };
  const nextInput = {
    ...firstInput,
    date: "2026-10-13",
    availableAt: "2026-10-13T22:50:00Z",
    decisionAt: "2026-10-13T23:10:00Z",
    snapshots: [...firstInput.snapshots, nextSnapshot],
    bars: { NEW: [...firstInput.bars.NEW, bar("2026-10-13", 100)] },
  };
  const next = await stepAdoptedKrSeries(series, nextInput, first.run);
  expect(next.run.result.trades).toHaveLength(1);
  await expect(
    stepAdoptedKrSeries(
      series,
      { ...nextInput, bars: { NEW: [bar("2026-10-12", 99), bar("2026-10-13", 100)] } },
      first.run,
    ),
  ).rejects.toThrow("historical inputs changed");
  await expect(
    stepAdoptedKrSeries(
      series,
      {
        ...nextInput,
        availableAt: "2026-10-14T00:10:00Z",
        decisionAt: "2026-10-14T00:20:00Z",
      },
      first.run,
    ),
  ).rejects.toThrow("T+1 pre-open");
});
it("keeps new KR fees/cash at the same exact precision as US/ETF", () => {
  const result = simulateStrategy(
    settings,
    [snapshot("2026-10-06", [entry("NEW")])],
    { NEW: [bar("2026-10-06", 99999), bar("2026-10-07", 99999)] },
    { NEW: "KOSDAQ" },
    "frozen",
    [],
    {},
    policy,
  );
  expect(result.trades[0]!.entryFee).toBe(4949.9505);
  expect(result.modelAccounting!.fees["NEW|2026-10-06"]!.entry).toBe("4949.9505");
  expect(result.modelAccounting!.cash).toBe("96695083.0495");
});
