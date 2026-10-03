import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUsOrderPreview,
  isScheduledUsSession,
  isUsOrderPreviewBundle,
  nextScheduledUsSession,
  type UsOrderPreviewQuote,
} from "./usProspectiveOrderPreview";
import {
  stepUsProspectivePortfolio,
  US_PROSPECTIVE_STRATEGIES,
  stepUsProspectiveOperatingPortfolio,
  usFixedSlotAllocationPolicy,
  type UsPortfolioState,
} from "./usProspectivePortfolio";
import type { UsProspectiveAnalysis } from "./usProspective";
const [a0, a2, b3] = US_PROSPECTIVE_STRATEGIES;
function state(date = "2026-12-31"): UsPortfolioState {
  return {
    lastDate: date,
    initializedDate: "2026-09-28",
    initialCapital: 100000,
    cash: 1000,
    positions: Object.fromEntries(
      [
        ["A", 70],
        ["B", 20],
      ].map(([symbol, shares]) => [
        symbol,
        {
          symbol: String(symbol),
          name: String(symbol),
          sector: "IT",
          shares: Number(shares),
          lastPrice: 100,
          entryDate: "2026-09-29",
          entryCoreRank: 0.9,
        },
      ]),
    ),
    pendingExits: {},
    pendingTargets: {},
    adv20BySymbol: { A: 1e9, B: 1e9, C: 1e9 },
    lastQuarterRebalance: "2026Q4",
    benchmarkBasePrice: null,
    benchmarkBaseDate: null,
    totalFees: 0,
  };
}
function quotes(date = "2026-12-31"): UsOrderPreviewQuote[] {
  return ["A", "B", "C"].map((symbol) => ({
    symbol,
    name: symbol,
    sector: "IT",
    close: 100,
    date,
  }));
}
function analysis(date: string, q = quotes(date)): UsProspectiveAnalysis {
  return {
    date,
    rows: q.map((r) => ({
      ...r,
      open: r.close,
      coreRank: 0.9,
      adv20Usd: 1e9,
      a0Entry: false,
      a0Exit: false,
      a2Exit: false,
      b3Exit: false,
      betaWeakStreak: 0,
    })),
  } as unknown as UsProspectiveAnalysis;
}
afterEach(() => vi.useRealTimers());
describe("US scheduled sessions", () => {
  it.each([
    ["2026-12-31", "2027-01-04"],
    ["2027-12-30", "2027-12-31"],
    ["2027-12-31", "2028-01-03"],
    ["2026-04-02", "2026-04-06"],
    ["2027-06-17", "2027-06-21"],
    ["2026-07-02", "2026-07-06"],
    ["2028-02-28", "2028-02-29"],
    ["2028-02-29", "2028-03-01"],
    ["2026-03-06", "2026-03-09"],
    ["2026-10-30", "2026-11-02"],
  ])("%s → %s honors holidays, leap days and DST", (from, to) => {
    expect(nextScheduledUsSession(from)).toBe(to);
    expect(nextScheduledUsSession(to, -1)).toBe(from);
  });
  it("does not invent Dec31 observance when next Jan1 falls on Saturday", () => {
    expect(isScheduledUsSession("2027-12-31")).toBe(true);
    expect(isScheduledUsSession("2028-01-01")).toBe(false);
    expect(isScheduledUsSession("2026-02-30")).toBe(false);
  });
});
describe("read-only model order preview", () => {
  it("is already visible on Jan1 KST/US holiday without new data, and stays January", () => {
    vi.useFakeTimers();
    const s = state(),
      before = JSON.stringify(s);
    for (const now of ["2026-12-31T15:00:00Z", "2027-01-01T15:00:00Z", "2027-01-03T18:00:00Z"]) {
      vi.setSystemTime(new Date(now));
      const preview = buildUsOrderPreview(a0!, s, quotes())!;
      expect(preview.nextQuarter).toMatchObject({
        quarter: "2027Q1",
        sourceDate: "2026-12-31",
        executionDate: "2027-01-04",
        confirmationDate: "2026-12-31",
        status: "READY",
      });
      expect(preview.nextSession.quarter).toBe("2027Q1");
      expect(isUsOrderPreviewBundle(preview, "2026-12-31")).toBe(true);
    }
    expect(JSON.stringify(s)).toBe(before);
  });
  it("shows an early-Jan1 KST last-completed Dec30 scenario as provisional, not final Dec31", () => {
    const preview = buildUsOrderPreview(a0!, state("2026-12-30"), quotes("2026-12-30"))!;
    expect(preview.nextQuarter).toMatchObject({
      status: "PROVISIONAL",
      sourceDate: "2026-12-30",
      confirmationDate: "2026-12-31",
      executionDate: "2027-01-04",
    });
    expect(preview.nextQuarter!.rows.every((r) => r.priceDate === "2026-12-30")).toBe(true);
  });
  it("matches unchanged frozen engine sizing at a flat next open including sell costs and buy cash cap", () => {
    const s = state();
    const preview = buildUsOrderPreview(a0!, s, quotes())!.nextQuarter!;
    expect(preview.rows.map((r) => [r.symbol, r.side, r.targetShares, r.estimatedShares])).toEqual([
      ["A", "SELL", 50, 20],
      ["B", "BUY", 50, 29],
    ]);
    expect(preview.rows[1]).toMatchObject({
      remainingShares: 1,
      status: "PARTIAL",
      limitReason: "현금·비용 한도",
    });
    const actual = stepUsProspectivePortfolio(a0!, analysis("2027-01-04"), s, 10000);
    for (const r of preview.rows) {
      const t = actual.trades.find((t) => t.executionDate && t.symbol === r.symbol)!;
      expect(t.modelShares).toBe(r.estimatedShares);
    }
    expect(preview.cashAfterUsd).toBeCloseTo(actual.cash, 10);
    expect(preview.feesUsd).toBeCloseTo(actual.feesUsd, 10);
  });
  it("never accepts a future-open price or mismatched quote date", () => {
    const future = quotes("2027-01-04").map((q) => ({ ...q, close: 1 }));
    const good = buildUsOrderPreview(a0!, state(), quotes())!;
    const both = buildUsOrderPreview(a0!, state(), [...quotes(), ...future])!;
    expect(both).toEqual(good);
    expect(buildUsOrderPreview(a0!, state(), future)!.nextQuarter).toMatchObject({
      status: "BLOCKED",
      cashAfterUsd: null,
    });
    expect(
      buildUsOrderPreview(a0!, state(), future)!.nextQuarter!.rows.every(
        (r) => r.estimatedShares === null,
      ),
    ).toBe(true);
  });
  it("excludes pending exits from equal weight, sells them first and respects exit capacity", () => {
    const s = state();
    s.pendingExits["A"] = { symbol: "A", signalDate: s.lastDate!, reason: "A0_BETA_ANCHOR_3D" };
    s.adv20BySymbol!["A"] = 100000; // Only ten exit shares, residual contributes to NAV.
    const preview = buildUsOrderPreview(a0!, s, quotes())!.nextQuarter!;
    expect(preview.rows.find((r) => r.symbol === "A")).toMatchObject({
      side: "EXIT",
      estimatedShares: 10,
      remainingShares: 60,
      targetWeight: 0,
    });
    expect(preview.rows.find((r) => r.symbol === "B")).toMatchObject({ targetWeight: 1 });
    const actual = stepUsProspectivePortfolio(a0!, analysis("2027-01-04"), s, 10000);
    expect(preview.cashAfterUsd).toBeCloseTo(actual.cash, 10);
    expect(preview.rows.find((r) => r.symbol === "B")!.estimatedShares).toBe(
      actual.trades.find((t) => t.executionDate && t.symbol === "B")!.modelShares,
    );
  });
  it("shows funding reductions and reserved entries for the next ordinary session", () => {
    const s = state("2026-10-01");
    s.pendingTargets = {
      A: {
        symbol: "A",
        targetWeight: 0.4,
        signalDate: s.lastDate!,
        reason: "ENTRY_MINIMUM_PROPORTIONAL_FUNDING",
      },
      C: { symbol: "C", targetWeight: 0.3, signalDate: s.lastDate!, reason: "ENTRY_ONSET80" },
    };
    const preview = buildUsOrderPreview(a0!, s, quotes(s.lastDate))!;
    expect(preview.nextSession.rows.find((r) => r.symbol === "A")).toMatchObject({
      side: "SELL",
      estimatedShares: 30,
      reason: "ENTRY_MINIMUM_PROPORTIONAL_FUNDING",
    });
    expect(preview.nextSession.rows.find((r) => r.symbol === "C")).toMatchObject({
      side: "BUY",
      currentShares: 0,
      estimatedShares: 30,
    });
    expect(preview.nextQuarter!.rows).toHaveLength(3);
    expect(preview.nextQuarter!.rows.every((r) => r.targetWeight === 1 / 3)).toBe(true);
  });
  it("does not resurrect executed January targets after January snapshot advances", () => {
    const s = state("2027-01-04");
    s.lastQuarterRebalance = "2027Q1";
    const preview = buildUsOrderPreview(a0!, s, quotes(s.lastDate))!;
    expect(preview.nextQuarter!.quarter).toBe("2027Q2");
    expect(preview.nextSession.rows).toHaveLength(0);
  });
  it("keeps no-change, sub-one-share capacity and insufficient cash distinct from missing data", () => {
    const s = state();
    s.cash = 0;
    s.positions["A"]!.shares = 50;
    s.positions["B"]!.shares = 50;
    const unchanged = buildUsOrderPreview(a0!, s, quotes())!.nextQuarter!;
    expect(unchanged.rows.every((r) => r.estimatedShares === 0 && r.status === "NO_CHANGE")).toBe(
      true,
    );
    s.positions["A"]!.shares = 70;
    s.positions["B"]!.shares = 30;
    s.adv20BySymbol = { A: 99, B: 99 };
    const limited = buildUsOrderPreview(a0!, s, quotes())!.nextQuarter!;
    expect(limited.rows.every((r) => r.estimatedShares === 0 && r.status === "PARTIAL")).toBe(true);
    expect(limited.cashAfterUsd).toBe(0);
    expect(buildUsOrderPreview(a0!, { ...s, cash: NaN }, quotes())!.nextQuarter!.status).toBe(
      "BLOCKED",
    );
  });
  it("honors A2 sector cap without changing A0, and B3 has no quarter plan", () => {
    const s = state();
    s.pendingTargets["C"] = {
      symbol: "C",
      targetWeight: 1 / 3,
      signalDate: s.lastDate!,
      reason: "ENTRY_ONSET80",
    };
    const preview = buildUsOrderPreview(a2!, s, quotes())!;
    expect(preview.nextQuarter!.rows.find((r) => r.symbol === "C")).toMatchObject({
      estimatedShares: 0,
      limitReason: "섹터 한도",
    });
    expect(buildUsOrderPreview(b3!, s, quotes())!.nextQuarter).toBeNull();
  });
  it("preserves pending-key tie order when quarterly buys compete for cash", () => {
    const s = state();
    s.cash = 1500;
    s.positions["A"]!.shares = 10;
    s.positions["B"]!.shares = 30;
    s.pendingTargets = {
      B: { symbol: "B", targetWeight: 0.4, signalDate: s.lastDate!, reason: "ENTRY_ONSET80" },
    };
    const q = quotes().map((r) => (r.symbol === "B" ? { ...r, close: 50 } : r));
    const preview = buildUsOrderPreview(a0!, s, q)!.nextQuarter!;
    const actual = stepUsProspectivePortfolio(a0!, analysis("2027-01-04", q), s, 4000);
    expect(preview.rows.map((r) => [r.symbol, r.estimatedShares])).toEqual([
      ["B", 10],
      ["A", 9],
    ]);
    expect(
      actual.trades.filter((t) => t.executionDate).map((t) => [t.symbol, t.modelShares]),
    ).toEqual([
      ["B", 10],
      ["A", 9],
    ]);
    expect(preview.cashAfterUsd).toBeCloseTo(actual.cash, 10);
  });
  it("preserves held sectors exactly when testing a later A2 new-position sector cap", () => {
    const s = state("2026-10-01");
    s.pendingTargets = {
      A: {
        symbol: "A",
        targetWeight: 0.5,
        signalDate: s.lastDate!,
        reason: "ENTRY_MINIMUM_PROPORTIONAL_FUNDING",
      },
      C: { symbol: "C", targetWeight: 0.5, signalDate: s.lastDate!, reason: "ENTRY_ONSET80" },
    };
    const q = quotes(s.lastDate).map((r) => (r.symbol === "A" ? { ...r, sector: "HEALTH" } : r));
    const preview = buildUsOrderPreview(a2!, s, q)!.nextSession;
    const actual = stepUsProspectivePortfolio(a2!, analysis("2026-10-02", q), s, 10000);
    expect(preview.rows.find((r) => r.symbol === "C")).toMatchObject({
      estimatedShares: 0,
      limitReason: expect.stringContaining("섹터 한도"),
    });
    expect(preview.cashAfterUsd).toBeCloseTo(actual.cash, 10);
    expect(actual.state.positions["C"]).toBeUndefined();
  });
  it("rejects future pending signals and mismatched map identities", () => {
    const s = state("2026-10-01");
    s.pendingTargets["A"] = {
      symbol: "A",
      targetWeight: 0.5,
      signalDate: "2026-10-03",
      reason: "ENTRY_ONSET80",
    };
    expect(buildUsOrderPreview(a0!, s, quotes(s.lastDate))).toBeNull();
    s.pendingTargets = {};
    s.positions["A"]!.symbol = "OTHER";
    expect(buildUsOrderPreview(a0!, s, quotes(s.lastDate))).toBeNull();
  });
  it("rejects saved payloads with invalid weights, duplicate rows, or misleading ready dates", () => {
    const original = buildUsOrderPreview(a0!, state(), quotes())!;
    for (const mutate of [
      (p: typeof original) => {
        p.nextQuarter!.rows[0]!.targetWeight = 8;
      },
      (p: typeof original) => {
        p.nextQuarter!.rows[0]!.referencePrice = 0;
      },
      (p: typeof original) => {
        p.nextQuarter!.rows.push(p.nextQuarter!.rows[0]!);
      },
      (p: typeof original) => {
        p.nextQuarter!.executionDate = "2027-01-02";
      },
      (p: typeof original) => {
        p.nextQuarter!.confirmationDate = "2027-12-31";
      },
      (p: typeof original) => {
        p.nextQuarter!.rows[0]!.estimatedShares = 900;
      },
    ]) {
      const payload = structuredClone(original);
      mutate(payload);
      expect(isUsOrderPreviewBundle(payload, original.sourceDate)).toBe(false);
    }
  });
  it("uses model holdings only, never imports actual exclusions/default capital", () => {
    const s = state();
    s.initialCapital = 100000;
    const preview = buildUsOrderPreview(a0!, s, quotes())!.nextQuarter!;
    expect(preview.navUsd).toBe(10000);
    expect(preview.rows.map((r) => r.symbol)).toEqual(["A", "B"]);
    expect(preview.cashBeforeUsd).toBe(1000);
  });
  it("represents empty model as empty rather than an arbitrary user quantity", () => {
    const s = state();
    s.positions = {};
    s.cash = 0;
    expect(buildUsOrderPreview(a0!, s, [])!.nextQuarter).toMatchObject({
      rows: [],
      navUsd: 0,
      cashAfterUsd: 0,
    });
    expect(buildUsOrderPreview(a0!, { ...s, lastDate: "invalid" }, [])).toBeNull();
  });
  it("rejects stale and malformed persisted bundles", () => {
    const preview = buildUsOrderPreview(a0!, state(), quotes())!;
    expect(isUsOrderPreviewBundle(preview, "2027-01-04")).toBe(false);
    expect(isUsOrderPreviewBundle({ ...preview, nextSession: {} }, preview.sourceDate)).toBe(false);
    expect(isUsOrderPreviewBundle(null, preview.sourceDate)).toBe(false);
  });
});

