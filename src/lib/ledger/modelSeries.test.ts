import { describe, expect, it } from "vitest";
import { decimal } from "./decimal";
import { modelJournalPath } from "./modelJournal";
import { KOSPI_SHADOW_POLICY } from "../engine/kospiShadow";
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
  isAdoptedUsSeriesKind,
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
    ...(isAdoptedUsSeriesKind(kind) ? { initialFx: VERIFIED_INITIAL_FX } : {}),
  });
const calendar = (market: "KR" | "US" = "KR"): ModelCalendar => ({
  market,
  sourceHash,
  coverageStart: "2026-10-01",
  coverageEnd: "2026-10-20",
  regularSessions: [
    "2026-10-12",
    "2026-10-13",
    "2026-10-14",
    "2026-10-15",
    "2026-10-16",
    "2026-10-19",
    "2026-10-20",
  ],
});
const signal = {
  originDate: "2026-10-12",
  signalDate: "2026-10-13",
  availableAt: "2026-10-13T07:00:00Z",
};
const decisionAt = "2026-10-13T08:00:00Z";
const etfSnapshot = (): EtfStrategySnapshot => ({
  version: ETF_POLICY.version,
  date: "2026-10-13",
  previousDate: "2026-10-12",
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
  originDate: "2026-10-12",
  confirmationDate: "2026-10-13",
  confirmationIssues: [],
  averageTradingValue20: 1e9,
  dataStatus: "ready",
  krxReferenceDate: "2026-10-13",
  exit: null,
  issues: [],
});

