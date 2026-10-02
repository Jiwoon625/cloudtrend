import { describe, expect, it } from "vitest";
import { decimal } from "./decimal";
import { ETF_POLICY, type EtfStrategySnapshot } from "../engine/etfStrategy";
import {
  US_PROSPECTIVE_INITIAL_CAPITAL,
  US_PROSPECTIVE_ONE_WAY_COST,
  US_PROSPECTIVE_STRATEGIES,
} from "../engine/usProspectivePortfolio";
import {
  ADOPTED_SERIES_KINDS,
  ADOPTED_SERIES_VERSION,
  VERIFIED_INITIAL_FX,
  assertModelSeriesIsolation,
  canonicalSeriesJson,
  convertOfficialInitialFx,
  firstModelSession,
  freezeAdoptedSeries,
  guardModelRun,
  hashSeriesValue,
  initializeModelSeries,
  isActionableModelSignal,
  krInitialSlotBudget,
  krSlotCapacity,
  modelEngineAdapterStatus,
  nextModelExecutionSession,
  partitionModelObservations,
  quoteEtfModelEntry,
  quoteKrModelEntry,
  quoteModelBudget,
  verifyFrozenSeries,
  type AdoptedSeriesKind,
  type ModelCalendar,
  type SeriesHash,
} from "./modelSeries";

const hash = (digit: string): SeriesHash => `sha256:${digit.repeat(64)}`;
const codeHash = hash("a"),
  sourceHash = hash("b");
const frozenAt = "2026-10-02T15:37:00Z";
const base = { codeHash, sourceHash, frozenAt };
const create = (kind: AdoptedSeriesKind = "KR_MIXED") =>
  freezeAdoptedSeries({
    ...base,
    kind,
    ...(kind === "US_A0" ? { initialFx: VERIFIED_INITIAL_FX } : {}),
  });
const calendar = (market: "KR" | "US" = "KR"): ModelCalendar => ({
  market,
  sourceHash,
  coverageStart: "2026-10-01",
  coverageEnd: "2026-10-12",
  regularSessions: [
    "2026-10-01",
    "2026-10-02",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
    "2026-10-08",
    "2026-10-12",
  ],
});
const signal = {
  originDate: "2026-10-05",
  signalDate: "2026-10-06",
  availableAt: "2026-10-06T07:00:00Z",
};
const decisionAt = "2026-10-06T08:00:00Z";
const etfSnapshot = (): EtfStrategySnapshot => ({
  version: ETF_POLICY.version,
  date: "2026-10-06",
  previousDate: "2026-10-05",
  eligible: true,
  score: 85,
  previousScore: 81,
  technical: 50,
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
  onset: true,
  rawOnset: false,
  entryState: "confirmed",
  originDate: "2026-10-05",
  confirmationDate: "2026-10-06",
  confirmationIssues: [],
  averageTradingValue20: 1e9,
  dataStatus: "ready",
  krxReferenceDate: "2026-10-06",
  exit: null,
  issues: [],
});

