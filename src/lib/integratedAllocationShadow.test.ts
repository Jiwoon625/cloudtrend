import { describe, expect, it } from "vitest";
import { decimal } from "./ledger/decimal";
import { hashSeriesValue, type SeriesHash } from "./ledger/modelSeries";
import {
  ALLOCATION_MARKETS,
  INTEGRATED_O1_INITIAL_REFERENCE,
  createIntegratedAllocationShadow,
  verifyIntegratedAllocationLedger,
  stepIntegratedAllocationSession,
  reviewIntegratedAllocationMonth,
  allocationReservedCash,
  allocationTotalNav,
  type AllocationMarket,
  type AllocationSignal,
  type IntegratedAllocationLedger,
  type IntegratedAllocationSessionInput,
} from "./integratedAllocationShadow";
import {
  adaptIntegratedUsSession,
  adaptIntegratedKrSession,
  prepareIntegratedKrEvidence,
  adaptIntegratedKrEvidence,
  type IntegratedKrEvidence,
  type AllocationAdapterClock,
} from "./integratedAllocationReplayAdapter";
import { runUsProspectiveAnalysis, type UsProspectiveInputRow } from "./engine/usProspective";
import { getOperationalSignals } from "./engine/operationalStrategy";
import { getMockDataset } from "./engine/mockProvider";
import { runAnalysis } from "./engine/pipeline";
import { etfEntryConfirmation, ETF_POLICY, type EtfStrategySnapshot } from "./engine/etfStrategy";
import { simulateStrategy } from "./portfolioLedgers";
import { buildSnapshot } from "./screeningSnapshot";
import type { DailyPrice } from "./engine/types";
const H = `sha256:${"a".repeat(64)}` as SeriesHash;
/** Synthetic fixture calendar only; it is never a production exchange calendar. */
function days(end = "2027-01-08") {
  const result: string[] = [];
  for (
    let t = Date.parse("2026-10-12T00:00:00Z");
    t <= Date.parse(`${end}T00:00:00Z`);
    t += 86400000
  ) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) result.push(d.toISOString().slice(0, 10));
  }
  return result;
}
const calendar = { sourceHash: H, sessions: days() };
function clock(market: AllocationMarket, date: string): AllocationAdapterClock {
  return {
    openAt: `${date}T${market === "U" ? "09:30:00-04:00" : "09:00:00+09:00"}`,
    closeAt: `${date}T${market === "U" ? "16:00:00-04:00" : "15:30:00+09:00"}`,
    availableAt: `${date}T${market === "U" ? "16:01:00-04:00" : "16:00:00+09:00"}`,
    decisionAt: `${date}T${market === "U" ? "16:02:00-04:00" : "16:10:00+09:00"}`,
    sourceHash: H,
    codeHash: H,
    calendar,
  };
}
function session(
  ledger: IntegratedAllocationLedger,
  market: AllocationMarket,
  date: string,
  changes: Partial<IntegratedAllocationSessionInput> = {},
): IntegratedAllocationSessionInput {
  return {
    ...clock(market, date),
    market,
    date,
    previousSessionDate: ledger.markets[market].lastSessionDate,
    prices: [],
    rawOnsets: [],
    signals: [],
    signalObservation: "COMPLETE",
    deliveredEntrySignals: (changes.signals ?? []).filter((s) => s.side === "BUY"),
    ...changes,
  };
}
const signal = (
  symbol: string,
  market: AllocationMarket,
  originDate: string,
  side: "BUY" | "SELL" = "BUY",
): AllocationSignal => ({
  symbol,
  venue: market === "K" ? "KOSDAQ" : market === "E" ? "ETF" : "US",
  sector: symbol,
  side,
  originDate,
  reason: side === "BUY" ? "ENTRY" : "EXIT",
  annualVolatility: 0.3,
});
const price = (
  symbol: string,
  value = "1000",
  changes: Partial<IntegratedAllocationSessionInput["prices"][number]> = {},
) => ({ symbol, open: value, close: value, volume: 1000, maxBuyQuantity: null, ...changes });
const create = (kind: "O1" | "S07" = "O1") =>
  createIntegratedAllocationShadow(kind, { codeHash: H });
async function step(
  ledger: IntegratedAllocationLedger,
  market: AllocationMarket,
  date: string,
  changes: Partial<IntegratedAllocationSessionInput> = {},
) {
  return (await stepIntegratedAllocationSession(ledger, session(ledger, market, date, changes)))
    .ledger;
}
const review = (ledger: IntegratedAllocationLedger, month: string) =>
  reviewIntegratedAllocationMonth(ledger, {
    month,
    decisionAt: `${month === "2026-10" ? "2026-10-31" : "2026-12-01"}T23:00:00Z`,
    codeHash: H,
    sourceHash: H,
    calendars: { K: calendar, E: calendar, U: calendar },
  });

