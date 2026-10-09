import { describe, expect, it } from "vitest";
import { ETF_POLICY, type EtfStrategySnapshot } from "../engine/etfStrategy";
import { CURRENT_RULES_RESEARCH } from "../engine/operatingPolicyContext";
import { decimal, format, multiply, fromLegacyNumber } from "../ledger/decimal";
import {
  initializeEtfAdoptedShadow,
  initializeEtfCurrentRulesResearch,
  stepEtfAdoptedShadow,
  type EtfShadowSessionInput,
} from "../ledger/etfAdoptedShadow";
import {
  freezeRestartSeries,
  hashSeriesValue,
  verifyFrozenSeries,
  type FrozenModelSeries,
  type SeriesHash,
} from "../ledger/modelSeries";
import {
  runAdoptedEtfBacktest,
  type AdoptedEtfBacktestInput,
  type EtfResearchObservedBar,
} from "./adoptedEtfBacktest";

const hash = (digit: string): SeriesHash => `sha256:${digit.repeat(64)}`;
const historicalDates = [
  "2019-01-02",
  "2019-01-03",
  "2019-01-04",
  "2019-01-07",
  "2019-01-08",
  "2019-01-09",
  "2019-01-10",
  "2019-01-11",
];
function strategy(
  date: string,
  previousDate: string,
  state: "none" | "pending" | "confirmed" = "none",
  changes: Partial<EtfStrategySnapshot> = {},
): EtfStrategySnapshot {
  return {
    version: ETF_POLICY.version,
    date,
    previousDate,
    eligible: true,
    score: 85,
    previousScore: state === "pending" ? 79 : 81,
    technical: 85,
    priority: 7,
    health: 14,
    environment: 14,
    environmentSource: "stock_sector",
    region: "KR",
    sector: "TECH",
    annualVolatility: 0.3,
    entryWeight: 0.05,
    underlyingClose: 100,
    underlyingMa60: 95,
    onset: state === "confirmed",
    rawOnset: state === "pending",
    entryState: state,
    originDate: state === "pending" ? date : state === "confirmed" ? previousDate : null,
    confirmationDate: state === "confirmed" ? date : null,
    confirmationIssues: [],
    averageTradingValue20: 1e9,
    dataStatus: "ready",
    krxReferenceDate: null,
    exit: null,
    issues: [],
    ...changes,
  };
}
function fixture(symbols = ["360750"], dates = historicalDates) {
  const snapshots = dates.map((date, i) => ({
    date,
    strategies: symbols.map((symbol) => ({
      symbol,
      strategy: strategy(
        date,
        dates[i - 1] ?? `${date.slice(0, 4)}-01-01`,
        i === 0 ? "pending" : i === 1 ? "confirmed" : "none",
      ),
    })),
  }));
  const observedBars: Record<string, EtfResearchObservedBar[]> = Object.fromEntries(
    symbols.map((symbol) => [
      symbol,
      dates.map((tradeDate) => ({ tradeDate, open: 10000, close: 10000, volume: 1000 })),
    ]),
  );
  const input: AdoptedEtfBacktestInput = {
    runId: "synthetic",
    allocationPolicy: "ADOPTED_VOLATILITY",
    startDate: dates[0]!,
    endDate: dates.at(-1)!,
    codeHash: hash("a"),
    sourceHash: hash("b"),
    calendar: {
      market: "KR",
      sourceHash: hash("c"),
      coverageStart: dates[0]!,
      coverageEnd: dates.at(-1)!,
      regularSessions: dates,
    },
    etfSymbols: symbols,
    observedBars,
    snapshots,
    includeRecords: true,
  };
  return { input, snapshots, observedBars };
}
function ignoreProvenance(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ignoreProvenance);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.endsWith("Hash") && key !== "bookId")
        .map(([key, child]) => [key, ignoreProvenance(child)]),
    );
  return value;
}