describe("new adopted series, never historical book rewrites", () => {
  it("creates five separately funded series with frozen costs and independent identities", async () => {
    const series = await Promise.all(ADOPTED_SERIES_KINDS.map(create));
    expect(new Set(series.map((s) => s.bookId)).size).toBe(5);
    for (const s of series) {
      expect(s).toMatchObject({
        book: "MODEL",
        version: ADOPTED_SERIES_VERSION,
        accountingStartDate: "2026-10-05",
        initialKrw: "100000000",
        roundTripCost: "0.003",
        oneWayCost: "0.0015",
      });
      expect(Object.isFrozen(s)).toBe(true);
      expect(Object.isFrozen(s.policy.allowedMarkets)).toBe(true);
      await verifyFrozenSeries(s);
    }
    expect(series[0]!.policy).toMatchObject({
      maxPositions: 30,
      allowedMarkets: ["KOSPI", "KOSDAQ"],
      sectorCapByCandidateMarket: { KOSPI: 3, KOSDAQ: 6 },
    });
    expect(series[1]!.policy.allowedMarkets).toEqual(["KOSPI"]);
    expect(series[2]!.policy.allowedMarkets).toEqual(["KOSDAQ"]);
    expect(series[3]!.policy.allocation).toBe("US_A0_QUARTERLY_UNCHANGED");
    expect(series[4]!.policy.allocation).toBe("ETF_V02_VOLATILITY_UNCHANGED");
  });

  it.each(["A2_QUARTER_SHADOW", "B3_BETA_SHADOW", "KOSPI_LEGACY"])(
    "rejects reset of %s",
    async (kind) => {
      await expect(
        freezeAdoptedSeries({ ...base, kind: kind as AdoptedSeriesKind }),
      ).rejects.toThrow("immutable");
    },
  );

  it("freezes before the start and reuses only identical contracts", async () => {
    const s = await create();
    expect(await freezeAdoptedSeries({ ...base, kind: "KR_MIXED", existing: s })).toBe(s);
    await expect(
      freezeAdoptedSeries({ ...base, kind: "KR_MIXED", existing: s, sourceHash: hash("c") }),
    ).rejects.toThrow("immutable");
    await expect(
      freezeAdoptedSeries({ ...base, kind: "KR_MIXED", existing: s, codeHash: hash("c") }),
    ).rejects.toThrow("immutable");
    await expect(
      freezeAdoptedSeries({ ...base, kind: "KR_MIXED", frozenAt: "2026-10-05T00:00:00Z" }),
    ).rejects.toThrow("before accounting start");
    await expect(
      freezeAdoptedSeries({ ...base, kind: "KR_MIXED", codeHash: "unhashed" }),
    ).rejects.toThrow("SHA-256");
    await expect(verifyFrozenSeries({ ...s, oneWayCost: "0.01" as "0.0015" })).rejects.toThrow(
      "mismatch",
    );
  });

  it("starts cash-only with no imported warmup positions or pending orders", async () => {
    const mixed = await create();
    const kospi = await create("KR_KOSPI");
    const state = initializeModelSeries(mixed);
    expect(state).toMatchObject({
      cash: { KRW: "100000000", USD: "0" },
      positions: {},
      pendingSignals: [],
      accountingStartDate: "2026-10-05",
      firstValidSessionDate: null,
    });
    expect(state.openingBalances).toHaveLength(1);
    expect(state.openingBalances[0]).toMatchObject({
      book: "MODEL",
      bookId: mixed.bookId,
      date: "2026-10-05",
      cash: "100000000",
      complete: true,
    });
    expect(() => assertModelSeriesIsolation(mixed, state)).not.toThrow();
    expect(() =>
      assertModelSeriesIsolation(mixed, { ...state, book: "ACTUAL", bookId: "ACTUAL" }),
    ).toThrow("Actual");
    expect(() => assertModelSeriesIsolation(kospi, state)).toThrow("other model");
    expect(() => assertModelSeriesIsolation(mixed, { ...state, contractHash: hash("c") })).toThrow(
      "other model",
    );
  });

  it("does not mutate historical US parameters or alternative strategies", async () => {
    const before = canonicalSeriesJson(US_PROSPECTIVE_STRATEGIES);
    const s = await create("US_A0");
    expect(US_PROSPECTIVE_INITIAL_CAPITAL).toBe(100000);
    expect(US_PROSPECTIVE_ONE_WAY_COST).toBe(0.0025);
    expect(canonicalSeriesJson(US_PROSPECTIVE_STRATEGIES)).toBe(before);
    expect(modelEngineAdapterStatus(s).status).toBe("PURE_EXECUTOR");
    expect(modelEngineAdapterStatus(await create()).status).toBe("PURE_EXECUTOR");
    expect(modelEngineAdapterStatus(await create("ETF_V02")).status).toBe("PURE_EXECUTOR");
  });
});