describe("isolated annual-NAV allocation Shadow", () => {
  it("adds E4 after entry without altering allocations and carries its pending sale across a missing open", async () => {
    let ledger = await create("S07");
    ledger = await step(ledger, "E", "2026-10-12", { rawOnsets: ["ETF"] });
    ledger = await step(ledger, "E", "2026-10-13", { signals: [signal("ETF", "E", "2026-10-12")] });
    ledger = await step(ledger, "E", "2026-10-14", { prices: [price("ETF", "100")] });
    const original = structuredClone(ledger);
    const policy = {
      priceExitPolicy: "holding-price-exit-k4-e4-v1" as const,
      priceExitSeeds: {
        ETF: {
          policyVersion: "holding-price-exit-k4-e4-v1" as const,
          peak: "100",
          peakDate: "2026-10-14",
          throughDate: "2026-10-14",
          signalDate: null,
          signalClose: null,
          signalThreshold: null,
        },
      },
    };
    const old = await step(ledger, "E", "2026-10-15", { prices: [price("ETF", "90")] });
    ledger = await step(ledger, "E", "2026-10-15", { ...policy, prices: [price("ETF", "90")] });
    expect(old.markets.E.pendingExits).toHaveLength(0);
    expect(ledger.markets.E.pendingExits).toMatchObject([
      { reason: "E4", signalDate: "2026-10-15" },
    ]);
    expect(ledger.target).toEqual(original.target);
    expect(ledger.markets.E.cashKrw).toEqual(old.markets.E.cashKrw);
    ledger = await step(ledger, "E", "2026-10-16", {
      priceExitPolicy: policy.priceExitPolicy,
      prices: [price("ETF", "120", { open: null })],
    });
    expect(ledger.markets.E.pendingExits).toHaveLength(1);
    ledger = await step(ledger, "E", "2026-10-19", {
      priceExitPolicy: policy.priceExitPolicy,
      prices: [price("ETF", "80")],
    });
    expect(ledger.markets.E.positions).toHaveLength(0);
    expect(ledger.receipts.at(-1)!.record.fills).toMatchObject([
      { reason: "E4", price: "80", side: "SELL" },
    ]);
  });
  it("initializes only new 30m O1/S07 cash books with historical target provenance", async () => {
    const o1 = await create(),
      s07 = await create("S07");
    expect(o1.target).toEqual({ denominator: 3, K: 1, E: 1, U: 1, C: 0 });
    expect(ALLOCATION_MARKETS.map((m) => o1.markets[m].cashKrw)).toEqual([
      "10000000",
      "10000000",
      "10000000",
    ]);
    expect(ALLOCATION_MARKETS.map((m) => s07.markets[m].cashKrw)).toEqual([
      "18000000",
      "6000000",
      "6000000",
    ]);
    expect(o1.contract.initialReference).toEqual(INTEGRATED_O1_INITIAL_REFERENCE);
    expect(o1.contract.fixedUsdKrw).toBe("1339.2");
    expect(o1.contract.researchEquivalence).toContain("NOT_CM_RESEARCH");
    expect(allocationTotalNav(o1)).toBe("30000000");
    expect(
      ALLOCATION_MARKETS.every(
        (m) =>
          !o1.markets[m].positions.length &&
          !o1.markets[m].pendingBuys.length &&
          !o1.markets[m].observedOnsets.length,
      ),
    ).toBe(true);
    await expect(verifyIntegratedAllocationLedger(s07)).resolves.toBeUndefined();
  });
  it("rejects altered state, actual-book inputs, and changed policy even if locally rehashed", async () => {
    const ledger = await create();
    const changed = structuredClone(ledger);
    changed.markets.K.cashKrw = "1";
    await expect(verifyIntegratedAllocationLedger(changed)).rejects.toThrow("integrity");
    const actual = { ...ledger, book: "ACTUAL" } as unknown as IntegratedAllocationLedger;
    await expect(verifyIntegratedAllocationLedger(actual)).rejects.toThrow("isolation");
    const policy = structuredClone(ledger);
    policy.contract.initialCapitalKrw = "100000000" as "30000000";
    policy.contractHash = await hashSeriesValue(policy.contract);
    const { stateHash: _, ...body } = policy;
    policy.stateHash = await hashSeriesValue(body);
    await expect(verifyIntegratedAllocationLedger(policy)).rejects.toThrow(
      "Unsupported allocation contract",
    );
  });
  it("is deterministic/idempotent and refuses changed same-day inputs and skipped sessions", async () => {
    const ledger = await create(),
      input = session(ledger, "K", "2026-10-12");
    const first = await stepIntegratedAllocationSession(ledger, input);
    expect((await stepIntegratedAllocationSession(ledger, input)).ledger.stateHash).toBe(
      first.ledger.stateHash,
    );
    expect((await stepIntegratedAllocationSession(first.ledger, input)).status).toBe("REUSE");
    await expect(
      stepIntegratedAllocationSession(first.ledger, { ...input, prices: [price("X")] }),
    ).rejects.toThrow("conflict");
    await expect(step(first.ledger, "K", "2026-10-14")).rejects.toThrow("sessions");
    await expect(step(ledger, "K", "2026-10-09")).rejects.toThrow("session");
    expect(ledger.receipts).toHaveLength(0);
  });
  it("excludes prestart/unobserved onsets, sizes at confirmation, and never buys at signal close", async () => {
    let ledger = await create();
    ledger = await step(ledger, "E", "2026-10-12", {
      rawOnsets: ["NEW"],
      signals: [signal("OLD", "E", "2026-10-09"), signal("UNSEEN", "E", "2026-10-12")],
    });
    expect(ledger.markets.E.pendingBuys).toHaveLength(0);
    ledger = await step(ledger, "E", "2026-10-13", {
      signals: [signal("NEW", "E", "2026-10-12")],
      prices: [price("NEW")],
    });
    expect(ledger.markets.E.positions).toHaveLength(0);
    expect(ledger.markets.E.pendingBuys[0]?.budgetKrw).toBe("500000");
    ledger = await step(ledger, "E", "2026-10-14", { prices: [price("NEW")] });
    expect(ledger.markets.E.positions[0]?.quantity).toBe("499");
    expect(ledger.markets.E.cashKrw).toBe("9500251.5");
  });
  it("carries missing-open and zero-volume orders with fixed budgets, then fills fee-inclusive integers", async () => {
    let ledger = await create();
    ledger = await step(ledger, "K", "2026-10-12", {
      rawOnsets: ["A"],
      signals: [signal("A", "K", "2026-10-12")],
    });
    const budget = ledger.markets.K.pendingBuys[0]!.budgetKrw;
    ledger = await step(ledger, "K", "2026-10-13", { prices: [price("A", "1000", { volume: 0 })] });
    expect(ledger.markets.K.pendingBuys[0]?.budgetKrw).toBe(budget);
    ledger = await step(ledger, "K", "2026-10-14", { prices: [price("A")] });
    expect(ledger.markets.K.positions[0]?.quantity).toBe("332");
    expect(ledger.markets.K.cashKrw).toBe("9667502");
    expect(ledger.markets.K.pendingBuys).toHaveLength(0);
  });
  it("uses fixed FX and US gross budgets plus fees, retaining partial buy/sell intents", async () => {
    let ledger = await create();
    ledger = await step(ledger, "U", "2026-10-12", {
      rawOnsets: ["A"],
      signals: [signal("A", "U", "2026-10-12")],
    });
    ledger = await step(ledger, "U", "2026-10-13", {
      prices: [price("A", "100", { maxBuyQuantity: "1" })],
    });
    expect(ledger.markets.U.pendingBuys[0]?.remainingQuantity).toBe("2");
    expect(ledger.markets.U.positions[0]?.quantity).toBe("1");
    ledger = await step(ledger, "U", "2026-10-14", {
      prices: [price("A", "100")],
      signals: [signal("A", "U", "2026-10-14", "SELL")],
    });
    expect(ledger.markets.U.positions[0]?.quantity).toBe("3");
    ledger = await step(ledger, "U", "2026-10-15", {
      prices: [price("A", "100", { maxSellQuantity: "1" })],
    });
    expect(ledger.markets.U.positions[0]?.quantity).toBe("2");
    expect(ledger.markets.U.pendingExits).toHaveLength(1);
    ledger = await step(ledger, "U", "2026-10-16", { prices: [price("A", "100")] });
    expect(ledger.markets.U.positions).toHaveLength(0);
    expect(ledger.markets.U.cashKrw).toBe("9998794.72");
  });
  it("does not substitute stale marks or reset new annual budgets from incomplete NAV", async () => {
    let ledger = await create();
    for (const d of calendar.sessions.filter((d) => d <= "2027-01-04")) {
      const initial = d === "2026-10-12";
      ledger = await step(ledger, "K", d, {
        rawOnsets: initial ? ["A"] : d === "2027-01-04" ? ["B"] : [],
        signals: initial ? [signal("A", "K", d)] : d === "2027-01-04" ? [signal("B", "K", d)] : [],
        prices: [price("A", "1000", { close: d === "2026-12-31" ? null : "1000" })],
      });
      if (d === "2026-12-31") expect(ledger.markets.K.navKrw).toBeNull();
    }
    expect(ledger.markets.K.sizing.status).toBe("MISSING_PRIOR_YEAR_NAV");
    expect(ledger.markets.K.pendingBuys.some((p) => p.symbol === "B")).toBe(false);
  });
  it("resets KR/US sizing on calendar-year NAV, preserving already confirmed old-year pending budgets", async () => {
    let ledger = await create();
    for (const d of calendar.sessions.filter((d) => d <= "2027-01-04")) {
      const rawOnsets = d === "2026-10-12" ? ["A"] : d === "2026-12-31" ? ["OLD", "NEW"] : [];
      const signals =
        d === "2026-10-12"
          ? [signal("A", "K", d)]
          : d === "2026-12-31"
            ? [signal("OLD", "K", d)]
            : d === "2027-01-04"
              ? [signal("NEW", "K", "2026-12-31")]
              : [];
      ledger = await step(ledger, "K", d, {
        rawOnsets,
        signals,
        prices: [price("A", "1000", { close: d >= "2026-12-31" ? "2000" : "1000" })],
      });
    }
    const [old, next] = ledger.markets.K.pendingBuys;
    expect(old?.budgetKrw).toBe("333333.33333333");
    expect(old?.budgetYear).toBe(2026);
    expect(next?.budgetKrw).toBe("344383.4");
    expect(next?.budgetYear).toBe(2027);
    expect(next?.budgetNavDate).toBe("2026-12-31");
  });
  it("uses partial October signals for November and cancels zero-target buys without selling holdings", async () => {
    let ledger = await create();
    for (const d of calendar.sessions.filter((d) => d <= "2026-11-30")) {
      for (const market of ALLOCATION_MARKETS)
        ledger = await step(ledger, market, d, {
          rawOnsets:
            d === "2026-10-12" && market !== "U"
              ? [market]
              : d === "2026-11-03" && market === "U"
                ? ["U"]
                : [],
          signals:
            d === "2026-10-12" && market !== "U"
              ? [signal(market, market, d)]
              : d === "2026-11-03" && market === "U"
                ? [signal("U", "U", d)]
                : [],
          prices: market === "K" ? [price("K")] : [],
        });
      if (d === "2026-10-30") {
        const r = await review(ledger, "2026-10");
        ledger = r.ledger;
        expect(r.record.monthReview).toMatchObject({
          partialMonth: true,
          signalMonth: "2026-10",
          targetMonth: "2026-11",
          coverageStart: "2026-10-12",
          signalCounts: { K: 1, E: 1, U: 0 },
          applied: true,
        });
        expect(ledger.target).toEqual({ denominator: 2, K: 1, E: 1, U: 0, C: 0 });
      }
    }
    const before = allocationTotalNav(ledger),
      held = structuredClone(ledger.markets.K.positions);
    expect(decimal(allocationReservedCash(ledger, "E"))).toBeGreaterThan(0n);
    const r = await review(ledger, "2026-11");
    expect(r.ledger.target).toEqual({ denominator: 5, K: 0, E: 0, U: 3, C: 2 });
    expect(r.ledger.markets.K.positions).toEqual(held);
    expect(r.ledger.markets.E.pendingBuys).toHaveLength(0);
    expect(allocationReservedCash(r.ledger, "E")).toBe("0");
    expect(r.record.cancelledBuys.some((p) => p.market === "E" && p.reason === "TARGET_ZERO")).toBe(
      true,
    );
    expect(allocationTotalNav(r.ledger)).toBe(before);
    expect(r.record.fills).toHaveLength(0);
    expect(decimal(r.ledger.centralCashKrw)).toBeGreaterThan(0n);
  });
  it("keeps S07 static and refuses month-end review without next-session/calendar proof", async () => {
    let ledger = await create("S07");
    for (const d of calendar.sessions.filter((d) => d <= "2026-10-30"))
      for (const market of ALLOCATION_MARKETS) ledger = await step(ledger, market, d);
    const r = await review(ledger, "2026-10");
    expect(r.record.issues).toContain("STATIC_TARGET_NO_TRANSFERS");
    expect(r.record.transfers).toHaveLength(0);
    const truncated = {
      sourceHash: H,
      sessions: calendar.sessions.filter((d) => d <= "2026-10-30"),
    };
    await expect(
      reviewIntegratedAllocationMonth(ledger, {
        month: "2026-10",
        decisionAt: "2026-10-31T23:00:00Z",
        codeHash: H,
        sourceHash: H,
        calendars: { K: truncated, E: truncated, U: truncated },
      }),
    ).rejects.toThrow("calendar/data");
  });
});

