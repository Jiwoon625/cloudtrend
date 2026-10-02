import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  marketSignals,
  projectKrDashboard,
  projectUsDashboard,
  validateEtfHoldingSymbols,
  type DashboardIndex,
  type DashboardIndexRow,
  type DashboardHolding,
} from "../src/lib/dashboardOperations";
import { calculateActual, type ActualExecution } from "../src/lib/portfolioLedgers";
import { ETF_POLICY } from "../src/lib/engine/etfStrategy";
import type { AnalysisResult, ScreeningRow } from "../src/lib/engine/pipeline";
import type { UsProspectiveCache, UsProspectiveCacheRow } from "../src/lib/usProspectiveCloud";

const date = "2026-09-29";
const hold = (symbol: string, shares = 10, firstEntryDate = "2026-09-01"): DashboardHolding => ({
  symbol,
  name: symbol,
  shares,
  firstEntryDate,
});
const row = (symbol: string, values: Partial<DashboardIndexRow> = {}): DashboardIndexRow => ({
  symbol,
  name: symbol,
  market: "KOSDAQ",
  sector: "반도체",
  date,
  price: 12000,
  score: 9,
  priority: 1,
  onset: false,
  exitReason: null,
  ...values,
});
const index = (rows: DashboardIndexRow[], tradeDates: string[] = [date]): DashboardIndex => ({
  date,
  rows,
  tradeDates,
});
const krRow = (symbol: string, values: Partial<ScreeningRow> = {}): ScreeningRow =>
  ({
    instrument: {
      symbol,
      name: symbol,
      market: "KOSDAQ",
      instrumentType: "STOCK",
      sectorName: "반도체",
    },
    snapshot: { close: 12000 },
    priority: { points: 1 },
    operatingScore10: 9.5,
    scoreDelta1d: 40,
    kosdaq80Onset: true,
    kospi80Onset: false,
    ...values,
  }) as ScreeningRow;
const analysis = (rows: ScreeningRow[]) =>
  ({ asOfDate: date, tradeDates: [date], rows }) as AnalysisResult;
const usRow = (
  symbol: string,
  values: Partial<UsProspectiveCacheRow> = {},
): UsProspectiveCacheRow =>
  ({
    symbol,
    name: symbol,
    date,
    sector: "Technology",
    close: 100,
    coreRank: 0.85,
    a0Entry: false,
    a0Exit: false,
    a0BetaExit: false,
    ...values,
  }) as UsProspectiveCacheRow;
const us = (rows: UsProspectiveCacheRow[]) => ({ analysis: { date, rows } }) as UsProspectiveCache;

describe("actual-held signal selection", () => {
  it("excludes unheld exits, zero-share holdings, and held onsets", () => {
    const result = marketSignals(
      index([
        row("HELD", { onset: true, exitReason: "UP90" }),
        row("UNHELD", { exitReason: "UP90" }),
        row("ZERO", { exitReason: "UP90" }),
        row("NEW", { onset: true }),
      ]),
      "KOSDAQ",
      [hold("HELD"), hold("ZERO", 0)],
    );
    expect(result.onsets.map((r) => r.symbol)).toEqual(["NEW"]);
    expect(result.exits.map((r) => r.symbol)).toEqual(["HELD"]);
    expect(result.exitCount).toBe(1);
  });
  it("never truncates counts to an old top-30 list", () => {
    const rows = Array.from({ length: 72 }, (_, i) => row(`S${i}`, { onset: true }));
    const result = marketSignals(index(rows), "KOSDAQ", []);
    expect(result.onsetCount).toBe(72);
    expect(result.onsets).toHaveLength(72);
  });
  it("deduplicates symbols before counting", () => {
    expect(
      marketSignals(index([row("A", { onset: true }), row("A", { onset: true })]), "KOSDAQ", [])
        .onsetCount,
    ).toBe(1);
  });
  it("keeps unknown holdings distinct from confirmed no holdings", () => {
    const input = index([row("ETF", { market: "ETF", exitReason: "MA60" })]);
    expect(marketSignals(input, "ETF", null).exitCount).toBeNull();
    expect(marketSignals(input, "ETF", []).exitCount).toBe(0);
    expect(marketSignals(null, "US", []).onsetCount).toBeNull();
  });
  it("does not label a stale individual row as today's signal", () => {
    const result = marketSignals(
      index([row("OLD", { date: "2026-09-28", onset: true, exitReason: "UP90" })]),
      "KOSDAQ",
      [hold("OLD")],
    );
    expect(result.onsetCount).toBe(0);
    expect(result.exitCount).toBe(0);
  });
  it("does not act on positions acquired after the signal date", () => {
    expect(
      marketSignals(index([row("FUTURE", { exitReason: "UP90" })]), "KOSDAQ", [
        hold("FUTURE", 10, "2026-09-30"),
      ]).exitCount,
    ).toBe(0);
  });
  it("isolates KOSPI, KOSDAQ, and ETF even when sharing the Korean exchange", () => {
    const input = index([
      row("PI", { market: "KOSPI", onset: true }),
      row("DQ", { onset: true }),
      row("ETF", { market: "ETF", onset: true }),
    ]);
    for (const market of ["KOSPI", "KOSDAQ", "ETF"] as const)
      expect(marketSignals(input, market, []).onsetCount).toBe(1);
  });
});