describe("official initial FX and explicit rounding residual", () => {
  it("floors USD cents and conserves exactly 100m KRW including residual", async () => {
    const fx = convertOfficialInitialFx(VERIFIED_INITIAL_FX);
    expect(fx).toMatchObject({
      usdCash: "73551.04",
      convertedKrw: "99999993.984",
      residualKrw: "6.016",
      evidence: {
        publishedDate: "2026-10-02",
        publishedAt: null,
        rateType: "매매기준율",
        verifiedAt: "2026-10-02T15:36:09Z",
      },
    });
    expect(decimal(fx.convertedKrw) + decimal(fx.residualKrw)).toBe(decimal("100000000"));
    const state = initializeModelSeries(await create("US_A0"));
    expect(state.cash).toEqual({ KRW: "6.016", USD: "73551.04" });
    expect(state.openingBalances.map((opening) => [opening.currency, opening.cash])).toEqual([
      ["USD", "73551.04"],
      ["KRW", "6.016"],
    ]);
  });

  it("fails closed on missing, unofficial, stale, mismatched, or not-yet-known FX", async () => {
    await expect(freezeAdoptedSeries({ ...base, kind: "US_A0" })).rejects.toThrow("FX missing");
    for (const patch of [
      { verified: false },
      { publishedDate: "2026-10-01" },
      { rate: "1400" },
      { rate: "0" },
      { sourceUrl: "https://example.com" },
      { rateType: "종가" },
      { evidenceId: "" },
      { publishedAt: "2026-10-02T16:00:00Z" },
    ]) {
      expect(() => convertOfficialInitialFx({ ...VERIFIED_INITIAL_FX, ...patch })).toThrow();
    }
    await expect(
      freezeAdoptedSeries({
        ...base,
        frozenAt: "2026-10-02T15:00:00Z",
        kind: "US_A0",
        initialFx: VERIFIED_INITIAL_FX,
      }),
    ).rejects.toThrow("not known");
    await expect(
      freezeAdoptedSeries({ ...base, kind: "KR_KOSPI", initialFx: VERIFIED_INITIAL_FX }),
    ).rejects.toThrow("only belongs");
  });
});

describe("accounting, signal, execution, and point-in-time boundaries", () => {
  it("keeps Oct 5 accounting start separate from the first valid market session", async () => {
    const s = await create();
    const holidayCalendar = {
      ...calendar(),
      regularSessions: ["2026-10-01", "2026-10-02", "2026-10-06", "2026-10-07"],
    };
    expect(firstModelSession(s, holidayCalendar)).toBe("2026-10-06");
    expect(initializeModelSeries(s).accountingStartDate).toBe("2026-10-05");
    expect(firstModelSession(s, { ...holidayCalendar, regularSessions: [] })).toBeNull();
    expect(() => firstModelSession(s, calendar("US"))).toThrow("calendar");
    expect(() => firstModelSession(s, { ...calendar(), coverageStart: "2026-10-06" })).toThrow(
      "cover",
    );
    expect(() =>
      firstModelSession(s, { ...calendar(), regularSessions: ["2026-10-05", "2026-10-05"] }),
    ).toThrow("Duplicate");
  });

  it("lets old observations warm indicators while excluding future-date and late-published data", async () => {
    const s = await create();
    const old = { date: "2026-10-02", availableAt: "2026-10-02T08:00:00Z", sourceHash };
    const active = { date: "2026-10-06", availableAt: "2026-10-06T07:00:00Z", sourceHash };
    const future = { date: "2026-10-07", availableAt: "2026-10-07T07:00:00Z", sourceHash };
    const late = { date: "2026-10-05", availableAt: "2026-10-06T09:00:00Z", sourceHash };
    expect(
      partitionModelObservations(s, [old, active, future, late], "2026-10-06", decisionAt),
    ).toEqual({ warmup: [old], active: [active], excludedFuture: [future, late] });
    expect(initializeModelSeries(s).pendingSignals).toEqual([]);
  });

  it("never carries pre-start onset into an actionable confirmation", async () => {
    const s = await create();
    expect(isActionableModelSignal(s, signal, "2026-10-06", decisionAt)).toBe(true);
    expect(
      isActionableModelSignal(s, { ...signal, originDate: "2026-10-02" }, "2026-10-06", decisionAt),
    ).toBe(false);
    expect(isActionableModelSignal(s, signal, "2026-10-05", decisionAt)).toBe(false);
    expect(
      isActionableModelSignal(
        s,
        { ...signal, availableAt: "2026-10-06T09:00:00Z" },
        "2026-10-06",
        decisionAt,
      ),
    ).toBe(false);
    expect(nextModelExecutionSession(s, signal, calendar(), "2026-10-06", decisionAt)).toBe(
      "2026-10-07",
    );
    expect(
      nextModelExecutionSession(
        s,
        { ...signal, availableAt: "2026-10-08T08:00:00Z" },
        calendar(),
        "2026-10-08",
        "2026-10-08T09:00:00Z",
      ),
    ).toBeNull();
    expect(
      nextModelExecutionSession(s, signal, calendar(), "2026-10-06", "2026-10-08T09:00:00Z"),
    ).toBeNull();
    expect(
      nextModelExecutionSession(
        s,
        { ...signal, originDate: "2026-10-02" },
        calendar(),
        "2026-10-06",
        decisionAt,
      ),
    ).toBeNull();
    expect(
      nextModelExecutionSession(
        s,
        signal,
        { ...calendar(), coverageEnd: "2026-10-06", regularSessions: ["2026-10-05", "2026-10-06"] },
        "2026-10-06",
        decisionAt,
      ),
    ).toBeNull();
    expect(() =>
      nextModelExecutionSession(
        s,
        { ...signal, originDate: "2026-10-04" },
        calendar(),
        "2026-10-06",
        decisionAt,
      ),
    ).not.toThrow();
    expect(() =>
      nextModelExecutionSession(
        s,
        { ...signal, signalDate: "2026-10-09", availableAt: "2026-10-09T07:00:00Z" },
        calendar(),
        "2026-10-09",
        "2026-10-09T08:00:00Z",
      ),
    ).toThrow("regular market");
  });
});