function usRow(symbol: string, x: number, date: string): UsProspectiveInputRow {
  return {
    date,
    symbol,
    name: symbol,
    market: "NASDAQ",
    sector: "IT",
    securityType: "STOCK",
    status: "ACTIVE",
    currency: "USD",
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1e6,
    dollarVolume: 1e8,
    sharesOutstanding: 1e8,
    marketCap: 1e10,
    ret120: x,
    ret252: x,
    beta60Spy: x,
    ichimokuTkGap: x,
    relvol1_20: x,
    adv20Usd: 1e7,
    amihud20: 1 / (x + 100),
    active20: true,
    tossTradable: true,
    isCommonShare: true,
    fxUsdKrw: 9999,
  };
}
it("runs existing US scorer through the adapter into the isolated next-open ledger and preserves Beta exit", async () => {
  let ledger = await create();
  const warmup = runUsProspectiveAnalysis(
    Array.from({ length: 20 }, (_, i) => usRow(`S${i}`, i, "2026-10-09")),
  );
  const rows = Array.from({ length: 20 }, (_, i) =>
    usRow(`S${i}`, i === 10 ? 100 : i, "2026-10-12"),
  );
  let analysis = runUsProspectiveAnalysis(rows, warmup.state);
  expect(analysis.rows.find((r) => r.symbol === "S10")?.a0Entry).toBe(true);
  ledger = (
    await stepIntegratedAllocationSession(
      ledger,
      adaptIntegratedUsSession(ledger, {
        analysis,
        previousAnalysis: warmup,
        clock: clock("U", analysis.date),
      }),
    )
  ).ledger;
  expect(ledger.markets.U.pendingBuys.map((p) => p.symbol)).toContain("S10");
  for (const d of ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) {
    const prior = analysis;
    analysis = runUsProspectiveAnalysis(
      rows.map((r) => ({ ...r, date: d, beta60Spy: r.symbol === "S10" ? -1 : r.beta60Spy })),
      prior.state,
    );
    ledger = (
      await stepIntegratedAllocationSession(
        ledger,
        adaptIntegratedUsSession(ledger, {
          analysis,
          previousAnalysis: prior,
          clock: clock("U", d),
        }),
      )
    ).ledger;
    if (d === "2026-10-13")
      expect(ledger.markets.U.positions.find((p) => p.symbol === "S10")?.quantity).toBe("3");
    if (d === "2026-10-15")
      expect(ledger.markets.U.pendingExits.find((p) => p.symbol === "S10")?.reason).toBe(
        "A0_BETA_ANCHOR_3D",
      );
  }
  expect(ledger.markets.U.positions.find((p) => p.symbol === "S10")).toBeUndefined();
});

