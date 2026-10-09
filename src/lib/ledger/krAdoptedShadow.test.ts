import { describe, expect, it } from "vitest";
import { simulateStrategy, type ProspectiveKrReplayPolicy } from "../portfolioLedgers";
import { getOperationalSignals } from "../engine/operationalStrategy";
import type { DailyPrice } from "../engine/types";
import type { ScreeningSnapshot, SnapshotEntry } from "../screeningSnapshot";
import { isKrOfficialShadowDecision, nextKrRegularSession } from "./krShadowDecision";
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
const officialSavedAt = (date: string) => {
  const next = nextKrRegularSession(date);
  if (!next) throw new Error("Missing reviewed next KR session");
  return `${next}T08:00:00+09:00`;
};
const snapshot = (date: string, entries: SnapshotEntry[]): ScreeningSnapshot => ({
  date,
  asOfDate: date,
  savedAt: officialSavedAt(date),
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

import { freezeAdoptedSeries, freezeRestartSeries } from "./modelSeries";
import { stepAdoptedKrSeries } from "./krAdoptedShadow";
const hash = `sha256:${"a".repeat(64)}` as const;
it("freezes daily KR prefixes, enforces calendar sequence and reuses immutable same-date runs", async () => {
  const series = await freezeAdoptedSeries({
    kind: "KR_KOSDAQ",
    codeHash: hash,
    sourceHash: hash,
    frozenAt: "2026-10-02T12:00:00Z",
  });
  const calendar = {
    market: "KR" as const,
    sourceHash: hash,
    coverageStart: "2026-10-01",
    coverageEnd: "2026-10-08",
    regularSessions: ["2026-10-01", "2026-10-02", "2026-10-06", "2026-10-07", "2026-10-08"],
  };
  const firstInput = {
    date: "2026-10-06",
    codeHash: hash,
    sourceHash: hash,
    configHash: series.configHash,
    availableAt: "2026-10-07T08:00:00+09:00",
    decisionAt: "2026-10-07T08:10:00+09:00",
    confirmedClose: true,
    snapshots: [snapshot("2026-10-06", [entry("NEW")])],
    bars: { NEW: [bar("2026-10-06", 100)] },
    markets: { NEW: "KOSDAQ" as const },
    marketGates: {},
    calendar,
  };
  const first = await stepAdoptedKrSeries(series, firstInput);
  expect(first.run.result.trades).toHaveLength(0);
  expect((await stepAdoptedKrSeries(series, firstInput, first.run)).status).toBe("REUSE");
  const nextInput = {
    ...firstInput,
    date: "2026-10-07",
    availableAt: "2026-10-08T08:00:00+09:00",
    decisionAt: "2026-10-08T08:10:00+09:00",
    snapshots: [...firstInput.snapshots, snapshot("2026-10-07", [])],
    bars: { NEW: [...firstInput.bars.NEW, bar("2026-10-07", 100)] },
  };
  const next = await stepAdoptedKrSeries(series, nextInput, first.run);
  expect(next.run.result.trades).toHaveLength(1);
  await expect(
    stepAdoptedKrSeries(
      series,
      { ...nextInput, bars: { NEW: [bar("2026-10-06", 99), bar("2026-10-07", 100)] } },
      first.run,
    ),
  ).rejects.toThrow("historical inputs changed");
  await expect(
    stepAdoptedKrSeries(
      series,
      {
        ...nextInput,
        availableAt: "2026-10-08T18:00:00+09:00",
        decisionAt: "2026-10-08T18:10:00+09:00",
      },
      first.run,
    ),
  ).rejects.toThrow(/next-session-morning/);
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

describe("KR Shadow official timing", () => {
  it("keeps the same-evening run as preview and accepts next-morning KRX completion", () => {
    expect(
      isKrOfficialShadowDecision(
        "2026-10-06",
        "2026-10-06T20:00:00+09:00",
        "2026-10-06T20:10:00+09:00",
      ),
    ).toBe(false);
    expect(
      isKrOfficialShadowDecision(
        "2026-10-06",
        "2026-10-07T08:00:00+09:00",
        "2026-10-07T08:10:00+09:00",
      ),
    ).toBe(true);
  });

  it("uses the next reviewed regular session across the 10/9 holiday and weekend", () => {
    expect(nextKrRegularSession("2026-10-08")).toBe("2026-10-12");
    expect(
      isKrOfficialShadowDecision(
        "2026-10-08",
        "2026-10-12T08:00:00+09:00",
        "2026-10-12T08:10:00+09:00",
      ),
    ).toBe(true);
  });

  it("rejects a stale source and any decision after the next market open", () => {
    expect(
      isKrOfficialShadowDecision(
        "2026-10-06",
        "2026-10-06T20:00:00+09:00",
        "2026-10-07T08:10:00+09:00",
      ),
    ).toBe(false);
    expect(
      isKrOfficialShadowDecision(
        "2026-10-06",
        "2026-10-07T08:00:00+09:00",
        "2026-10-07T09:01:00+09:00",
      ),
    ).toBe(false);
  });
});

import legacyPrefix from "../../../tests/fixtures/market-cap-legacy-prefix.json";
import type { AdoptedKrRun, KrSeriesInputs } from "./krAdoptedShadow";
import type { FrozenModelSeries } from "./modelSeries";

it("preserves the pre-patch frozen legacy prefix and next-session continuation byte-for-byte", async () => {
  // Generated on clean main e8c6687 with synthetic input, including a legacy
  // false hardFilterPassed flag which old replay intentionally did not consult.
  const series = legacyPrefix.series as FrozenModelSeries;
  const firstInput = legacyPrefix.firstInput as KrSeriesInputs;
  const previous = legacyPrefix.first.run as AdoptedKrRun;
  const nextInput = legacyPrefix.nextInput as KrSeriesInputs;
  const originalBytes = JSON.stringify(previous);
  expect(await stepAdoptedKrSeries(series, firstInput)).toEqual(legacyPrefix.first);
  expect(await stepAdoptedKrSeries(series, firstInput, previous)).toEqual({
    status: "REUSE",
    run: previous,
  });
  expect(await stepAdoptedKrSeries(series, nextInput, previous)).toEqual(legacyPrefix.next);
  expect(JSON.stringify(previous)).toBe(originalBytes);
  expect(legacyPrefix.next.run.result.trades).toHaveLength(1);
});

it("matches portfolio and adopted Shadow candidates, integer fills, cash and holdings for the same restart contract", async () => {
  const series = await freezeRestartSeries({
    kind: "KR_KOSDAQ",
    codeHash: hash,
    sourceHash: hash,
    frozenAt: "2026-10-09T00:00:00Z",
  });
  const dates = ["2026-10-12", "2026-10-13", "2026-10-14"];
  const calendar = {
    market: "KR" as const,
    sourceHash: hash,
    coverageStart: dates[0]!,
    coverageEnd: dates[2]!,
    regularSessions: dates,
  };
  let previous: AdoptedKrRun | null = null;
  const snapshots: ScreeningSnapshot[] = [];
  for (const [index, date] of dates.entries()) {
    const next = nextKrRegularSession(date)!;
    snapshots.push(snapshot(date, index === 0 ? [entry("NEW")] : []));
    const prices = {
      NEW: dates
        .slice(0, index + 1)
        .filter((day) => day !== "2026-10-14")
        .map((day) => bar(day, 99999)),
      OTHER: dates.slice(0, index + 1).map((day) => bar(day, 100)),
    };
    const markets = { NEW: "KOSDAQ" as const, OTHER: "KOSPI" as const };
    const input = {
      date,
      codeHash: hash,
      sourceHash: hash,
      configHash: series.configHash,
      availableAt: `${next}T08:00:00+09:00`,
      decisionAt: `${next}T08:10:00+09:00`,
      confirmedClose: true,
      snapshots: [...snapshots],
      bars: prices,
      markets,
      marketGates: {},
      calendar,
    };
    const { run } = await stepAdoptedKrSeries(series, input, previous);
    const portfolio = simulateStrategy(
      settings,
      snapshots,
      prices,
      markets,
      run.result.fingerprint,
      dates.slice(0, index + 1),
      {},
      {
        version: "kr-common-execution-20261012-v1",
        startDate: "2026-10-12",
        throughDate: date,
        scope: "KOSDAQ",
      },
    );
    portfolio.calculatedAt = run.result.calculatedAt;
    expect(portfolio).toEqual(run.result);
    if (index === 1) {
      expect(portfolio.trades[0]!.shares).toBe(33);
      expect(portfolio.modelAccounting!.cash).toBe("96695083.0495");
    }
    if (index === 2) {
      expect(portfolio.trades[0]!.status).toBe("CLOSED");
      expect(portfolio.trades[0]!.exitPrice).toBe(99999);
      expect(portfolio.modelAccounting!.cash).toBe("99990100.099");
    }
    previous = run;
  }
});