describe("new adopted series, never historical book rewrites", () => {
  it("creates eight separately funded series with frozen costs and independent identities", async () => {
    const series = await Promise.all(ADOPTED_SERIES_KINDS.map(create));
    expect(new Set(series.map((s) => s.bookId)).size).toBe(8);
    for (const s of series) {
      expect(s).toMatchObject({
        book: "MODEL",
        version: ADOPTED_SERIES_VERSION,
        accountingStartDate: "2026-10-12",
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
    expect(series[3]!.policy.allocation).toBe("US_INITIAL_CAPITAL_DIV_TARGET_POSITIONS");
    expect(series[4]!.policy.allocation).toBe("ETF_V02_VOLATILITY_UNCHANGED");
  });

  it("creates new v2 contract identities while preserving the adopted engine policies", async () => {
    const legacyV1Hashes = {
      KR_MIXED: "7ee1fdd09122c1c3de674ba7e3ffe68e694f1cdb59b54c3ce73bb88d22ef731b",
      KR_KOSPI: "65661e9f0387015040f5201cab372ffaf53dca967f2c0b3ea01a72f67b26e795",
      KR_KOSDAQ: "e2485190b253a46b19c5f9db410e5737b74188fd501400c889f756f8f415f049",
      ETF_V02: "b1d278500c09ff757858afb27d0d67014c139c19e9e6cab728b49be10d4d069b",
    };
    for (const [kind, legacy] of Object.entries(legacyV1Hashes))
      expect((await create(kind as AdoptedSeriesKind)).contractHash).not.toBe(`sha256:${legacy}`);
    const a2 = await create("US_A2"),
      b3 = await create("US_B3"),
      kospi = await create("KR_KOSPI_CONFIRM1_BEAR");
    expect(a2.policy.allocation).toBe("US_INITIAL_CAPITAL_DIV_TARGET_POSITIONS");
    expect(a2.policy.usAllocationPolicy).toMatchObject({
      targetPositions: 20,
      initialCapitalUsd: "73551.04",
      effectiveDate: "2026-10-05",
    });
    expect((await create("US_A0")).contractHash).not.toBe(
      "sha256:9474c343941715c35ba50e7cdf3de907c6ec5b22846dad1893d0908b71d9af02",
    );
    expect(a2.policy.enginePolicy).toEqual(US_PROSPECTIVE_STRATEGIES[1]);
    expect(b3.policy.allocation).toBe("US_INITIAL_CAPITAL_DIV_TARGET_POSITIONS");
    expect(b3.policy.enginePolicy).toEqual(US_PROSPECTIVE_STRATEGIES[2]);
    expect(b3.policy.enginePolicy).toMatchObject({ quarterlyRebalance: false });
    expect(kospi.policy.enginePolicy).toEqual(KOSPI_SHADOW_POLICY);
    expect(kospi.policy.enginePolicy).toMatchObject({
      label: "KOSPI 하루확인·불황 시 RSAccel 필터",
    });
    expect(kospi.policy.enginePolicy).not.toEqual((await create("KR_KOSPI")).policy.enginePolicy);
    expect(kospi.policy.allowedMarkets).toEqual(["KOSPI"]);
    for (const series of [a2, b3]) {
      const opening = initializeModelSeries(series);
      expect(opening.cash).toEqual({ KRW: "6.016", USD: "73551.04" });
      expect(opening.positions).toEqual({});
      expect(opening.pendingSignals).toEqual([]);
      await expect(freezeAdoptedSeries({ ...base, kind: series.policy.kind })).rejects.toThrow(
        "FX missing",
      );
      expect(() => assertModelSeriesIsolation(series, initializeModelSeries(kospi))).toThrow(
        "other model",
      );
    }
    for (const series of [a2, b3, kospi]) {
      expect(
        modelJournalPath("00000000-0000-0000-0000-000000000000", series.bookId, "registry.json"),
      ).toContain(encodeURIComponent(series.bookId));
      expect(modelEngineAdapterStatus(series).status).toBe("PURE_EXECUTOR");
    }
  });

  it.each(["US_A0", "US_A2", "US_B3"] as const)(
    "%s freezes historical signal-base identity separately from effective fixed-slot prohibitions",
    async (kind) => {
      const originalCatalog = structuredClone(US_PROSPECTIVE_STRATEGIES);
      const series = await create(kind);
      expect(series.policy.enginePolicyRole).toBe("HISTORICAL_SIGNAL_STRATEGY_BASE");
      expect(series.policy.usAllocationPolicy).toEqual({
        version: "us-initial-capital-slots-v1",
        effectiveDate: "2026-10-05",
        targetPositions: 20,
        initialCapitalUsd: "73551.04",
        quarterlyRebalance: false,
        fundingOnlySales: false,
      });
      expect(series.policy.enginePolicy).toEqual(
        originalCatalog.find((strategy) => strategy.id.startsWith(kind.slice(3))),
      );
      expect(series.policy.enginePolicy).toMatchObject({ quarterlyRebalance: kind !== "US_B3" });
      expect(Object.isFrozen(series.policy.usAllocationPolicy)).toBe(true);
      expect(US_PROSPECTIVE_STRATEGIES).toEqual(originalCatalog);
      await verifyFrozenSeries(series);
      const changed = structuredClone(series);
      delete changed.policy.enginePolicyRole;
      await expect(verifyFrozenSeries(changed)).rejects.toThrow("Frozen model contract mismatch");
    },
  );

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
      freezeAdoptedSeries({ ...base, kind: "KR_MIXED", frozenAt: "2026-10-12T00:00:00Z" }),
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
      accountingStartDate: "2026-10-12",
      firstValidSessionDate: null,
    });
    expect(state.openingBalances).toHaveLength(1);
    expect(state.openingBalances[0]).toMatchObject({
      book: "MODEL",
      bookId: mixed.bookId,
      date: "2026-10-12",
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
  it("keeps Oct 12 accounting start separate from the first valid market session", async () => {
    const s = await create();
    const holidayCalendar = {
      ...calendar(),
      regularSessions: ["2026-10-01", "2026-10-02", "2026-10-13", "2026-10-14"],
    };
    expect(firstModelSession(s, holidayCalendar)).toBe("2026-10-13");
    expect(initializeModelSeries(s).accountingStartDate).toBe("2026-10-12");
    expect(firstModelSession(s, { ...holidayCalendar, regularSessions: [] })).toBeNull();
    expect(() => firstModelSession(s, calendar("US"))).toThrow("calendar");
    expect(() => firstModelSession(s, { ...calendar(), coverageStart: "2026-10-13" })).toThrow(
      "cover",
    );
    expect(() =>
      firstModelSession(s, { ...calendar(), regularSessions: ["2026-10-12", "2026-10-12"] }),
    ).toThrow("Duplicate");
  });

  it("lets old observations warm indicators while excluding future-date and late-published data", async () => {
    const s = await create();
    const old = { date: "2026-10-02", availableAt: "2026-10-02T08:00:00Z", sourceHash };
    const active = { date: "2026-10-13", availableAt: "2026-10-13T07:00:00Z", sourceHash };
    const future = { date: "2026-10-14", availableAt: "2026-10-14T07:00:00Z", sourceHash };
    const late = { date: "2026-10-12", availableAt: "2026-10-13T09:00:00Z", sourceHash };
    expect(
      partitionModelObservations(s, [old, active, future, late], "2026-10-13", decisionAt),
    ).toEqual({ warmup: [old], active: [active], excludedFuture: [future, late] });
    expect(initializeModelSeries(s).pendingSignals).toEqual([]);
  });

  it("never carries pre-start onset into an actionable confirmation", async () => {
    const s = await create();
    expect(isActionableModelSignal(s, signal, "2026-10-13", decisionAt)).toBe(true);
    expect(
      isActionableModelSignal(s, { ...signal, originDate: "2026-10-02" }, "2026-10-13", decisionAt),
    ).toBe(false);
    expect(isActionableModelSignal(s, signal, "2026-10-12", decisionAt)).toBe(false);
    expect(
      isActionableModelSignal(
        s,
        { ...signal, availableAt: "2026-10-13T09:00:00Z" },
        "2026-10-13",
        decisionAt,
      ),
    ).toBe(false);
    expect(nextModelExecutionSession(s, signal, calendar(), "2026-10-13", decisionAt)).toBe(
      "2026-10-14",
    );
    expect(
      nextModelExecutionSession(
        s,
        { ...signal, availableAt: "2026-10-15T08:00:00Z" },
        calendar(),
        "2026-10-15",
        "2026-10-15T09:00:00Z",
      ),
    ).toBeNull();
    expect(
      nextModelExecutionSession(s, signal, calendar(), "2026-10-13", "2026-10-15T09:00:00Z"),
    ).toBeNull();
    expect(
      nextModelExecutionSession(
        s,
        { ...signal, originDate: "2026-10-02" },
        calendar(),
        "2026-10-13",
        decisionAt,
      ),
    ).toBeNull();
    expect(
      nextModelExecutionSession(
        s,
        signal,
        { ...calendar(), coverageEnd: "2026-10-13", regularSessions: ["2026-10-12", "2026-10-13"] },
        "2026-10-13",
        decisionAt,
      ),
    ).toBeNull();
    expect(() =>
      nextModelExecutionSession(
        s,
        { ...signal, originDate: "2026-10-04" },
        calendar(),
        "2026-10-13",
        decisionAt,
      ),
    ).not.toThrow();
    expect(() =>
      nextModelExecutionSession(
        s,
        { ...signal, signalDate: "2026-10-16", availableAt: "2026-10-16T07:00:00Z" },
        calendar(),
        "2026-10-16",
        "2026-10-16T08:00:00Z",
      ),
    ).toThrow("regular market");
  });
});

describe("exact allocation boundary without replacing adopted engine rules", () => {
  it("uses first-year KR initial capital / 30, fee-inclusive and integer only", async () => {
    const s = await create();
    expect(krInitialSlotBudget(s, "2026-10-12")).toBe("3333333.33333333");
    expect(krInitialSlotBudget(s, "2027-10-04")).toBe("3333333.33333333");
    const quote = quoteKrModelEntry(s, { date: "2026-10-12", cash: "100000000", price: "100000" });
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
    expect(() => krInitialSlotBudget(s, "2027-10-12")).toThrow("boundary");
    expect(() => quoteModelBudget("100", "100", "0")).toThrow();
    expect(() => quoteModelBudget("100", "-1", "1")).toThrow();
  });

  it("never applies the KR first-year rule to US A0 or ETF", async () => {
    for (const kind of ["US_A0", "ETF_V02"] as const) {
      const s = await create(kind);
      expect(() => krInitialSlotBudget(s, "2026-10-12")).toThrow("must not replace");
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
      asOfDate: "2026-10-13",
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
    expect(quoteEtfModelEntry(s, { ...input, availableAt: "2026-10-13T09:00:00Z" })).toBeNull();
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
    const input = { date: "2026-10-12", sourceHash, codeHash, configHash: s.configHash };
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
    const second = await guardModelRun(s, { ...input, date: "2026-10-13", sourceHash: hash("c") });
    expect(second.status).toBe("NEW");
    expect(second.receipt.runHash).not.toBe(first.receipt.runHash);
    expect((await create()).sourceHash).toBe(sourceHash);
  });
});