it("reuses KR operational signals and shared H60 planner with differential whole-session execution", async () => {
  const dataset = getMockDataset();
  const inst = dataset.instruments.find((i) => i.market === "KOSDAQ")!;
  dataset.instruments = [inst];
  dataset.bars = { [inst.symbol]: dataset.bars[inst.symbol]! };
  const base = runAnalysis(dataset),
    template = base.rows.find((r) => r.instrument.symbol === inst.symbol)!;
  const bars: DailyPrice[] = [],
    snapshots = [];
  let ledger = await create();
  const dates = calendar.sessions.slice(0, 61);
  const evidenceHistory: IntegratedKrEvidence[] = [];
  for (const [index, d] of dates.entries()) {
    bars.push({
      tradeDate: d,
      open: 1000,
      close: 1000,
      high: 1000,
      low: 1000,
      volume: 1e6,
      tradingValue: 1e9,
      marketCap: null,
      foreignNetBuyValue: null,
      institutionNetBuyValue: null,
    });
    const row = {
      ...template,
      hardFilterPassed: true,
      hardFilterStatus: "PASS" as const,
      pendingRules: [],
      operatingScore10: 8,
      scoreDelta1d: index === 0 ? 5 : 0,
      ...getOperationalSignals("KOSDAQ", index === 0 ? 7.5 : 8, 8, true, d),
    };
    const analysis = { ...base, asOfDate: d, rows: [row], calculatedAt: clock("K", d).availableAt };
    const currentDataset = {
      ...dataset,
      asOfDate: d,
      tradeDates: dates.slice(0, index + 1),
      bars: { [inst.symbol]: [...bars] },
    };
    const input = adaptIntegratedKrSession(ledger, {
      market: "K",
      dataset: currentDataset,
      analysis,
      clock: clock("K", d),
    });
    const evidence = prepareIntegratedKrEvidence(currentDataset, analysis, clock("K", d));
    expect(Object.values(evidence.bars).every((bar) => bar.tradeDate === d)).toBe(true);
    const compactInput = adaptIntegratedKrEvidence(ledger, {
      market: "K",
      evidence,
      history: evidenceHistory,
    });
    expect(compactInput).toEqual(input);
    await expect(hashSeriesValue(evidence)).resolves.toMatch(/^sha256:/);
    if (index > 0)
      expect(() =>
        adaptIntegratedKrEvidence(ledger, { market: "K", evidence, history: [] }),
      ).toThrow("prefix");
    evidenceHistory.push(evidence);
    ledger = (await stepIntegratedAllocationSession(ledger, compactInput)).ledger;
    snapshots.push(buildSnapshot(analysis));
    const comparison = simulateStrategy(
      { initialCapital: 10000000, maxPositions: 30, sectorCap: 0.3, roundTripCostRate: 0.003 },
      snapshots,
      { [inst.symbol]: bars },
      { [inst.symbol]: "KOSDAQ" },
      "synthetic",
      dates.slice(0, index + 1),
      {},
      {
        version: "kr-common-execution-20261012-v1",
        startDate: "2026-10-12",
        throughDate: d,
        scope: "MIXED",
      },
    );
    expect(ledger.markets.K.cashKrw).toBe(comparison.modelAccounting?.cash);
    expect(ledger.markets.K.navKrw).toBe(comparison.modelAccounting?.nav);
    expect(ledger.markets.K.positions.length).toBe(
      comparison.trades.filter((t) => t.status === "OPEN").length,
    );
  }
  expect(ledger.receipts.at(-1)?.record.fills[0]?.reason).toBe("60거래일 만기");
  expect(ledger.markets.K.positions).toHaveLength(0);
});

