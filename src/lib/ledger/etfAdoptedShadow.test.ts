import { describe, expect, it } from "vitest";
import { ETF_POLICY, type EtfStrategySnapshot } from "../engine/etfStrategy";
import { decimal } from "./decimal";
import { nextReviewedRegularSession, regularOpenAt } from "./octoberShadowCalendar";
import {
  freezeAdoptedSeries,
  type FrozenModelSeries,
  type ModelCalendar,
  type SeriesHash,
} from "./modelSeries";
import {
  initializeEtfAdoptedShadow,
  stepAdoptedEtfSeries,
  stepEtfAdoptedShadow,
  type EtfShadowPrice,
  type EtfShadowSessionInput,
  type EtfShadowSignal,
} from "./etfAdoptedShadow";

const hash = (digit: string): SeriesHash => `sha256:${digit.repeat(64)}`;
const calendar: ModelCalendar = {
  market: "KR",
  sourceHash: hash("c"),
  coverageStart: "2026-10-12",
  coverageEnd: "2026-10-26",
  regularSessions: [
    "2026-10-12",
    "2026-10-13",
    "2026-10-14",
    "2026-10-15",
    "2026-10-16",
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-26",
  ],
};
function beforeNextOpen(date: string, minutes: number) {
  const next = nextReviewedRegularSession("KR", date);
  if (!next) throw new Error("Reviewed next KR session required in fixture");
  return new Date(Date.parse(regularOpenAt("KR", next)) - minutes * 60 * 1000).toISOString();
}
const finalizedAt = (date: string) => beforeNextOpen(date, 70);
const decisionAt = (date: string) => beforeNextOpen(date, 50);
const create = () =>
  freezeAdoptedSeries({
    kind: "ETF_V02",
    frozenAt: "2026-10-08T15:37:00Z",
    codeHash: hash("a"),
    sourceHash: hash("b"),
  });
function signal(
  symbol: string,
  date: string,
  previousDate: string,
  state: "pending" | "confirmed" | "none" = "none",
  changes: Partial<EtfStrategySnapshot> = {},
): EtfShadowSignal {
  return {
    symbol,
    availableAt: finalizedAt(date),
    sourceHash: hash("d"),
    strategy: {
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
    },
  };
}
function price(
  date: string,
  value: string | null,
  phase: "open" | "close" = "open",
): EtfShadowPrice {
  return {
    asOfDate: date,
    availableAt: phase === "open" ? `${date}T00:00:00Z` : finalizedAt(date),
    sourceHash: hash("e"),
    price: value,
  };
}
function input(
  series: FrozenModelSeries,
  date: string,
  previousSessionDate: string | null,
  closeSignals: EtfShadowSignal[] = [],
  prices: EtfShadowSessionInput["prices"] = [],
): EtfShadowSessionInput {
  return {
    sessionDate: date,
    previousSessionDate,
    openAt: `${date}T00:00:00Z`,
    closeAt: `${date}T06:30:00Z`,
    finalizedAt: finalizedAt(date),
    decisionAt: decisionAt(date),
    calendar,
    codeHash: series.codeHash,
    configHash: series.configHash,
    sourceHash: hash("f"),
    closeSignals,
    prices,
  };
}
async function confirmed(symbols = ["360750"], annualVolatility = 0.3) {
  const series = await create(),
    initial = await initializeEtfAdoptedShadow(series);
  const first = await stepEtfAdoptedShadow(
    series,
    initial,
    input(
      series,
      "2026-10-12",
      null,
      symbols.map((s) => signal(s, "2026-10-12", "2026-10-08", "pending", { annualVolatility })),
    ),
  );
  const second = await stepEtfAdoptedShadow(
    series,
    first.state,
    input(
      series,
      "2026-10-13",
      "2026-10-12",
      symbols.map((s) => signal(s, "2026-10-13", "2026-10-12", "confirmed", { annualVolatility })),
    ),
  );
  return { series, initial, first, second };
}
async function holding(close: string | null = "10000") {
  const ready = await confirmed();
  const bought = await stepEtfAdoptedShadow(
    ready.series,
    ready.second.state,
    input(
      ready.series,
      "2026-10-14",
      "2026-10-13",
      [signal("360750", "2026-10-14", "2026-10-13")],
      [
        {
          symbol: "360750",
          open: price("2026-10-14", "10000"),
          close: price("2026-10-14", close, "close"),
        },
      ],
    ),
  );
  return { ...ready, bought };
}