describe("exact allocation boundary without replacing adopted engine rules", () => {
  it("uses first-year KR initial capital / 30, fee-inclusive and integer only", async () => {
    const s = await create();
    expect(krInitialSlotBudget(s, "2026-10-05")).toBe("3333333.33333333");
    expect(krInitialSlotBudget(s, "2027-10-04")).toBe("3333333.33333333");
    const quote = quoteKrModelEntry(s, { date: "2026-10-05", cash: "100000000", price: "100000" });
    expect(quote).toMatchObject({
      quantity: "33",
      gross: "3300000",
      fee: "4950",
      debit: "3304950",
    });
    const budgetBoundary = quoteModelBudget("3333333.33333333", "100000000", "100900");
    expect(budgetBoundary.quantity).toBe("32"); // Legacy rounding would choose 33 and exceed this slot budget.
    expect(decimal(budgetBoundary.debit)).toBeLessThanOrEqual(decimal(budgetBoundary.budget));
    expect(quoteModelBudget("1000", "100", "100").quantity).toBe("0");
    expect(quoteModelBudget("1000", "100.15", "100").quantity).toBe("1");
    expect(quoteModelBudget("1", "1", "0.00000001").remainingCash).not.toMatch(/^-/);
    expect(() => krInitialSlotBudget(s, "2026-10-04")).toThrow("boundary");
    expect(() => krInitialSlotBudget(s, "2027-10-05")).toThrow("boundary");
    expect(() => quoteModelBudget("100", "100", "0")).toThrow();
    expect(() => quoteModelBudget("100", "-1", "1")).toThrow();
  });

  it("never applies the KR first-year rule to US A0 or ETF", async () => {
    for (const kind of ["US_A0", "ETF_V02"] as const) {
      const s = await create(kind);
      expect(() => krInitialSlotBudget(s, "2026-10-05")).toThrow("must not replace");
    }
  });

  it("shares only the mixed book's 30 slots and applies the candidate market sector cap", async () => {
    const s = await create();
    const holdings = Array.from({ length: 3 }, () => ({
      market: "KOSDAQ" as const,
      sectorCode: "TECH",
    }));
    expect(krSlotCapacity(s, "KOSPI", "TECH", holdings)).toBe(false);
    expect(krSlotCapacity(s, "KOSDAQ", "TECH", holdings)).toBe(true);
    expect(krSlotCapacity(s, "KOSDAQ", "TECH", [...holdings, ...holdings])).toBe(false);
    expect(
      krSlotCapacity(
        s,
        "KOSPI",
        "NEW",
        Array.from({ length: 30 }, (_, i) => ({ market: "KOSPI" as const, sectorCode: String(i) })),
      ),
    ).toBe(false);
    const kospi = await create("KR_KOSPI");
    expect(() => krSlotCapacity(kospi, "KOSDAQ", "TECH", [])).toThrow("Candidate");
    expect(() => krSlotCapacity(kospi, "KOSPI", "TECH", holdings)).toThrow("Holdings");
  });

  it("reuses ETF v0.2 volatility sizing and rejects pre-start confirmation state", async () => {
    const s = await create("ETF_V02");
    const input = {
      asOfDate: "2026-10-06",
      decisionAt,
      availableAt: signal.availableAt,
      equity: "100000000",
      cash: "100000000",
      price: "10000",
      strategy: etfSnapshot(),
    };
    expect(quoteEtfModelEntry(s, input)).toMatchObject({
      budget: "5000000",
      quantity: "499",
      fee: "7485",
      debit: "4997485",
    });
    expect(
      quoteEtfModelEntry(s, { ...input, strategy: { ...input.strategy, annualVolatility: 0 } })
        ?.budget,
    ).toBe("10000000");
    expect(
      quoteEtfModelEntry(s, { ...input, strategy: { ...input.strategy, annualVolatility: null } }),
    ).toBeNull();
    expect(
      quoteEtfModelEntry(s, {
        ...input,
        strategy: { ...input.strategy, originDate: "2026-10-02" },
      }),
    ).toBeNull();
    expect(
      quoteEtfModelEntry(s, {
        ...input,
        strategy: { ...input.strategy, dataStatus: "krx_batch_pending" },
      }),
    ).toBeNull();
    expect(quoteEtfModelEntry(s, { ...input, availableAt: "2026-10-06T09:00:00Z" })).toBeNull();
  });
});