it("holds the prior target when any calendar-month market observation is missing, rather than counting no demand", async () => {
  let ledger = await create();
  for (const d of calendar.sessions.filter((d) => d <= "2026-10-30"))
    for (const market of ALLOCATION_MARKETS)
      ledger = await step(ledger, market, d, {
        signalObservation: d === "2026-10-19" && market === "U" ? "MISSING" : "COMPLETE",
      });
  const result = await review(ledger, "2026-10");
  expect(result.record.issues).toContain(
    "INCOMPLETE_CALENDAR_MONTH_SIGNAL_OBSERVATION_KEEP_TARGET",
  );
  expect(result.record.monthReview).toMatchObject({ observationStatus: "MISSING", applied: false });
  expect(result.ledger.target).toEqual(ledger.target);
  expect(result.record.transfers).toHaveLength(0);
});

it("uses shared KR missing-observation exit while a positive-volume missing close stays unknown", async () => {
  const dataset = getMockDataset(),
    inst = dataset.instruments.find((i) => i.market === "KOSDAQ")!;
  const base = runAnalysis(dataset),
    template = base.rows.find((r) => r.instrument.symbol === inst.symbol)!;
  const bars: DailyPrice[] = [];
  let ledger = await create();
  for (const [index, d] of calendar.sessions.slice(0, 4).entries()) {
    bars.push({
      tradeDate: d,
      open: 1000,
      close: index === 2 ? Number.NaN : 1000,
      high: 1000,
      low: 1000,
      volume: index === 3 ? 0 : 1e6,
      tradingValue: 1e9,
      marketCap: null,
      foreignNetBuyValue: null,
      institutionNetBuyValue: null,
    });
    const peer = { ...inst, id: "PEER", symbol: "PEER" };
    const currentDataset = {
      ...dataset,
      instruments: [inst, peer],
      asOfDate: d,
      tradeDates: calendar.sessions.slice(0, index + 1),
      bars: {
        [inst.symbol]: [...bars],
        PEER: bars.map((b) => ({ ...b, close: 1000, volume: 1e6 })),
      },
    };
    const row = {
      ...template,
      hardFilterPassed: true,
      hardFilterStatus: "PASS" as const,
      pendingRules: [],
      operatingScore10: 8,
      scoreDelta1d: index === 0 ? 5 : 0,
      ...getOperationalSignals("KOSDAQ", index === 0 ? 7.5 : 8, 8, true, d),
    };
    const analysis = { ...base, asOfDate: d, rows: [row], calculatedAt: clock("K", d).availableAt };
    const result = await stepIntegratedAllocationSession(
      ledger,
      adaptIntegratedKrSession(ledger, {
        market: "K",
        dataset: currentDataset,
        analysis,
        clock: clock("K", d),
      }),
    );
    ledger = result.ledger;
    if (index === 2) {
      expect(ledger.markets.K.navKrw).toBeNull();
      expect(ledger.markets.K.positions).toHaveLength(1);
    }
    if (index === 3) {
      expect(ledger.markets.K.positions).toHaveLength(0);
      expect(result.record.fills[0]?.reason).toContain("모델 가정 청산");
      expect(result.record.fills[0]?.price).toBe("1000");
    }
  }
});