describe("sold entry-signal suppression", () => {
  const fill = (
    side: "BUY" | "SELL",
    shares: number,
    executionDate: string,
    market: ActualExecution<string>["market"] = "KOSDAQ",
  ): ActualExecution<string> => ({
    id: `${side}-${executionDate}`,
    symbol: "222800",
    name: "심텍",
    market,
    signalKey: null,
    side,
    date: executionDate,
    price: 100,
    shares,
    fee: 0,
    note: "",
    order: side === "BUY" ? 0 : 1,
  });
  it("does not reintroduce today's Onset after a complete sale or repeat screening", () => {
    const projected = projectKrDashboard(analysis([krRow("222800")]));
    const book = calculateActual(
      10000,
      [fill("BUY", 3, "2026-09-28"), fill("SELL", 3, date)],
      {},
      date,
    );
    expect(book.positions).toHaveLength(0);
    for (let run = 0; run < 2; run++) {
      const result = marketSignals(projected, "KOSDAQ", book.positions, book.executions);
      expect(result.onsets).toHaveLength(0);
      expect(result.onsetCount).toBe(0);
      expect(result.exitCount).toBe(0);
    }
  });
  it("consumes a prior-close signal sold the following morning, but permits a newer dated entry", () => {
    const projected = projectKrDashboard(analysis([krRow("222800")]));
    const book = calculateActual(
      10000,
      [fill("BUY", 3, "2026-09-28"), fill("SELL", 3, "2026-09-30")],
      {},
      date,
    );
    expect(marketSignals(projected, "KOSDAQ", book.positions, book.executions).onsetCount).toBe(0);
    const fresh = {
      ...projected,
      date: "2026-10-01",
      rows: projected.rows.map((r) => ({ ...r, date: "2026-10-01" })),
    };
    expect(marketSignals(fresh, "KOSDAQ", book.positions, book.executions).onsetCount).toBe(1);
  });
  it("keeps an exit actionable for the residual position after a partial sale", () => {
    const book = calculateActual(
      10000,
      [fill("BUY", 3, "2026-09-28"), fill("SELL", 1, date)],
      {},
      date,
    );
    const result = marketSignals(
      projectKrDashboard(analysis([krRow("222800")])),
      "KOSDAQ",
      book.positions,
      book.executions,
    );
    expect(result.onsetCount).toBe(0);
    expect(result.exitCount).toBe(1);
    expect(book.positions[0]?.shares).toBe(2);
  });
  it("restores the signal when the sale is removed and does not suppress an untouched stock", () => {
    const projected = projectKrDashboard(analysis([krRow("222800")]));
    expect(marketSignals(projected, "KOSDAQ", [], []).onsetCount).toBe(1);
    expect(marketSignals(projected, "KOSDAQ", [], [fill("BUY", 3, date)]).onsetCount).toBe(1);
  });
  it("applies the same date rule to each asset group without cross-market symbol collisions", () => {
    for (const market of ["KOSPI", "KOSDAQ", "ETF", "US"] as const) {
      const input = index([row("222800", { market, onset: true })]);
      expect(marketSignals(input, market, [], [fill("SELL", 3, date, market)]).onsetCount).toBe(0);
      expect(
        marketSignals(input, market, [], [fill("SELL", 3, "2026-09-28", market)]).onsetCount,
      ).toBe(1);
      const otherMarket = market === "US" ? "ETF" : "US";
      expect(
        marketSignals(input, market, [], [fill("SELL", 3, date, otherMarket)]).onsetCount,
      ).toBe(1);
    }
  });
});