describe("fixed20 prospective order previews", () => {
  it("projects cutover entries without old funding or quarterly targets and matches operating fills", () => {
    const s = state("2026-10-02");
    s.cash = 10000;
    s.pendingTargets = {
      A: {
        symbol: "A",
        targetWeight: 0.1,
        signalDate: s.lastDate!,
        reason: "ENTRY_MINIMUM_PROPORTIONAL_FUNDING",
      },
      B: {
        symbol: "B",
        targetWeight: 0.9,
        signalDate: s.lastDate!,
        reason: "QUARTER_EQUAL_WEIGHT",
      },
      C: { symbol: "C", targetWeight: 1, signalDate: s.lastDate!, reason: "ENTRY_ONSET80" },
    };
    const before = structuredClone(s);
    const preview = buildUsOrderPreview(
      a0!,
      s,
      quotes(s.lastDate),
      usFixedSlotAllocationPolicy(s.initialCapital),
    )!;
    expect(preview.nextQuarter).toBeNull();
    expect(preview.nextSession.rows).toHaveLength(1);
    expect(preview.nextSession.rows[0]).toMatchObject({
      symbol: "C",
      targetShares: 50,
      estimatedShares: 50,
      side: "BUY",
    });
    expect(isUsOrderPreviewBundle(preview, s.lastDate!)).toBe(true);
    const actual = stepUsProspectiveOperatingPortfolio(a0!, analysis("2026-10-05"), s, 19000);
    expect(preview.nextSession.cashAfterUsd).toBeCloseTo(actual.cash);
    expect(preview.nextSession.feesUsd).toBeCloseTo(actual.feesUsd);
    expect(s).toEqual(before);
  });

  it("preserves oversized inherited positions and exit priority under fixed allocation", () => {
    const s = state("2026-10-02");
    s.pendingTargets["A"] = {
      symbol: "A",
      targetWeight: 1,
      signalDate: s.lastDate!,
      reason: "ENTRY_ONSET80",
    };
    s.pendingExits["B"] = { symbol: "B", signalDate: s.lastDate!, reason: "A0_BETA_ANCHOR_3D" };
    const preview = buildUsOrderPreview(
      a0!,
      s,
      quotes(s.lastDate),
      usFixedSlotAllocationPolicy(s.initialCapital),
    )!;
    expect(preview.nextSession.rows.find((r) => r.symbol === "A")).toMatchObject({
      side: "HOLD",
      targetShares: 70,
      estimatedShares: 0,
    });
    expect(preview.nextSession.rows.find((r) => r.symbol === "B")).toMatchObject({
      side: "EXIT",
      estimatedShares: 20,
    });
    expect(preview.nextQuarter).toBeNull();
  });

  it("uses isolated cash/costs and cumulative remaining fixed budget for partial orders", () => {
    const s = state("2026-10-06");
    s.initialCapital = 73551.04;
    s.cash = 73050.29;
    s.positions = { A: { ...s.positions["A"]!, shares: 5 } };
    s.executionPolicy = {
      version: "isolated-us-model-v1",
      bookId: "adopted-shadow-2026-10-05-v1:US_A0",
      contractHash: `sha256:${"a".repeat(64)}`,
      accountingStartDate: "2026-10-05",
      initialCapital: "73551.04",
      oneWayCost: "0.0015",
    };
    s.allocationPolicy = usFixedSlotAllocationPolicy(s.initialCapital);
    s.pendingTargets = {
      A: {
        symbol: "A",
        targetWeight: 0.05,
        fixedBudgetUsd: "3677.552",
        remainingBudgetUsd: "3177.552",
        fixedTargetShares: 36,
        signalDate: "2026-10-05",
        reason: "ENTRY_ONSET80",
      },
    };
    const preview = buildUsOrderPreview(
      a0!,
      s,
      quotes(s.lastDate).map((r) => ({ ...r, close: 200 })),
    )!;
    expect(preview.nextQuarter).toBeNull();
    expect(preview.nextSession.rows[0]).toMatchObject({
      estimatedShares: 15,
      remainingShares: 16,
      targetShares: 36,
    });
    expect(preview.nextSession.feesUsd).toBe(4.5);
    expect(isUsOrderPreviewBundle(preview, s.lastDate!)).toBe(true);
  });
});