it("carries ETF confirmed budget through missing open, rejects stale confirmation, and reuses missing-data exit rule", async () => {
  const dataset = getMockDataset(),
    inst = dataset.instruments.find((i) => i.instrumentType === "ETF")!;
  const base = runAnalysis(dataset),
    template = base.rows.find((r) => r.instrument.symbol === inst.symbol)!;
  const peer = { ...inst, symbol: "PEER", id: "PEER" };
  const history: IntegratedKrEvidence[] = [];
  const observations: Array<{
    date: string;
    score: number;
    eligible: boolean;
    underlyingClose: number;
    underlyingMa60: number;
  }> = [
    { date: "2026-10-09", score: 79, eligible: true, underlyingClose: 100, underlyingMa60: 90 },
  ];
  let ledger = await create();
  for (const [index, d] of calendar.sessions.slice(0, 5).entries()) {
    const obs = { date: d, score: 85, eligible: true, underlyingClose: 100, underlyingMa60: 90 };
    const confirmation = etfEntryConfirmation(
      obs,
      observations.at(-1) ?? null,
      observations.at(-2) ?? null,
    );
    const strategy: EtfStrategySnapshot = {
      version: ETF_POLICY.version,
      date: d,
      previousDate: observations.at(-1)!.date,
      eligible: true,
      score: 85,
      previousScore: observations.at(-1)!.score,
      technical: 85,
      priority: 5,
      health: 15,
      environment: 15,
      environmentSource: "stock_sector",
      region: "US",
      sector: "INDEX",
      annualVolatility: 0.3,
      entryWeight: 0.05,
      underlyingClose: 100,
      underlyingMa60: 90,
      ...confirmation,
      averageTradingValue20: 1e9,
      dataStatus: "ready",
      krxReferenceDate: null,
      exit: null,
      issues: [],
    };
    const bar: DailyPrice = {
      tradeDate: d,
      open: index === 2 ? 0 : 1000,
      close: 1000,
      high: 1000,
      low: 1000,
      volume: index === 4 ? 0 : 1e6,
      tradingValue: 1e9,
      marketCap: null,
      foreignNetBuyValue: null,
      institutionNetBuyValue: null,
    };
    const currentDataset = {
      ...dataset,
      asOfDate: d,
      instruments: [inst, peer],
      tradeDates: calendar.sessions.slice(0, index + 1),
      bars: { [inst.symbol]: [bar], PEER: [{ ...bar, open: 1000, volume: 1e6 }] },
    };
    const analysis = {
      ...base,
      asOfDate: d,
      rows: [{ ...template, etfStrategy: strategy }],
      calculatedAt: clock("E", d).availableAt,
    };
    const evidence = prepareIntegratedKrEvidence(currentDataset, analysis, clock("E", d));
    const input = adaptIntegratedKrEvidence(ledger, { market: "E", evidence, history });
    if (index === 1) {
      const old = structuredClone(evidence);
      old.rows[0]!.etfStrategy!.originDate = "2026-10-09";
      expect(
        adaptIntegratedKrEvidence(ledger, { market: "E", evidence: old, history }).signals.filter(
          (s) => s.side === "BUY",
        ),
      ).toHaveLength(0);
    }
    const result = await stepIntegratedAllocationSession(ledger, input);
    ledger = result.ledger;
    history.push(evidence);
    observations.push(obs);
    if (index === 1 || index === 2)
      expect(ledger.markets.E.pendingBuys[0]?.budgetKrw).toBe("500000");
    if (index === 3) expect(ledger.markets.E.positions[0]?.quantity).toBe("499");
    if (index === 4) {
      expect(result.record.fills[0]?.reason).toBe("MODEL_UNOBSERVED");
      expect(ledger.markets.E.positions).toHaveLength(0);
    }
  }
});