describe("current KR and ETF rules", () => {
  it("handles held SimTech-style 5.5 -> 9.5 as EXIT rather than repeated Onset", () => {
    const projected = projectKrDashboard(analysis([krRow("222800")]));
    expect(projected.rows[0]?.exitReason).toBe("UP90");
    expect(marketSignals(projected, "KOSDAQ", [hold("222800")]).exits[0]?.reason).toContain("9.0");
    expect(marketSignals(projected, "KOSDAQ", [hold("222800")]).onsetCount).toBe(0);
    expect(marketSignals(projected, "KOSDAQ", []).onsetCount).toBe(1);
  });
  it("does not sell a held stock merely for remaining above the upper score", () => {
    const projected = projectKrDashboard(
      analysis([krRow("A", { operatingScore10: 9.5, scoreDelta1d: 0, kosdaq80Onset: false })]),
    );
    expect(marketSignals(projected, "KOSDAQ", [hold("A")]).exitCount).toBe(0);
  });
  it("uses KOSPI U9.5 but no downside exit", () => {
    const stock = krRow("PI", {
      instrument: {
        symbol: "PI",
        name: "PI",
        market: "KOSPI",
        instrumentType: "STOCK",
      } as ScreeningRow["instrument"],
      operatingScore10: 2,
      scoreDelta1d: -30,
      kosdaq80Onset: false,
    });
    expect(projectKrDashboard(analysis([stock])).rows[0]?.exitReason).toBeNull();
    stock.operatingScore10 = 9.5;
    stock.scoreDelta1d = 10;
    expect(projectKrDashboard(analysis([stock])).rows[0]?.exitReason).toBe("UP95");
  });
  it("uses M0 and MA60 fields, never the stock V8 ETF fields", () => {
    const etf = krRow("069500", {
      instrument: {
        symbol: "069500",
        name: "ETF",
        instrumentType: "ETF",
        market: "KOSPI",
      } as ScreeningRow["instrument"],
      etfStrategy: {
        version: ETF_POLICY.version,
        date,
        eligible: true,
        onset: false,
        score: 85,
        exit: "MA60",
      } as ScreeningRow["etfStrategy"],
    });
    const projected = projectKrDashboard(analysis([etf]));
    expect(projected.rows[0]?.onset).toBe(false);
    expect(projected.rows[0]?.score).toBe(85);
    expect(marketSignals(projected, "ETF", [hold("069500")]).exitCount).toBe(1);
    expect(marketSignals(projected, "KOSPI", [hold("069500")]).exitCount).toBe(0);
  });
  it("requires the current confirmed ETF policy for signals", () => {
    const etf = krRow("069500", {
      instrument: {
        symbol: "069500",
        name: "ETF",
        instrumentType: "ETF",
        market: "KOSPI",
      } as ScreeningRow["instrument"],
      etfStrategy: {
        version: "old-policy",
        date,
        eligible: true,
        onset: true,
        score: 90,
        exit: "MA60",
      } as ScreeningRow["etfStrategy"],
    });
    const projected = projectKrDashboard(analysis([etf]));
    expect(projected.rows[0]?.onset).toBe(false);
    expect(projected.rows[0]?.exitReason).toBeNull();
  });
  it("recognizes H60 only from confirmed trading days at the boundary", () => {
    const days = Array.from({ length: 60 }, (_, i) =>
      new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10),
    );
    const input = index([row("H60")], days);
    expect(marketSignals(input, "KOSDAQ", [hold("H60", 1, days[0])]).exitCount).toBe(1);
    expect(
      marketSignals({ ...input, tradeDates: days.slice(1) }, "KOSDAQ", [hold("H60", 1, days[0])])
        .exitCount,
    ).toBe(0);
  });
});