describe("isolated ETF V0.2 adopted shadow daily executor", () => {
  it("starts all cash at the scheduled boundary, then observes raw onset, confirm1 and next open", async () => {
    const { series, initial, first, second } = await confirmed();
    expect(initial).toMatchObject({
      book: "MODEL",
      scheduledStartDate: "2026-10-12",
      firstValidSessionDate: null,
      lastSessionDate: null,
      cash: "100000000",
      positions: [],
      pendingEntries: [],
      pendingConfirmations: [],
      pendingExits: [],
    });
    expect(initial.valuation.nav).toBe("100000000");
    expect(first.state.firstValidSessionDate).toBe("2026-10-12");
    expect(first.record.fills).toEqual([]);
    expect(first.state.pendingConfirmations).toEqual([
      { symbol: "360750", originDate: "2026-10-12" },
    ]);
    expect(second.record.fills).toEqual([]);
    expect(second.state.pendingEntries).toHaveLength(1);
    const third = await stepEtfAdoptedShadow(
      series,
      second.state,
      input(
        series,
        "2026-10-14",
        "2026-10-13",
        [],
        [
          {
            symbol: "360750",
            open: price("2026-10-14", "10000"),
            close: price("2026-10-14", "10000", "close"),
          },
        ],
      ),
    );
    expect(third.record.fills).toHaveLength(1);
    expect(third.record.fills[0]).toMatchObject({
      side: "BUY",
      executionDate: "2026-10-14",
      signalDate: "2026-10-13",
      originDate: "2026-10-12",
      quantity: "499",
      targetBudget: "5000000",
      budgetNavDate: "2026-10-13",
      gross: "4990000",
      fee: "7485",
      cashDelta: "-4997485",
    });
    expect(third.state.cash).toBe("95002515");
    expect(third.state.valuation.nav).toBe("99992515");
  });

  it("ignores current close prices/signals for every open fill and uses prior close NAV", async () => {
    const { series, second } = await confirmed();
    const run = (close: string, volatility: number) =>
      stepEtfAdoptedShadow(
        series,
        second.state,
        input(
          series,
          "2026-10-14",
          "2026-10-13",
          [signal("360750", "2026-10-14", "2026-10-13", "none", { annualVolatility: volatility })],
          [
            {
              symbol: "360750",
              open: price("2026-10-14", "10000"),
              close: price("2026-10-14", close, "close"),
            },
          ],
        ),
      );
    const low = await run("1", 50),
      high = await run("999999", 0);
    expect(low.record.fills).toEqual(high.record.fills);
    expect(low.state.valuation.nav).not.toBe(high.state.valuation.nav);
    expect(high.record.priorCloseNav).toBe("100000000");
    expect(high.record.fills[0]!.targetBudget).toBe("5000000");
  });

  it("rejects pre-start and unobserved confirmation origins without retroactive entries", async () => {
    const series = await create(),
      initial = await initializeEtfAdoptedShadow(series);
    const result = await stepEtfAdoptedShadow(
      series,
      initial,
      input(series, "2026-10-12", null, [
        signal("360750", "2026-10-12", "2026-10-08", "confirmed"),
        signal("069500", "2026-10-12", "2026-10-05", "confirmed"),
      ]),
    );
    expect(result.state.pendingEntries).toEqual([]);
    expect(result.record.issues).toEqual(
      expect.arrayContaining([
        { symbol: "360750", code: "SIGNAL_PRESTART_ORIGIN", phase: "CLOSE" },
        { symbol: "069500", code: "SIGNAL_UNOBSERVED_ORIGIN", phase: "CLOSE" },
      ]),
    );
    await expect(
      stepEtfAdoptedShadow(series, initial, input(series, "2026-10-08", null)),
    ).rejects.toThrow(/regular market session/);
  });

  it("does not seed hidden positions, entry intents, or raw setups into opening state", async () => {
    const series = await create(),
      initial = await initializeEtfAdoptedShadow(series);
    const seeded = {
      ...initial,
      pendingConfirmations: [{ symbol: "360750", originDate: "2026-10-08" }],
    };
    await expect(
      stepEtfAdoptedShadow(series, seeded, input(series, "2026-10-12", null)),
    ).rejects.toThrow(/all cash/);
  });

  it("requires the exact next covered market session, handles holidays and rejects replay", async () => {
    const { series, first, second } = await confirmed();
    await expect(
      stepEtfAdoptedShadow(series, first.state, input(series, "2026-10-14", "2026-10-12")),
    ).rejects.toThrow(/next covered/);
    await expect(
      stepEtfAdoptedShadow(series, second.state, input(series, "2026-10-14", "2026-10-05")),
    ).rejects.toThrow(/matching previous/);
    await expect(
      stepEtfAdoptedShadow(series, second.state, input(series, "2026-10-13", "2026-10-13")),
    ).rejects.toThrow(/chronology|increasing/);
    const third = await stepEtfAdoptedShadow(
      series,
      second.state,
      input(series, "2026-10-14", "2026-10-13"),
    );
    await expect(
      stepEtfAdoptedShadow(series, third.state, input(series, "2026-10-15", "2026-10-14")),
    ).rejects.toThrow(/next covered/);
    const next = await stepEtfAdoptedShadow(
      series,
      third.state,
      input(series, "2026-10-16", "2026-10-14"),
    );
    expect(next.state.lastSessionDate).toBe("2026-10-16");
  });

  it("expires an entry with missing/stale open and never fills the stale signal later", async () => {
    const { series, second } = await confirmed();
    for (const open of [
      null,
      price("2026-10-13", "10000"),
      { ...price("2026-10-14", "10000"), availableAt: "2026-10-14T00:01:00Z" },
    ]) {
      const third = await stepEtfAdoptedShadow(
        series,
        second.state,
        input(
          series,
          "2026-10-14",
          "2026-10-13",
          [],
          [{ symbol: "360750", open, close: price("2026-10-14", "10000", "close") }],
        ),
      );
      expect(third.record.fills).toEqual([]);
      expect(third.record.issues).toContainEqual({
        symbol: "360750",
        code: "ENTRY_EXPIRED_MISSING_OPEN",
        phase: "OPEN",
      });
      expect(third.state.pendingEntries).toEqual([]);
      const later = await stepEtfAdoptedShadow(
        series,
        third.state,
        input(
          series,
          "2026-10-16",
          "2026-10-14",
          [],
          [
            {
              symbol: "360750",
              open: price("2026-10-16", "10000"),
              close: price("2026-10-16", "10000", "close"),
            },
          ],
        ),
      );
      expect(later.record.fills).toEqual([]);
    }
  });

  it("uses volatility weights, integer quantities and exactly fee-inclusive budgets", async () => {
    const { series, second } = await confirmed(["360750", "069500", "251340"]);
    const pendingEntries = second.state.pendingEntries.map((entry, i) => ({
      ...entry,
      entryWeight: ["0.1", "0.05", "0.025"][i]!,
    }));
    const result = await stepEtfAdoptedShadow(
      series,
      { ...second.state, pendingEntries },
      input(
        series,
        "2026-10-14",
        "2026-10-13",
        [],
        pendingEntries.map((entry) => ({
          symbol: entry.symbol,
          open: price("2026-10-14", "10000"),
          close: price("2026-10-14", "10000", "close"),
        })),
      ),
    );
    const fills = new Map(result.record.fills.map((fill) => [fill.symbol, fill]));
    expect(fills.get("360750")!.quantity).toBe("998");
    expect(fills.get("069500")!.quantity).toBe("499");
    expect(fills.get("251340")!.quantity).toBe("249");
    for (const fill of fills.values()) {
      expect(fill.quantity).toMatch(/^\d+$/);
      expect(-decimal(fill.cashDelta)).toBeLessThanOrEqual(decimal(fill.targetBudget!));
      expect(decimal(fill.fee)).toBe((decimal(fill.gross) * 15n) / 10000n);
    }
    expect(decimal(result.state.cash)).toBeGreaterThanOrEqual(0n);
  });

  it("derives frozen entry weights from the existing engine volatility formula", async () => {
    const zero = await confirmed(["360750"], 0),
      high = await confirmed(["360750"], 0.6);
    expect(zero.second.state.pendingEntries[0]!.entryWeight).toBe("0.10000000");
    expect(high.second.state.pendingEntries[0]!.entryWeight).toBe("0.02500000");
  });

  it("caps an appreciated-NAV target at available cash without fractional or unfunded shares", async () => {
    const { series, second } = await confirmed();
    const bought = await stepEtfAdoptedShadow(
      series,
      second.state,
      input(
        series,
        "2026-10-14",
        "2026-10-13",
        [signal("069500", "2026-10-14", "2026-10-13", "pending", { annualVolatility: 0 })],
        [
          {
            symbol: "360750",
            open: price("2026-10-14", "10000"),
            close: price("2026-10-14", "10000000", "close"),
          },
        ],
      ),
    );
    const ready = await stepEtfAdoptedShadow(
      series,
      bought.state,
      input(
        series,
        "2026-10-16",
        "2026-10-14",
        [signal("069500", "2026-10-16", "2026-10-14", "confirmed", { annualVolatility: 0 })],
        [
          {
            symbol: "360750",
            open: price("2026-10-16", "10000000"),
            close: price("2026-10-16", "10000000", "close"),
          },
        ],
      ),
    );
    const next = await stepEtfAdoptedShadow(
      series,
      ready.state,
      input(
        series,
        "2026-10-19",
        "2026-10-16",
        [],
        [
          {
            symbol: "069500",
            open: price("2026-10-19", "10000"),
            close: price("2026-10-19", "10000", "close"),
          },
        ],
      ),
    );
    const fill = next.record.fills[0]!;
    expect(decimal(fill.targetBudget!)).toBeGreaterThan(decimal(ready.state.cash));
    expect(-decimal(fill.cashDelta)).toBeLessThanOrEqual(decimal(ready.state.cash));
    expect(decimal(next.state.cash)).toBeGreaterThanOrEqual(0n);
    expect(decimal(next.state.cash)).toBeLessThan(decimal("10015"));
    expect(next.state.positions).toHaveLength(2);
    expect(next.record.fills.map((entry) => entry.side)).toEqual(["BUY"]);
  });

  it("ranks liquidity then symbol, caps at ten and leaves lower-priority entries unfilled", async () => {
    const symbols = Array.from({ length: 12 }, (_, i) => `${i + 1}`.padStart(6, "0")).reverse();
    const { series, first } = await confirmed(symbols, 0);
    const signals = symbols.map((s) =>
      signal(s, "2026-10-13", "2026-10-12", "confirmed", {
        annualVolatility: 0,
        averageTradingValue20: s === "000012" ? 2e9 : 1e9,
      }),
    );
    const second = await stepEtfAdoptedShadow(
      series,
      first.state,
      input(series, "2026-10-13", "2026-10-12", signals),
    );
    const third = await stepEtfAdoptedShadow(
      series,
      second.state,
      input(
        series,
        "2026-10-14",
        "2026-10-13",
        [],
        symbols.map((s) => ({
          symbol: s,
          open: price("2026-10-14", "10000"),
          close: price("2026-10-14", "10000", "close"),
        })),
      ),
    );
    expect(third.record.fills.map((fill) => fill.symbol)).toEqual([
      "000012",
      "000001",
      "000002",
      "000003",
      "000004",
      "000005",
      "000006",
      "000007",
      "000008",
      "000009",
    ]);
    expect(third.state.positions).toHaveLength(10);
    expect(
      third.record.issues.filter((issue) => issue.code === "ENTRY_EXPIRED_MAX_POSITIONS"),
    ).toHaveLength(2);
    expect(decimal(third.state.cash)).toBeGreaterThanOrEqual(0n);
    expect(third.record.fills.every((fill) => fill.quantity === "998")).toBe(true);
  });

  it("keeps held positions without replacement or forced liquidation when data is missing", async () => {
    const { series, bought } = await holding();
    const result = await stepEtfAdoptedShadow(
      series,
      bought.state,
      input(series, "2026-10-16", "2026-10-14"),
    );
    expect(result.record.fills).toEqual([]);
    expect(result.state.positions).toHaveLength(1);
    expect(result.state.valuation).toMatchObject({ status: "STALE", nav: "99992515" });
    expect(result.state.valuation.marks[0]).toMatchObject({
      status: "STALE",
      asOfDate: "2026-10-14",
      price: "10000",
    });
    expect(result.record.issues).toContainEqual({
      symbol: "360750",
      code: "MARK_STALE",
      phase: "CLOSE",
    });
  });

  it("marks NAV missing rather than treating an unmarked newly bought holding as zero", async () => {
    const { bought } = await holding(null);
    expect(bought.state.valuation).toMatchObject({
      status: "MISSING",
      nav: null,
      marketValue: null,
      unrealizedPnl: null,
    });
    expect(bought.record.issues).toContainEqual({
      symbol: "360750",
      code: "MARK_MISSING",
      phase: "CLOSE",
    });
  });

  it("expires new entries when the prior NAV depends on carried stale marks", async () => {
    const { series, second } = await confirmed();
    const bought = await stepEtfAdoptedShadow(
      series,
      second.state,
      input(
        series,
        "2026-10-14",
        "2026-10-13",
        [signal("069500", "2026-10-14", "2026-10-13", "pending")],
        [
          {
            symbol: "360750",
            open: price("2026-10-14", "10000"),
            close: price("2026-10-14", "10000", "close"),
          },
        ],
      ),
    );
    const stale = await stepEtfAdoptedShadow(
      series,
      bought.state,
      input(series, "2026-10-16", "2026-10-14", [
        signal("069500", "2026-10-16", "2026-10-14", "confirmed"),
      ]),
    );
    expect(stale.state.valuation.status).toBe("STALE");
    const next = await stepEtfAdoptedShadow(
      series,
      stale.state,
      input(
        series,
        "2026-10-19",
        "2026-10-16",
        [],
        [
          {
            symbol: "069500",
            open: price("2026-10-19", "10000"),
            close: price("2026-10-19", "10000", "close"),
          },
        ],
      ),
    );
    expect(next.record.fills).toEqual([]);
    expect(next.record.issues).toContainEqual({
      symbol: "069500",
      code: "ENTRY_EXPIRED_STALE_PRIOR_NAV",
      phase: "OPEN",
    });
    expect(next.state.positions.map((position) => position.symbol)).toEqual(["360750"]);
  });

  it("does not use a later recovered close to size this morning's entry after missing prior NAV", async () => {
    const { series, second } = await confirmed();
    const bought = await stepEtfAdoptedShadow(
      series,
      second.state,
      input(
        series,
        "2026-10-14",
        "2026-10-13",
        [signal("069500", "2026-10-14", "2026-10-13", "pending")],
        [{ symbol: "360750", open: price("2026-10-14", "10000"), close: null }],
      ),
    );
    const ready = await stepEtfAdoptedShadow(
      series,
      bought.state,
      input(series, "2026-10-16", "2026-10-14", [
        signal("069500", "2026-10-16", "2026-10-14", "confirmed"),
      ]),
    );
    expect(ready.state.pendingEntries).toHaveLength(1);
    const next = await stepEtfAdoptedShadow(
      series,
      ready.state,
      input(
        series,
        "2026-10-19",
        "2026-10-16",
        [],
        [
          {
            symbol: "069500",
            open: price("2026-10-19", "10000"),
            close: price("2026-10-19", "10000", "close"),
          },
          {
            symbol: "360750",
            open: price("2026-10-19", "10000"),
            close: price("2026-10-19", "10000", "close"),
          },
        ],
      ),
    );
    expect(next.record.fills).toEqual([]);
    expect(next.record.issues).toContainEqual({
      symbol: "069500",
      code: "ENTRY_EXPIRED_INCOMPLETE_PRIOR_NAV",
      phase: "OPEN",
    });
    expect(next.state.valuation.status).toBe("COMPLETE");
  });

  it("executes a close MA60 exit only at the next market open and records round-trip fees", async () => {
    const { series, second } = await confirmed();
    const bought = await stepEtfAdoptedShadow(
      series,
      second.state,
      input(
        series,
        "2026-10-14",
        "2026-10-13",
        [
          signal("360750", "2026-10-14", "2026-10-13", "none", {
            exit: "MA60",
            underlyingClose: 90,
          }),
        ],
        [
          {
            symbol: "360750",
            open: price("2026-10-14", "10000"),
            close: price("2026-10-14", "9000", "close"),
          },
        ],
      ),
    );
    expect(bought.record.fills.map((fill) => fill.side)).toEqual(["BUY"]);
    expect(bought.state.pendingExits).toHaveLength(1);
    const sold = await stepEtfAdoptedShadow(
      series,
      bought.state,
      input(
        series,
        "2026-10-16",
        "2026-10-14",
        [],
        [
          {
            symbol: "360750",
            open: price("2026-10-16", "10000"),
            close: price("2026-10-16", "20000", "close"),
          },
        ],
      ),
    );
    expect(sold.record.fills[0]).toMatchObject({
      side: "SELL",
      reason: "MA60",
      signalDate: "2026-10-14",
      executionDate: "2026-10-16",
      quantity: "499",
      fee: "7485",
      realizedPnl: "-14970",
    });
    expect(sold.state).toMatchObject({
      cash: "99985030",
      realizedPnl: "-14970",
      cumulativeFees: "14970",
      positions: [],
      pendingExits: [],
    });
  });

  it("keeps an MA60 exit pending across missing opens without fabricating a fill", async () => {
    const { series, bought } = await holding();
    const signaled = await stepEtfAdoptedShadow(
      series,
      bought.state,
      input(series, "2026-10-16", "2026-10-14", [
        signal("360750", "2026-10-16", "2026-10-14", "none", { exit: "MA60", underlyingClose: 90 }),
      ]),
    );
    const delayed = await stepEtfAdoptedShadow(
      series,
      signaled.state,
      input(series, "2026-10-19", "2026-10-16"),
    );
    expect(delayed.record.fills).toEqual([]);
    expect(delayed.state.pendingExits).toHaveLength(1);
    expect(delayed.record.issues).toContainEqual({
      symbol: "360750",
      code: "EXIT_DELAYED_MISSING_OPEN",
      phase: "OPEN",
    });
    const filled = await stepEtfAdoptedShadow(
      series,
      delayed.state,
      input(
        series,
        "2026-10-20",
        "2026-10-19",
        [],
        [{ symbol: "360750", open: price("2026-10-20", "9900"), close: null }],
      ),
    );
    expect(filled.record.fills[0]).toMatchObject({
      side: "SELL",
      signalDate: "2026-10-16",
      executionDate: "2026-10-20",
    });
    expect(filled.state.positions).toEqual([]);
  });

  it("fails closed for future close evidence, wrong dates, delayed KRX and invalid confirmations", async () => {
    const { series, first } = await confirmed();
    const variants: EtfShadowSignal[] = [
      {
        ...signal("360750", "2026-10-13", "2026-10-12", "confirmed"),
        availableAt: "2026-10-13T08:00:00Z",
      },
      signal("360750", "2026-10-14", "2026-10-12", "confirmed"),
      signal("360750", "2026-10-13", "2026-10-12", "confirmed", {
        dataStatus: "krx_batch_pending",
      }),
      signal("360750", "2026-10-13", "2026-10-12", "confirmed", { underlyingClose: 90 }),
    ];
    for (const candidate of variants) {
      const result = await stepEtfAdoptedShadow(
        series,
        first.state,
        input(series, "2026-10-13", "2026-10-12", [candidate]),
      );
      expect(result.state.pendingEntries).toEqual([]);
      expect(result.record.issues.length).toBeGreaterThan(0);
    }
  });

  it("preserves frozen provenance, rejects other books and never mutates inputs", async () => {
    const { series, second } = await confirmed();
    const previousJson = JSON.stringify(second.state);
    const nextInput = input(
      series,
      "2026-10-14",
      "2026-10-13",
      [],
      [
        {
          symbol: "360750",
          open: price("2026-10-14", "0.00000001"),
          close: price("2026-10-14", "0.00000001", "close"),
        },
      ],
    );
    const inputJson = JSON.stringify(nextInput);
    const result = await stepEtfAdoptedShadow(series, second.state, nextInput);
    expect(JSON.stringify(second.state)).toBe(previousJson);
    expect(JSON.stringify(nextInput)).toBe(inputJson);
    expect(Object.isFrozen(result.state.positions[0])).toBe(true);
    expect(result.record.receipt).toMatchObject({
      codeHash: series.codeHash,
      configHash: series.configHash,
      sourceHash: hash("f"),
      contractHash: series.contractHash,
    });
    const fill = result.record.fills[0]!;
    expect(decimal(fill.gross) + decimal(fill.fee)).toBeLessThanOrEqual(
      decimal(fill.targetBudget!),
    );
    await expect(
      stepEtfAdoptedShadow(series, second.state, { ...nextInput, codeHash: hash("9") }),
    ).rejects.toThrow(/Frozen code\/config changed/);
    await expect(
      stepEtfAdoptedShadow(series, { ...second.state, bookId: "ACTUAL" }, nextInput),
    ).rejects.toThrow(/cannot enter/);
    await expect(
      stepEtfAdoptedShadow(series, second.state, {
        ...nextInput,
        prices: [...nextInput.prices, ...nextInput.prices],
      }),
    ).rejects.toThrow(/Duplicate/);
  });
});