it("freezes ETF confirmed budget at the completed signal close NAV and never resizes it at later opens", async () => {
  let ledger = await create();
  ledger = await step(ledger, "E", "2026-10-12", {
    rawOnsets: ["A"],
    signals: [signal("A", "E", "2026-10-12")],
  });
  ledger = await step(ledger, "E", "2026-10-13", {
    prices: [price("A", "1000", { close: "2000" })],
    rawOnsets: ["B"],
  });
  ledger = await step(ledger, "E", "2026-10-14", {
    prices: [price("A", "1000", { close: "3000" })],
    signals: [signal("B", "E", "2026-10-13")],
  });
  expect(ledger.markets.E.pendingBuys[0]?.budgetKrw).toBe("549862.575");
  expect(ledger.markets.E.pendingBuys[0]?.budgetNavDate).toBe("2026-10-14");
  ledger = await step(ledger, "E", "2026-10-15", {
    prices: [price("A", "1000", { close: "9000" }), price("B", "1000", { open: null })],
  });
  expect(ledger.markets.E.pendingBuys[0]?.budgetKrw).toBe("549862.575");
  ledger = await step(ledger, "E", "2026-10-16", {
    prices: [price("A", "1000", { close: "19000" }), price("B")],
  });
  expect(ledger.markets.E.positions.find((p) => p.symbol === "B")?.quantity).toBe("549");
});

it("separates a missing ETF strategy/underlying from a verified whole-market KRX batch delay", async () => {
  const dataset = getMockDataset(),
    inst = dataset.instruments.find((i) => i.instrumentType === "ETF")!;
  const base = runAnalysis(dataset),
    template = base.rows.find((r) => r.instrument.symbol === inst.symbol)!;
  const d = "2026-10-12",
    bar = { ...dataset.bars[inst.symbol]!.at(-1)!, tradeDate: d };
  const currentDataset = {
    ...dataset,
    asOfDate: d,
    instruments: [inst],
    tradeDates: [d],
    bars: { [inst.symbol]: [bar] },
  };
  const row = { ...template };
  delete row.etfStrategy;
  const analysis = { ...base, asOfDate: d, rows: [row] };
  const ledger = await create(),
    evidence = prepareIntegratedKrEvidence(currentDataset, analysis, clock("E", d));
  const input = adaptIntegratedKrEvidence(ledger, { market: "E", evidence, history: [] });
  expect(input.inputIssues).toContain(`SIGNAL_DATA_UNAVAILABLE:${inst.symbol}`);
  expect(input.signals).toHaveLength(0);
  await expect(stepIntegratedAllocationSession(ledger, input)).resolves.toMatchObject({
    status: "NEW",
  });
  expect(() =>
    adaptIntegratedKrEvidence(ledger, {
      market: "E",
      evidence: { ...evidence, etfBatchPending: true },
      history: [],
    }),
  ).toThrow("KRX batch pending");
});

it("shares the KR sector cap across venues and preserves the candidate venue's three/six-slot rule", async () => {
  let ledger = await create();
  const candidates = ["A", "B", "C"];
  ledger = await step(ledger, "K", "2026-10-12", {
    rawOnsets: candidates,
    signals: candidates.map((symbol) => ({
      ...signal(symbol, "K", "2026-10-12"),
      sector: "SHARED",
    })),
  });
  ledger = await step(ledger, "K", "2026-10-13", {
    prices: candidates.map((s) => price(s)),
    rawOnsets: ["KOSPI4", "KOSDAQ4"],
  });
  ledger = await step(ledger, "K", "2026-10-14", {
    prices: candidates.map((s) => price(s)),
    signals: [
      { ...signal("KOSPI4", "K", "2026-10-13"), venue: "KOSPI", sector: "SHARED" },
      { ...signal("KOSDAQ4", "K", "2026-10-13"), sector: "SHARED" },
    ],
  });
  const result = await stepIntegratedAllocationSession(
    ledger,
    session(ledger, "K", "2026-10-15", {
      prices: [...candidates, "KOSPI4", "KOSDAQ4"].map((s) => price(s)),
    }),
  );
  expect(result.ledger.markets.K.positions.map((p) => p.symbol)).toContain("KOSDAQ4");
  expect(result.ledger.markets.K.positions.map((p) => p.symbol)).not.toContain("KOSPI4");
  expect(result.record.issues).toContain("ENTRY_CAP_CARRIED:KOSPI4");
});