describe("US A0 only", () => {
  it("ignores Shadow-only signals and SPY", () => {
    const projected = projectUsDashboard(
      us([
        usRow("SHADOW", {
          a2Entry: true,
          b3Entry: true,
          b3Exit: true,
          onset80: true,
          primarySignal: "ENTRY",
        }),
        usRow("A0", { a0Entry: true }),
        usRow("SPY", { a0Entry: true }),
      ]),
    );
    expect(marketSignals(projected, "US", []).onsets.map((r) => r.symbol)).toEqual(["A0"]);
    expect(projected.rows.some((r) => r.symbol === "SPY")).toBe(false);
    expect(JSON.stringify(projected)).not.toMatch(/a2Entry|b3Entry|primarySignal/);
  });
  it("reports A0 Beta Anchor only for held positions", () => {
    const projected = projectUsDashboard(us([usRow("BETA", { a0BetaExit: true, a0Exit: true })]));
    expect(marketSignals(projected, "US", []).exitCount).toBe(0);
    const held = marketSignals(projected, "US", [hold("BETA")]);
    expect(held.exitCount).toBe(1);
    expect(held.exits[0]?.reason).toContain("3거래일 연속");
  });
  it("labels Core exits and keeps each market's own date", () => {
    const projected = projectUsDashboard(us([usRow("CORE", { coreRank: 0.65, a0Exit: true })]));
    const result = marketSignals(projected, "US", [hold("CORE")]);
    expect(result.exits[0]?.reason).toContain("상위 30% 밖");
    expect(result.date).toBe(date);
  });
});

describe("actual execution accounting", () => {
  const execution = (
    id: string,
    side: "BUY" | "SELL",
    shares: number,
    price: number,
    order: number,
  ): ActualExecution<"US"> => ({
    id,
    symbol: "A",
    name: "A",
    market: "US",
    signalKey: null,
    side,
    date: "2026-09-01",
    shares,
    price,
    fee: 1,
    order,
    note: "test",
  });
  it("retains partially sold positions and removes fully sold positions", () => {
    const buy = execution("buy", "BUY", 10, 100, 0);
    const partial = calculateActual(
      10000,
      [buy, execution("partial", "SELL", 4, 110, 1)],
      {},
      date,
    );
    expect(partial.positions[0]?.shares).toBe(6);
    const input = index([row("A", { market: "US", exitReason: "A0 청산 신호" })]);
    expect(marketSignals(input, "US", partial.positions).exitCount).toBe(1);
    const closed = calculateActual(10000, [buy, execution("full", "SELL", 10, 110, 1)], {}, date);
    expect(marketSignals(input, "US", closed.positions).exitCount).toBe(0);
    expect(closed.summary.realizedPnl).toBe(98);
  });
  it("marks actual USD holdings without substituting model performance", () => {
    const book = calculateActual(
      10000,
      [execution("buy", "BUY", 10, 100, 0)],
      { A: { price: 110, date, exitSignal: null } },
      date,
    );
    expect(book.summary.openPositions).toBe(1);
    expect(book.summary.unrealizedPnl).toBe(99);
    expect(book.summary.realizedPnl).toBe(0);
  });
});

describe("ETF registration and dashboard preservation", () => {
  it("validates and deduplicates only six-digit ETF membership codes", () => {
    expect(validateEtfHoldingSymbols(["229200", "069500", "069500"])).toEqual(["069500", "229200"]);
    expect(validateEtfHoldingSymbols([])).toEqual([]);
    expect(() => validateEtfHoldingSymbols(["AAPL"])).toThrow();
    expect(() => validateEtfHoldingSymbols("069500")).toThrow();
  });
  it("preserves untouched dashboard panels and hides only disqualification distribution", () => {
    const source = readFileSync(new URL("../src/routes/index.tsx", import.meta.url), "utf8");
    for (const preserved of [
      "KOSPI / KOSDAQ 포트폴리오",
      "KOSPI 시장 상태 · 신규 진입 조건",
      "Sector Rotation · 전체 섹터",
      "주식 Universe 검사 생략 사유",
      "PdfExportButton",
    ])
      expect(source).toContain(preserved);
    expect(source).not.toContain("summary.failReasons");
    expect(source).not.toContain("ScreenerTable");
    expect(source).toContain("DashboardSignalLists");
  });
  it("uses only server-projected data, bounded caches, and visible-page rows", () => {
    const server = readFileSync(
      new URL("../src/lib/dashboardOperations.server.ts", import.meta.url),
      "utf8",
    );
    const ui = readFileSync(
      new URL("../src/components/DashboardOperations.tsx", import.meta.url),
      "utf8",
    );
    expect(server).not.toMatch(
      /runFullMarketAnalysis|loadActiveSources|simulateStrategy|loadUsPortfolioSnapshots/,
    );
    expect(server).toContain("auth.getUser(accessToken)");
    expect(server).toContain("memory.size >= 8");
    expect(ui).not.toMatch(
      /loadUsProspectiveCache|analysisQueryOptions|usPortfolioSnapshots|Shadow|SHADOW/,
    );
    expect(ui).toContain("rows.slice(currentPage * 25");
  });
});