describe("ETF immutable journal run wrapper", () => {
  it("binds complete input and predecessor state/record, and reuses identical same-day runs", async () => {
    const series = await create();
    const firstInput = input(series, "2026-10-12", null, [
      signal("360750", "2026-10-12", "2026-10-08", "pending"),
    ]);
    const first = await stepAdoptedEtfSeries(series, firstInput);
    expect(first.status).toBe("NEW");
    expect(first.run).toMatchObject({
      book: "MODEL",
      bookId: series.bookId,
      contractHash: series.contractHash,
      previousStateHash: null,
    });
    expect(first.run.receipt.sourceHash).not.toBe(firstInput.sourceHash);
    expect(first.run.receipt).toEqual(first.run.result.record.receipt);
    const reused = await stepAdoptedEtfSeries(series, structuredClone(firstInput), first.run);
    expect(reused.status).toBe("REUSE");
    expect(reused.run).toBe(first.run);
    const secondInput = input(series, "2026-10-13", "2026-10-12", [
      signal("360750", "2026-10-13", "2026-10-12", "confirmed"),
    ]);
    const second = await stepAdoptedEtfSeries(series, secondInput, first.run);
    expect(second.run.previousStateHash).toBe(first.run.stateHash);
    expect(second.run.result.state.pendingEntries).toHaveLength(1);
    expect((await stepAdoptedEtfSeries(series, secondInput, second.run)).run).toBe(second.run);
    const third = await stepAdoptedEtfSeries(
      series,
      input(
        series,
        "2026-10-14",
        "2026-10-13",
        [],
        [
          {
            symbol: "360750",
            open: price("2026-10-14", "10000"),
            close: price("2026-10-14", "10000", "close"),
          },
        ],
      ),
      second.run,
    );
    expect(third.run.result.record.fills[0]!.quantity).toBe("499");
    expect(third.run.previousStateHash).toBe(second.run.stateHash);
    expect(Object.isFrozen(third.run.result.record)).toBe(true);
    expect(first.run.result.state.positions).toEqual([]);
  });

  it("rejects changed same-date prices, signals, calendar, timing or declared provenance", async () => {
    const series = await create();
    const firstInput = input(
      series,
      "2026-10-12",
      null,
      [signal("360750", "2026-10-12", "2026-10-08", "pending")],
      [
        {
          symbol: "360750",
          open: price("2026-10-12", "10000"),
          close: price("2026-10-12", "10000", "close"),
        },
      ],
    );
    const first = await stepAdoptedEtfSeries(series, firstInput);
    const alteredPrice = structuredClone(firstInput);
    alteredPrice.prices[0]!.close!.price = "10001";
    const alteredSignal = structuredClone(firstInput);
    alteredSignal.closeSignals[0]!.strategy.score = 90;
    const alteredCalendar = structuredClone(firstInput);
    alteredCalendar.calendar.sourceHash = hash("9");
    for (const changed of [
      alteredPrice,
      alteredSignal,
      alteredCalendar,
      { ...firstInput, closeAt: "2026-10-12T07:01:00Z" },
      { ...firstInput, sourceHash: hash("9") },
    ])
      await expect(stepAdoptedEtfSeries(series, changed, first.run)).rejects.toThrow(/Same-date/);
    await expect(
      stepAdoptedEtfSeries(series, { ...firstInput, configHash: hash("9") }, first.run),
    ).rejects.toThrow(/Frozen code\/config/);
  });

  it("rejects changed prior state, prior daily record, predecessor pointer and wrong book", async () => {
    const series = await create();
    const first = await stepAdoptedEtfSeries(series, input(series, "2026-10-12", null));
    const next = input(series, "2026-10-13", "2026-10-12");
    const alteredState = structuredClone(first.run);
    alteredState.result.state.cash = "100000001";
    const alteredRecord = structuredClone(first.run);
    alteredRecord.result.record.fees = "1";
    for (const changed of [
      alteredState,
      alteredRecord,
      { ...first.run, previousStateHash: hash("9") },
    ])
      await expect(stepAdoptedEtfSeries(series, next, changed)).rejects.toThrow(
        /provenance mismatch/,
      );
    await expect(
      stepAdoptedEtfSeries(series, next, { ...first.run, bookId: "ACTUAL" }),
    ).rejects.toThrow(/cannot enter/);
    await expect(
      stepAdoptedEtfSeries(series, input(series, "2026-10-14", "2026-10-12"), first.run),
    ).rejects.toThrow(/next covered/);
  });

  it("normalizes offset timestamps to Asia/Seoul rather than comparing their written date", async () => {
    const series = await create();
    const firstInput = input(series, "2026-10-12", null, [
      {
        ...signal("360750", "2026-10-12", "2026-10-08", "pending"),
        availableAt: "2026-10-05T23:40:00-07:00",
      },
    ]);
    firstInput.openAt = "2026-10-05T20:00:00-04:00";
    firstInput.closeAt = "2026-10-12T16:00:00+09:00";
    const first = await stepAdoptedEtfSeries(series, firstInput);
    expect(first.run.result.state.pendingConfirmations).toHaveLength(1);
    await expect(
      stepAdoptedEtfSeries(series, { ...firstInput, closeAt: "2026-10-12T16:00:00Z" }),
    ).rejects.toThrow(/chronology/);
    await expect(
      stepAdoptedEtfSeries(series, { ...firstInput, openAt: "2026-10-12T00:00:00+10:00" }),
    ).rejects.toThrow(/chronology/);
  });

  it("rejects removal of an archived calendar session or shrinking coverage, while allowing extension", async () => {
    const series = await create();
    const first = await stepAdoptedEtfSeries(series, input(series, "2026-10-12", null));
    const skipped = input(series, "2026-10-14", "2026-10-12");
    skipped.calendar = {
      ...calendar,
      regularSessions: calendar.regularSessions.filter((date) => date !== "2026-10-13"),
    };
    await expect(stepAdoptedEtfSeries(series, skipped, first.run)).rejects.toThrow(
      /calendar|session|coverage/i,
    );
    const shrunk = input(series, "2026-10-13", "2026-10-12");
    shrunk.calendar = {
      ...calendar,
      coverageEnd: "2026-10-23",
      regularSessions: calendar.regularSessions.filter((date) => date <= "2026-10-23"),
    };
    await expect(stepAdoptedEtfSeries(series, shrunk, first.run)).rejects.toThrow(
      /calendar|coverage/i,
    );
    const extended = input(series, "2026-10-13", "2026-10-12");
    extended.calendar = {
      ...calendar,
      sourceHash: hash("9"),
      coverageEnd: "2026-10-21",
      regularSessions: [...calendar.regularSessions, "2026-10-21"],
    };
    const second = await stepAdoptedEtfSeries(series, extended, first.run);
    expect(second.status).toBe("NEW");
    expect(second.run.calendar).toEqual(extended.calendar);
    expect(second.run.calendar).not.toBe(extended.calendar);
    expect(Object.isFrozen(extended.calendar)).toBe(false);
    expect(first.run.calendar.coverageEnd).toBe("2026-10-26");
  });
});