describe("deterministic hashes and date-bound immutable reuse", () => {
  it("canonicalizes key order and refuses ambiguous or lossy JSON", async () => {
    expect(await hashSeriesValue({ b: 2, a: { z: [3, 4], y: 1 } })).toBe(
      await hashSeriesValue({ a: { y: 1, z: [3, 4] }, b: 2 }),
    );
    expect(await hashSeriesValue({ a: [1, 2] })).not.toBe(await hashSeriesValue({ a: [2, 1] }));
    for (const bad of [undefined, NaN, Infinity, new Date(), { a: undefined }, new Array(2)])
      expect(() => canonicalSeriesJson(bad)).toThrow();
  });

  it("reuses identical runs but rejects a changed same-date source/config/code", async () => {
    const s = await create();
    const input = { date: "2026-10-05", sourceHash, codeHash, configHash: s.configHash };
    const first = await guardModelRun(s, input);
    expect(first.status).toBe("NEW");
    expect((await guardModelRun(s, input, first.receipt)).status).toBe("REUSE");
    await expect(
      guardModelRun(s, { ...input, sourceHash: hash("c") }, first.receipt),
    ).rejects.toThrow("Same-date");
    await expect(
      guardModelRun(s, { ...input, configHash: hash("c") }, first.receipt),
    ).rejects.toThrow("Frozen code/config");
    await expect(guardModelRun(s, { ...input, codeHash: hash("c") })).rejects.toThrow(
      "Frozen code/config",
    );
    await expect(guardModelRun(s, { ...input, date: "2026-10-02" })).rejects.toThrow("warmup");
    const second = await guardModelRun(s, { ...input, date: "2026-10-06", sourceHash: hash("c") });
    expect(second.status).toBe("NEW");
    expect(second.receipt.runHash).not.toBe(first.receipt.runHash);
    expect((await create()).sourceHash).toBe(sourceHash);
  });
});