describe("ETF pending-entry selection", () => {
  type EtfEntry = NonNullable<DashboardIndexRow["etfEntry"]>;
  const pendingEntry = (values: Partial<EtfEntry> = {}): EtfEntry => ({
    version: ETF_POLICY.version,
    entryState: "pending",
    originDate: date,
    confirmationDate: null,
    confirmationIssues: [],
    averageTradingValue20: 2e9,
    entryWeight: 0.05,
    dataStatus: "ready",
    krxReferenceDate: date,
    ...values,
  });
  const pendingRow = (symbol: string, values: Partial<DashboardIndexRow> = {}): DashboardIndexRow =>
    row(symbol, { market: "ETF", priority: 2e9, etfEntry: pendingEntry(), ...values });
  const sale = (
    executionDate: string,
    values: Partial<NonNullable<Parameters<typeof marketSignals>[3]>[number]> = {},
  ): NonNullable<Parameters<typeof marketSignals>[3]>[number] => ({
    symbol: "069500",
    market: "ETF",
    date: executionDate,
    side: "SELL",
    shares: 1,
    ...values,
  });

  it("selects a genuine current-policy raw Onset as pending through the KR projection", () => {
    const strategy: NonNullable<ScreeningRow["etfStrategy"]> = {
      ...pendingEntry(),
      date,
      previousDate: "2026-09-28",
      eligible: true,
      score: 85,
      previousScore: 75,
      technical: 80,
      priority: 90,
      health: 85,
      environment: 85,
      environmentSource: "stock_sector",
      region: "KR",
      sector: "반도체",
      annualVolatility: 0.3,
      underlyingClose: 120,
      underlyingMa60: 100,
      onset: false,
      rawOnset: true,
      exit: null,
      issues: [],
    };
    const projected = projectKrDashboard(
      analysis([
        krRow("069500", {
          instrument: {
            symbol: "069500",
            name: "ETF",
            instrumentType: "ETF",
            market: "KOSPI",
          } as ScreeningRow["instrument"],
          etfStrategy: strategy,
        }),
      ]),
    );
    const result = marketSignals(projected, "ETF", []);
    expect(projected.rows[0]?.etfEntry).toMatchObject(pendingEntry());
    expect(result.pending?.map((r) => r.symbol)).toEqual(["069500"]);
    expect(result.pendingCount).toBe(1);
    expect(result.onsetCount).toBe(0);
    expect(result.exitCount).toBe(0);
    expect(marketSignals(projected, "KOSPI", []).pendingCount).toBe(0);
  });

  it.each(["confirmed", "rejected", "data_pending", "none"] as const)(
    "excludes the %s entry state from pending",
    (entryState) => {
      const input = index([pendingRow("069500", { etfEntry: pendingEntry({ entryState }) })]);
      expect(marketSignals(input, "ETF", []).pendingCount).toBe(0);
    },
  );

  it.each(["incomplete", "krx_batch_pending"] as const)(
    "excludes pending entries when data is %s",
    (dataStatus) => {
      const input = index([pendingRow("069500", { etfEntry: pendingEntry({ dataStatus }) })]);
      expect(marketSignals(input, "ETF", []).pending).toEqual([]);
    },
  );

  it("rejects an old policy and missing legacy confirmation fields", () => {
    const { entryState: _entryState, ...withoutState } = pendingEntry();
    const { dataStatus: _dataStatus, ...withoutDataStatus } = pendingEntry();
    const input = index([
      pendingRow("OLD", { etfEntry: pendingEntry({ version: "old-policy" }) }),
      // Legacy persisted projections may predate required confirmation fields.
      pendingRow("NO_STATE", { etfEntry: withoutState as EtfEntry }),
      pendingRow("NO_DATA", { etfEntry: withoutDataStatus as EtfEntry }),
      pendingRow("NO_ENTRY", { etfEntry: undefined }),
    ]);
    const result = marketSignals(input, "ETF", []);
    expect(result.pending).toEqual([]);
    expect(result.pendingCount).toBe(0);
  });

  it.each(["2026-09-28", "2026-09-30", null])(
    "requires an origin on the index date instead of %s",
    (originDate) => {
      const input = index([pendingRow("069500", { etfEntry: pendingEntry({ originDate }) })]);
      expect(marketSignals(input, "ETF", []).pendingCount).toBe(0);
    },
  );

  it("requires a fresh quote even when the pending origin is current", () => {
    const input = index([pendingRow("069500", { date: "2026-09-28" })]);
    expect(marketSignals(input, "ETF", []).pendingCount).toBe(0);
  });

  it("excludes held pending entries but permits confirmed zero-share holdings", () => {
    const input = index([pendingRow("HELD"), pendingRow("ZERO"), pendingRow("UNHELD")]);
    const result = marketSignals(input, "ETF", [hold("HELD"), hold("ZERO", 0)]);
    expect(result.pending?.map((r) => r.symbol)).toEqual(["UNHELD", "ZERO"]);
    expect(result.pendingCount).toBe(2);
  });

  it.each([date, "2026-09-30"])(
    "consumes pending entries sold on or after origin (%s)",
    (executionDate) => {
      const input = index([pendingRow("069500")]);
      const result = marketSignals(input, "ETF", [], [sale(executionDate)]);
      expect(result.pending).toEqual([]);
      expect(result.pendingCount).toBe(0);
    },
  );

  it("ignores earlier sales, other-market sales, buys, and zero-share sales", () => {
    const input = index([pendingRow("069500")]);
    for (const execution of [
      sale("2026-09-28"),
      sale(date, { market: "KOSPI" }),
      sale(date, { side: "BUY" }),
      sale(date, { shares: 0 }),
    ]) {
      expect(marketSignals(input, "ETF", [], [execution]).pendingCount).toBe(1);
    }
  });

  it("deduplicates symbols before counting pending entries", () => {
    const result = marketSignals(index([pendingRow("069500"), pendingRow("069500")]), "ETF", []);
    expect(result.pending?.map((r) => r.symbol)).toEqual(["069500"]);
    expect(result.pendingCount).toBe(1);
  });

  it("keeps pending counts separate from confirmed actionable onsets", () => {
    const result = marketSignals(
      index([
        pendingRow("PENDING"),
        pendingRow("CONFIRMED", {
          onset: true,
          etfEntry: pendingEntry({
            entryState: "confirmed",
            originDate: "2026-09-28",
            confirmationDate: date,
          }),
        }),
      ]),
      "ETF",
      [],
    );
    expect(result.pending?.map((r) => r.symbol)).toEqual(["PENDING"]);
    expect(result.onsets.map((r) => r.symbol)).toEqual(["CONFIRMED"]);
    expect(result.pendingCount).toBe(1);
    expect(result.onsetCount).toBe(1);
  });

  it("orders pending entries by liquidity priority with a symbol tie-break", () => {
    const result = marketSignals(
      index([
        pendingRow("LOW", {
          priority: 1e9,
          etfEntry: pendingEntry({ averageTradingValue20: 1e9 }),
        }),
        pendingRow("B"),
        pendingRow("HIGH", {
          priority: 3e9,
          etfEntry: pendingEntry({ averageTradingValue20: 3e9 }),
        }),
        pendingRow("A"),
      ]),
      "ETF",
      [],
    );
    expect(result.pending?.map((r) => r.symbol)).toEqual(["HIGH", "A", "B", "LOW"]);
    expect(result.pendingCount).toBe(4);
  });
});

describe("ETF confirmed-entry projection", () => {
  it("ranks confirmation-day liquidity and suppresses sales since original Onset", () => {
    const entry = {
      version: ETF_POLICY.version,
      entryState: "confirmed" as const,
      originDate: "2026-09-28",
      confirmationDate: date,
      confirmationIssues: [],
      averageTradingValue20: 2e9,
      entryWeight: 0.05,
    };
    const input = index([
      row("A", { market: "ETF", onset: true, priority: 1e9, etfEntry: entry }),
      row("B", { market: "ETF", onset: true, priority: 2e9, etfEntry: entry }),
    ]);
    expect(marketSignals(input, "ETF", []).onsets.map((r) => r.symbol)).toEqual(["B", "A"]);
    const sold = [
      { symbol: "B", market: "ETF", side: "SELL" as const, date: "2026-09-28", shares: 1 },
    ];
    expect(marketSignals(input, "ETF", [], sold).onsets.map((r) => r.symbol)).toEqual(["A"]);
    expect(validateEtfHoldingSymbols(["0005G0"])).toEqual(["0005G0"]);
  });
});