describe("current adopted ETF historical replay", () => {
  it("retains real historical dates and exact confirmation/next-open accounting", async () => {
    const { input } = fixture();
    const before = JSON.stringify(input);
    const result = await runAdoptedEtfBacktest(input);
    expect(result.contract.bookId).toBe("RESEARCH:ETF_V02:synthetic");
    expect(result.contract.accountingStartDate).toBe("2019-01-02");
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]).toMatchObject({
      side: "BUY",
      originDate: "2019-01-02",
      signalDate: "2019-01-03",
      executionDate: "2019-01-04",
      budgetNavDate: "2019-01-03",
      targetBudget: "5000000",
      quantity: "499",
      gross: "4990000",
      fee: "7485",
      cashDelta: "-4997485",
    });
    expect(result.dailyNav[2]).toMatchObject({
      nav: "99992515",
      cash: "95002515",
      positionCount: 1,
    });
    expect(result.finalState.positions).toHaveLength(1);
    expect(result.quality.terminalPositionsLiquidated).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("matches the unchanged production restart executor for every economic record", async () => {
    const dates = [
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-19",
    ];
    const { input, snapshots, observedBars } = fixture(["360750", "069500"], dates);
    observedBars["360750"]![2]!.volume = 0; // carried, then bought next open
    observedBars["069500"]![3]!.open = 12000;
    observedBars["069500"]![3]!.close = 12500;
    observedBars["360750"]![4]!.volume = 0; // close-recognized prior-session-open proxy
    snapshots[3]!.strategies[1]!.strategy.exit = "MA60";
    const research = await runAdoptedEtfBacktest(input);
    const series = await freezeRestartSeries({
      kind: "ETF_V02",
      frozenAt: "2026-10-09T00:00:00Z",
      codeHash: input.codeHash,
      sourceHash: input.sourceHash,
    });
    let state = await initializeEtfAdoptedShadow(series);
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i]!;
      const sessionInput: EtfShadowSessionInput = {
        sessionDate: date,
        previousSessionDate: dates[i - 1] ?? null,
        openAt: `${date}T00:00:00Z`,
        closeAt: `${date}T07:00:00Z`,
        decisionWindow: "SESSION_CLOSE",
        calendar: input.calendar,
        codeHash: series.codeHash,
        configHash: series.configHash,
        sourceHash: hash("d"),
        prices: input.etfSymbols
          .slice()
          .sort()
          .map((symbol) => {
            const bar = observedBars[symbol]![i]!;
            return {
              symbol,
              open: {
                asOfDate: date,
                availableAt: `${date}T00:00:00Z`,
                sourceHash: hash("d"),
                price: bar.open === null ? null : fromLegacyNumber(bar.open),
                volume: bar.volume,
              },
              close: {
                asOfDate: date,
                availableAt: `${date}T06:30:00Z`,
                sourceHash: hash("d"),
                price: bar.close === null ? null : fromLegacyNumber(bar.close),
              },
            };
          }),
        closeSignals: snapshots[i]!.strategies.map((row) => ({
          ...row,
          availableAt: `${date}T06:40:00Z`,
          sourceHash: hash("d"),
        })),
      };
      const stepped = await stepEtfAdoptedShadow(series, state, sessionInput);
      state = stepped.state;
      expect(ignoreProvenance(research.records![i])).toEqual(ignoreProvenance(stepped.record));
    }
    expect(ignoreProvenance(research.finalState)).toEqual(ignoreProvenance(state));
    // Research cannot enter the immutable production-series API, even on its start date.
    await expect(
      verifyFrozenSeries(research.contract as unknown as FrozenModelSeries),
    ).rejects.toThrow();
  });

  it("carries a missing or unobserved open without refreshing confirmation-day weights", async () => {
    const { input, snapshots, observedBars } = fixture();
    observedBars["360750"]![2]!.openObserved = false;
    observedBars["360750"]![3]!.volumeObserved = false;
    snapshots[3]!.strategies[0]!.strategy.annualVolatility = 0.01;
    const result = await runAdoptedEtfBacktest(input);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]).toMatchObject({
      executionDate: "2019-01-08",
      signalDate: "2019-01-03",
      targetBudget: "5000000",
      quantity: "499",
    });
    expect(result.quality.issueCounts.ENTRY_CARRIED).toBe(2);
  });

  it("holds ten without replacement and keeps confirmation liquidity order across carry", async () => {
    const symbols = Array.from({ length: 11 }, (_, i) => String(i + 1).padStart(6, "0"));
    const { input, snapshots, observedBars } = fixture(symbols);
    snapshots[1]!.strategies.forEach((row, i) => {
      row.strategy.averageTradingValue20 = i * 1e8;
    });
    // No open on first eligible session. Later liquidity changes must not reorder saved intents.
    symbols.forEach((symbol) => {
      observedBars[symbol]![2]!.volume = 0;
    });
    snapshots[2]!.strategies.forEach((row, i) => {
      row.strategy.averageTradingValue20 = (100 - i) * 1e8;
    });
    const result = await runAdoptedEtfBacktest(input);
    expect(result.fills.map((fill) => fill.symbol)).toEqual([...symbols].reverse().slice(0, 10));
    expect(result.finalState.positions).toHaveLength(10);
    expect(result.pending.pendingEntries).toHaveLength(1);
    expect(result.pending.pendingEntries[0]!.symbol).toBe("000001");
    expect(result.quality.issueCounts.ENTRY_EXPIRED_MAX_POSITIONS).toBeGreaterThan(0);
    expect(result.fills.every((fill) => fill.side === "BUY")).toBe(true);
  });

  it("carries an unaffordable integer budget and buys only when one share fits", async () => {
    const { input, observedBars } = fixture();
    observedBars["360750"]![2]!.open = 5_000_000;
    const result = await runAdoptedEtfBacktest(input);
    expect(result.records![2]!.fills).toEqual([]);
    expect(result.records![2]!.pendingEntries).toHaveLength(1);
    expect(result.fills[0]!.executionDate).toBe("2019-01-07");
    expect(result.quality.issueCounts.ENTRY_EXPIRED_INSUFFICIENT_BUDGET).toBe(1);
  });

  it("carries when cash cannot fund one share even though NAV target can, then uses a later real-open sale", async () => {
    const symbols = Array.from({ length: 10 }, (_, i) => String(i + 1).padStart(6, "0"));
    const { input, snapshots, observedBars } = fixture(symbols);
    for (let i = 0; i < snapshots.length; i++) {
      const date = historicalDates[i]!;
      for (const row of snapshots[i]!.strategies) row.strategy.annualVolatility = 0;
      snapshots[i]!.strategies[9]!.strategy = strategy(
        date,
        historicalDates[i - 1] ?? "2019-01-01",
        i === 2 ? "pending" : i === 3 ? "confirmed" : "none",
        { annualVolatility: 0 },
      );
      if (i >= 2) for (const symbol of symbols.slice(0, 9)) observedBars[symbol]![i]!.close = 50000;
      if (i >= 4) observedBars["000010"]![i]!.open = 19000000;
    }
    snapshots[4]!.strategies[0]!.strategy.exit = "MA60";
    const result = await runAdoptedEtfBacktest(input);
    expect(result.records![4]!.fills).toEqual([]);
    expect(result.records![4]!.issues).toContainEqual({
      symbol: "000010",
      code: "ENTRY_EXPIRED_INSUFFICIENT_BUDGET",
      phase: "OPEN",
    });
    expect(result.records![4]!.pendingEntries[0]!.symbol).toBe("000010");
    expect(result.records![5]!.fills.map((fill) => [fill.symbol, fill.side])).toEqual([
      ["000001", "SELL"],
      ["000010", "BUY"],
    ]);
    expect(result.records![5]!.fills[1]!.quantity).toBe("1");
    expect(decimal(result.records![5]!.fills[1]!.targetBudget!)).toBeGreaterThan(
      decimal(result.records![5]!.openingCash),
    );
  });

  it("defers buying until the previous NAV is complete, without using the recovered current close", async () => {
    const { input, snapshots, observedBars } = fixture(["360750", "069500"]);
    for (let i = 0; i < snapshots.length; i++) {
      const date = historicalDates[i]!;
      snapshots[i]!.strategies[1]!.strategy = strategy(
        date,
        historicalDates[i - 1] ?? "2019-01-01",
        i === 2 ? "pending" : i === 3 ? "confirmed" : "none",
      );
    }
    observedBars["360750"]![2]!.close = null;
    observedBars["360750"]![3]!.close = null;
    const result = await runAdoptedEtfBacktest(input);
    expect(result.dailyNav[3]!.nav).toBeNull();
    expect(result.records![4]!.fills).toEqual([]);
    expect(result.records![4]!.pendingEntries[0]!.symbol).toBe("069500");
    expect(result.fills[1]).toMatchObject({
      symbol: "069500",
      executionDate: "2019-01-09",
      budgetNavDate: "2019-01-08",
    });
    expect(result.quality.missingNavSessions).toBe(2);
    expect(result.quality.issueCounts.ENTRY_EXPIRED_INCOMPLETE_PRIOR_NAV).toBe(1);
  });

  it("carries stale prior NAV rather than sizing from a forward-filled or current mark", async () => {
    const { input, snapshots, observedBars } = fixture(["360750", "069500"]);
    for (let i = 0; i < snapshots.length; i++) {
      const date = historicalDates[i]!;
      snapshots[i]!.strategies[1]!.strategy = strategy(
        date,
        historicalDates[i - 1] ?? "2019-01-01",
        i === 2 ? "pending" : i === 3 ? "confirmed" : "none",
      );
    }
    observedBars["360750"]![3]!.close = null;
    const result = await runAdoptedEtfBacktest(input);
    expect(result.dailyNav[3]!.valuationStatus).toBe("STALE");
    expect(result.records![4]!.fills).toEqual([]);
    expect(result.fills[1]!.executionDate).toBe("2019-01-09");
    expect(result.quality.issueCounts.ENTRY_EXPIRED_STALE_PRIOR_NAV).toBe(1);
  });

  it("recognizes an individual missing holding at current close using only the prior-session open", async () => {
    const { input, observedBars } = fixture(["360750", "069500"]);
    observedBars["360750"]![2]!.open = 12000;
    observedBars["360750"]![2]!.close = 15000;
    observedBars["360750"]!.splice(3, 1);
    const result = await runAdoptedEtfBacktest(input);
    const sell = result.fills.find((fill) => fill.reason === "MODEL_UNOBSERVED")!;
    expect(sell).toMatchObject({
      symbol: "360750",
      side: "SELL",
      executionDate: "2019-01-07",
      executionAt: "2019-01-07T07:00:00Z",
      priceAsOfDate: "2019-01-04",
      price: "12000",
    });
    expect(result.quality.proxyExitCount).toBe(1);
  });

  it("does not use a close-recognized proxy sale to free an opening slot or fund that morning", async () => {
    const symbols = Array.from({ length: 11 }, (_, i) => String(i + 1).padStart(6, "0"));
    const { input, observedBars } = fixture(symbols);
    observedBars["000001"]![3]!.volume = 0;
    const result = await runAdoptedEtfBacktest(input);
    expect(result.records![3]!.fills.map((fill) => [fill.symbol, fill.side, fill.reason])).toEqual([
      ["000001", "SELL", "MODEL_UNOBSERVED"],
    ]);
    expect(result.records![3]!.pendingEntries[0]!.symbol).toBe("000011");
    expect(result.records![4]!.fills[0]).toMatchObject({
      symbol: "000011",
      side: "BUY",
      executionDate: "2019-01-08",
    });
  });

  it("does not infer individual delisting when the whole ETF market has zero volume", async () => {
    const { input, observedBars } = fixture(["360750", "069500"]);
    for (const bars of Object.values(observedBars)) bars[3]!.volume = 0;
    const result = await runAdoptedEtfBacktest(input);
    expect(result.quality.proxyExitCount).toBe(0);
    expect(result.finalState.positions).toHaveLength(2);
  });

  it("executes MA60 exits at next valid open with exact one-way sell cost", async () => {
    const { input, snapshots, observedBars } = fixture();
    snapshots[2]!.strategies[0]!.strategy.exit = "MA60";
    observedBars["360750"]![3]!.volume = 0; // no other liquid ETF, so no individual proxy
    observedBars["360750"]![4]!.open = 11000;
    const result = await runAdoptedEtfBacktest(input);
    expect(result.fills[1]).toMatchObject({
      reason: "MA60",
      side: "SELL",
      signalDate: "2019-01-04",
      executionDate: "2019-01-08",
      price: "11000",
      quantity: "499",
      fee: "8233.5",
    });
    expect(decimal(result.finalState.cash)).toBe(
      decimal("100000000") + decimal(result.fills[1]!.realizedPnl!),
    );
  });

  it("never imports a pre-start confirmation or a confirmation after a skipped onset session", async () => {
    const { input, snapshots } = fixture();
    snapshots[0]!.strategies[0]!.strategy = strategy(
      historicalDates[0]!,
      "2019-01-01",
      "confirmed",
    );
    snapshots[1]!.strategies = [];
    snapshots[2]!.strategies[0]!.strategy = strategy(
      historicalDates[2]!,
      historicalDates[1]!,
      "confirmed",
    );
    const result = await runAdoptedEtfBacktest(input);
    expect(result.fills).toEqual([]);
    expect(result.quality.issueCounts.SIGNAL_PRESTART_ORIGIN).toBe(1);
    expect(result.quality.issueCounts.SIGNAL_UNOBSERVED_ORIGIN).toBe(1);
    expect(result.quality.missingSignalSnapshots).toBe(1);
  });

  it("rejects missing/duplicate sessions, duplicate raw rows and wrong-strategy snapshots", async () => {
    const missing = fixture();
    missing.snapshots.splice(3, 1);
    await expect(runAdoptedEtfBacktest(missing.input)).rejects.toThrow(/each regular session/);
    const short = fixture();
    short.snapshots.pop();
    await expect(runAdoptedEtfBacktest(short.input)).rejects.toThrow(/ended before/);
    const duplicate = fixture();
    duplicate.observedBars["360750"]!.push({ ...duplicate.observedBars["360750"]![0]! });
    await expect(runAdoptedEtfBacktest(duplicate.input)).rejects.toThrow(/Duplicate canonical/);
    const wrong = fixture();
    wrong.snapshots[0]!.strategies[0]!.strategy.version = "saved-feature-panel";
    await expect(runAdoptedEtfBacktest(wrong.input)).rejects.toThrow(/symbol\/date\/version/);
  });

  it("does not allow future observed prices to change earlier fills or NAV", async () => {
    const original = fixture();
    const first = await runAdoptedEtfBacktest(original.input);
    const changed = fixture();
    changed.observedBars["360750"]![7]!.open = 999999;
    changed.observedBars["360750"]![7]!.close = 999999;
    const second = await runAdoptedEtfBacktest(changed.input);
    expect(second.dailyNav.slice(0, 7)).toEqual(first.dailyNav.slice(0, 7));
    expect(second.fills).toEqual(first.fills);
    expect(second.dailyNav[7]!.nav).not.toEqual(first.dailyNav[7]!.nav);
  });

  it("is deterministic with streaming snapshots and rejects tampered research contracts", async () => {
    const { input, snapshots } = fixture();
    const first = await runAdoptedEtfBacktest(input);
    async function* stream() {
      for (const snapshot of snapshots) yield snapshot;
    }
    const second = await runAdoptedEtfBacktest({ ...input, snapshots: stream() });
    expect(second).toEqual(first);
    await expect(
      initializeEtfCurrentRulesResearch(
        { ...first.contract, accountingStartDate: "2018-01-01" },
        CURRENT_RULES_RESEARCH,
      ),
    ).rejects.toThrow(/hash mismatch/);
    const { contractHash: _hash, ...body } = first.contract;
    const changed = { ...body, initialKrw: "200000000" };
    await expect(
      initializeEtfCurrentRulesResearch(
        { ...changed, contractHash: await hashSeriesValue(changed) } as typeof first.contract,
        CURRENT_RULES_RESEARCH,
      ),
    ).rejects.toThrow(/research contract required/);
  });
  it("uses annual prior-close assets with volatility weights and keeps older pending budgets", async () => {
    const dates = [
      "2019-12-26",
      "2019-12-27",
      "2019-12-30",
      "2019-12-31",
      "2020-01-02",
      "2020-01-03",
      "2020-01-06",
      "2020-01-07",
    ];
    const symbols = ["360750", "069500", "091160"];
    const { input, snapshots, observedBars } = fixture(symbols, dates);
    delete input.allocationPolicy;
    for (const [i, snap] of snapshots.entries())
      for (const [j, row] of snap.strategies.entries()) {
        const onset = j === 0 ? 0 : j === 1 ? 2 : 4;
        row.strategy = strategy(
          dates[i]!,
          dates[i - 1] ?? "2019-12-24",
          i === onset ? "pending" : i === onset + 1 ? "confirmed" : "none",
          { annualVolatility: j === 2 ? 0.15 : 0.3 },
        );
      }
    for (let i = 2; i < dates.length; i++)
      observedBars[symbols[0]!]![i]!.close = i < 4 ? 20000 : 50000;
    observedBars[symbols[1]!]![4]!.open = null;
    const result = await runAdoptedEtfBacktest(input);
    expect(result.contract.researchEntryBudgetPolicy).toBe("ANNUAL_NAV_VOLATILITY_SIGNAL_YEAR_V1");
    const years = result.finalState.researchYearAssetBases!;
    expect(years).toHaveLength(2);
    expect(years[0]).toMatchObject({ year: 2019, nav: "100000000", valuationDate: null });
    expect(years[1]).toMatchObject({
      year: 2020,
      effectiveDate: dates[4],
      valuationDate: dates[3],
      nav: result.dailyNav[3]!.nav,
    });
    const old = result.fills.find((f) => f.symbol === symbols[1] && f.side === "BUY")!;
    expect(old).toMatchObject({
      signalDate: dates[3],
      executionDate: dates[5],
      targetBudget: "5000000",
      budgetNavDate: null,
    });
    const fresh = result.fills.find((f) => f.symbol === symbols[2] && f.side === "BUY")!;
    expect(fresh.targetBudget).toBe(format(multiply(decimal(years[1]!.nav), decimal("0.1"))));
    expect(fresh.budgetNavDate).toBe(dates[3]);
    expect(result.finalState.positions.find((p) => p.symbol === symbols[0])!.quantity).toBe("499");
    const changed = structuredClone(input);
    (changed.observedBars as Record<string, EtfResearchObservedBar[]>)[symbols[0]!]![4]!.close =
      90000;
    const rerun = await runAdoptedEtfBacktest(changed);
    expect(rerun.finalState.researchYearAssetBases).toEqual(years);
    expect(rerun.fills.map((f) => [f.symbol, f.quantity, f.targetBudget])).toEqual(
      result.fills.map((f) => [f.symbol, f.quantity, f.targetBudget]),
    );
  });
});