it("counts the delivered confirmation month, deduplicates origins, and retains early-month signals outside the last 20 sessions", async () => {
  let ledger = await create();
  for (const d of calendar.sessions.filter((d) => d <= "2026-11-30")) {
    for (const market of ALLOCATION_MARKETS) {
      const rawOnsets =
        d === "2026-10-30" && market === "E"
          ? ["E"]
          : d === "2026-11-02" && market === "K"
            ? ["K"]
            : d === "2026-11-30" && market === "U"
              ? ["U"]
              : [];
      const delivered =
        ["2026-11-02", "2026-11-03"].includes(d) && market === "E"
          ? [signal("E", "E", "2026-10-30")]
          : ["2026-11-02", "2026-11-03"].includes(d) && market === "K"
            ? [signal("K", "K", "2026-11-02")]
            : d === "2026-11-30" && market === "U"
              ? [signal("U", "U", d)]
              : [];
      ledger = await step(ledger, market, d, { rawOnsets, deliveredEntrySignals: delivered });
    }
    if (d === "2026-10-30") {
      const october = await review(ledger, "2026-10");
      ledger = october.ledger;
      expect(ledger.target).toEqual({ denominator: 1, K: 0, E: 0, U: 0, C: 1 });
      expect(october.record.monthReview?.signalCounts).toEqual({ K: 0, E: 0, U: 0 });
      expect(ledger.markets.E.cashKrw).toBe("0");
    }
  }
  expect(ledger.deliveredEntrySignals).toHaveLength(3);
  expect(ledger.deliveredEntrySignals.find((s) => s.market === "E")).toMatchObject({
    originDate: "2026-10-30",
    confirmationDate: "2026-11-02",
  });
  expect(ALLOCATION_MARKETS.every((m) => ledger.markets[m].pendingBuys.length === 0)).toBe(true);
  const result = await review(ledger, "2026-11");
  expect(result.record.monthReview).toMatchObject({
    signalMonth: "2026-11",
    targetMonth: "2026-12",
    partialMonth: false,
    signalCounts: { K: 1, E: 1, U: 1 },
    observationStatus: "COMPLETE",
    applied: true,
  });
  expect(result.ledger.target).toEqual({ denominator: 3, K: 1, E: 1, U: 1, C: 0 });
});

it("logs US delivered entries before existing holdings and the 20-slot cap without changing trading intents", async () => {
  let held = await create(),
    empty = await create("S07");
  const symbols = Array.from({ length: 20 }, (_, i) => `S${i}`);
  held = await step(held, "U", "2026-10-12", {
    rawOnsets: symbols,
    signals: symbols.map((s) => signal(s, "U", "2026-10-12")),
  });
  held = await step(held, "U", "2026-10-13", { prices: symbols.map((s) => price(s, "100")) });
  expect(held.markets.U.positions).toHaveLength(20);
  empty = await step(empty, "U", "2026-10-12");
  empty = await step(empty, "U", "2026-10-13");
  const previousAnalysis = runUsProspectiveAnalysis(
    symbols.map((s, i) => usRow(s, i, "2026-10-13")),
  );
  const analysis = runUsProspectiveAnalysis(
    [...symbols, "NEW"].map((s, i) => usRow(s, i, "2026-10-14")),
    previousAnalysis.state,
  );
  for (const row of analysis.rows) {
    row.a0Exit = false;
    row.a0Entry = ["S0", "NEW"].includes(row.symbol);
    row.onset80 = row.a0Entry;
  }
  const heldInput = adaptIntegratedUsSession(held, {
    analysis,
    previousAnalysis,
    clock: clock("U", analysis.date),
  });
  const emptyInput = adaptIntegratedUsSession(empty, {
    analysis,
    previousAnalysis,
    clock: clock("U", analysis.date),
  });
  expect(heldInput.deliveredEntrySignals).toEqual(emptyInput.deliveredEntrySignals);
  expect(heldInput.deliveredEntrySignals.map((s) => s.symbol).sort()).toEqual(["NEW", "S0"]);
  expect(heldInput.signals.filter((s) => s.side === "BUY")).toHaveLength(0);
  expect(emptyInput.signals.filter((s) => s.side === "BUY")).toHaveLength(2);
  held = (await stepIntegratedAllocationSession(held, heldInput)).ledger;
  expect(
    held.deliveredEntrySignals.filter((s) => s.confirmationDate === "2026-10-14"),
  ).toHaveLength(2);
  expect(held.markets.U.positions).toHaveLength(20);
});

it("rejects missing observation declarations and marks empty market analysis as unknown", async () => {
  const ledger = await create();
  const input = session(ledger, "U", "2026-10-12");
  const undeclared = { ...input };
  delete (undeclared as Partial<IntegratedAllocationSessionInput>).signalObservation;
  await expect(stepIntegratedAllocationSession(ledger, undeclared)).rejects.toThrow(
    "observation evidence",
  );
  const emptyAnalysis = runUsProspectiveAnalysis([usRow("SPY", 1, "2026-10-12")]);
  const normalized = adaptIntegratedUsSession(ledger, {
    analysis: emptyAnalysis,
    previousAnalysis: null,
    clock: clock("U", "2026-10-12"),
  });
  expect(normalized.signalObservation).toBe("MISSING");
  expect(normalized.deliveredEntrySignals).toHaveLength(0);
});
