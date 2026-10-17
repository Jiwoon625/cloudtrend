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
import { ETF_MAPPING, ETF_POLICY, isEtfStrategyAssetClass } from "../src/lib/engine/etfStrategy";
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
  it.each(["0046A0", "0048J0", "423160", "069500"])(
    "keeps %s missing-underlying diagnostics out of actual EXIT without changing the source",
    (symbol) => {
      const etf = krRow(symbol, {
        instrument: {
          symbol,
          name: "Synthetic missing-data ETF",
          instrumentType: "ETF",
          market: "KOSPI",
        } as ScreeningRow["instrument"],
        snapshot: { tradeDate: date, close: 100 } as ScreeningRow["snapshot"],
        etfStrategy: {
          version: ETF_POLICY.version,
          date,
          dataStatus: "incomplete",
          eligible: false,
          onset: false,
          score: null,
          underlyingClose: 100,
          underlyingMa60: null,
          exit: "DATA_UNAVAILABLE",
          issues: ["기초지수 MA60·추세 이력 부족"],
        } as ScreeningRow["etfStrategy"],
      });
      const source = analysis([etf]),
        before = JSON.stringify(source);
      for (let refresh = 0; refresh < 3; refresh++) {
        const projected = projectKrDashboard(source);
        expect(projected.rows[0]?.exitReason).toBeNull();
        const result = marketSignals(projected, "ETF", [hold(symbol)]);
        expect(result.exitCount).toBe(0);
        expect(result.exits).toEqual([]);
        expect(result.assessments?.[0]).toMatchObject({
          held: true,
          etfAssessment: { underlyingJudgment: "unconfirmed", underlyingMa60: null },
        });
      }
      expect(JSON.stringify(source)).toBe(before);
      // A real MA60 observation remains actionable even if unrelated M0 data is missing.
      etf.etfStrategy!.exit = "MA60";
      etf.etfStrategy!.underlyingMa60 = 110;
      expect(marketSignals(projectKrDashboard(source), "ETF", [hold(symbol)]).exits).toMatchObject([
        { symbol, reason: "기초지수 MA60 하회" },
      ]);
    },
  );
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
      "KOSPI 시장 상태 · 진입 조건",
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
      /loadUsProspectiveCache|analysisQueryOptions|usPortfolioSnapshots|loadOctoberShadow|october-shadow-summary/,
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

  const waitingIndex = (): DashboardIndex => {
    const previous = "2027-06-25",
      current = "2027-06-28";
    return {
      date: current,
      tradeDates: ["2027-06-24", previous, current],
      rows: [
        pendingRow("SYN001", {
          date: current,
          score: null,
          etfEntry: pendingEntry({
            entryState: "data_pending",
            dataStatus: "krx_batch_pending",
            originDate: previous,
            confirmationDate: current,
            krxReferenceDate: previous,
            entryWeight: null,
            averageTradingValue20: null,
            confirmationIssues: ["KRX 일괄 미수신으로 확인 대기"],
          }),
          etfAssessment: {
            current: true,
            krxPending: true,
            previousDate: previous,
            previousScore: 84,
          } as NonNullable<DashboardIndexRow["etfAssessment"]>,
        }),
      ],
    };
  };

  it("preserves an observed previous-session setup during the confirmation-day KRX delay", () => {
    const input = waitingIndex(),
      before = JSON.stringify(input);
    for (let replay = 0; replay < 3; replay++) {
      const result = marketSignals(input, "ETF", [], [], null, "2026-10-12");
      expect(result.pendingCount).toBe(1);
      expect(result.pending).toMatchObject([
        {
          symbol: "SYN001",
          date: "2027-06-28",
          score: null,
          signalOriginDate: "2027-06-25",
          reason: "KRX 자료 대기 · 기존 확인대기 유지",
        },
      ]);
      expect(result.conditionCount).toBe(0);
      expect(result.onsetCount).toBe(0);
      expect(result.exitCount).toBe(0);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    [
      "no origin",
      (r: DashboardIndexRow) => {
        r.etfEntry!.originDate = null;
      },
    ],
    [
      "same-day origin",
      (r: DashboardIndexRow) => {
        r.etfEntry!.originDate = r.date;
      },
    ],
    [
      "older origin",
      (r: DashboardIndexRow) => {
        r.etfEntry!.originDate = "2027-06-24";
      },
    ],
    [
      "rejected",
      (r: DashboardIndexRow) => {
        r.etfEntry!.entryState = "rejected";
      },
    ],
    [
      "isolated incomplete",
      (r: DashboardIndexRow) => {
        r.etfEntry!.dataStatus = "incomplete";
      },
    ],
    [
      "stale quote",
      (r: DashboardIndexRow) => {
        r.date = "2027-06-25";
      },
    ],
    [
      "stale evidence",
      (r: DashboardIndexRow) => {
        r.etfAssessment!.current = false;
      },
    ],
    [
      "missing evidence",
      (r: DashboardIndexRow) => {
        r.etfAssessment = undefined;
      },
    ],
    [
      "missing prior score",
      (r: DashboardIndexRow) => {
        r.etfAssessment!.previousScore = null;
      },
    ],
    [
      "low prior score",
      (r: DashboardIndexRow) => {
        r.etfAssessment!.previousScore = 79;
      },
    ],
    [
      "wrong previous date",
      (r: DashboardIndexRow) => {
        r.etfAssessment!.previousDate = "2027-06-24";
      },
    ],
    [
      "wrong KRX date",
      (r: DashboardIndexRow) => {
        r.etfEntry!.krxReferenceDate = "2027-06-24";
      },
    ],
    [
      "wrong confirmation date",
      (r: DashboardIndexRow) => {
        r.etfEntry!.confirmationDate = null;
      },
    ],
    [
      "legacy policy",
      (r: DashboardIndexRow) => {
        r.etfEntry!.version = "legacy";
      },
    ],
    [
      "contradictory onset",
      (r: DashboardIndexRow) => {
        r.onset = true;
      },
    ],
    [
      "known exit",
      (r: DashboardIndexRow) => {
        r.exitReason = "MA60";
      },
    ],
  ] as const)("does not manufacture KRX-waiting setups from %s", (_label, change) => {
    const input = waitingIndex();
    change(input.rows[0]!);
    expect(marketSignals(input, "ETF", []).pendingCount).toBe(0);
  });

  it("requires a consecutive known market calendar and respects series start, holdings, and sales", () => {
    const input = waitingIndex();
    expect(marketSignals({ ...input, tradeDates: [] }, "ETF", []).pendingCount).toBe(0);
    expect(marketSignals({ ...input, tradeDates: ["2027-06-25"] }, "ETF", []).pendingCount).toBe(0);
    expect(marketSignals(input, "ETF", [], [], null, "2027-06-28").pendingCount).toBe(0);
    expect(marketSignals(input, "ETF", [hold("SYN001")]).pendingCount).toBe(0);
    expect(
      marketSignals(input, "ETF", [], [sale("2027-06-25", { symbol: "SYN001" })]).pendingCount,
    ).toBe(0);
    expect(
      marketSignals(input, "ETF", [], [sale("2027-06-28", { symbol: "SYN001" })]).pendingCount,
    ).toBe(0);
    expect(
      marketSignals(input, "ETF", [], [sale("2027-06-24", { symbol: "SYN001" })]).pendingCount,
    ).toBe(1);
  });

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

describe("restart action-list signal provenance", () => {
  const start = "2026-10-12";
  const date = "2026-10-13";
  const source = (rows: DashboardIndexRow[], dateOverride = date): DashboardIndex => ({
    date: dateOverride,
    rows,
    tradeDates: [start, date],
  });
  const kospi = (originDate: string | null, state: "confirmed" | "pending" = "confirmed") =>
    row("005930", {
      market: "KOSPI",
      date,
      onset: true,
      exitReason: "UP95",
      kospiEntry: {
        version: "test",
        date,
        originDate,
        confirmationDate: date,
        state,
        issues: [],
        rsAccel: 1,
        score: 8.5,
        originScore: 8,
        eligible: true,
      },
    });
  const etf = (originDate: string | null, entryState: "confirmed" | "pending" = "confirmed") =>
    row("069500", {
      market: "ETF",
      date,
      onset: true,
      exitReason: "MA60",
      etfEntry: {
        version: ETF_POLICY.version,
        originDate,
        confirmationDate: date,
        entryState,
        confirmationIssues: [],
        averageTradingValue20: 2e9,
        entryWeight: 0.1,
        dataStatus: "ready",
        krxReferenceDate: date,
      },
    });
  it.each(["KOSPI", "KOSDAQ", "ETF", "US"] as const)(
    "hides all pre-start actionable %s rows",
    (market) => {
      const oldDate = "2026-10-09";
      const result = marketSignals(
        source([row("OLD", { market, date: oldDate, onset: true, exitReason: "DOWN30" })], oldDate),
        market,
        [hold("OLD")],
        [],
        null,
        start,
      );
      expect(result).toMatchObject({
        onsets: [],
        pending: [],
        exits: [],
        onsetCount: 0,
        pendingCount: 0,
        exitCount: 0,
      });
    },
  );
  it.each([null, "2026-10-09", "2026-10-12-malformed", "2026-10-14"])(
    "does not import an unknown, old, or future KOSPI origin %s",
    (origin) => {
      for (const state of ["confirmed", "pending"] as const) {
        const result = marketSignals(source([kospi(origin, state)]), "KOSPI", [], [], null, start);
        expect(result.onsets).toEqual([]);
        expect(result.pending).toEqual([]);
      }
    },
  );
  it.each([null, "2026-10-09", "2026-10-12-malformed", "2026-10-14"])(
    "does not import an unknown, old, or future ETF origin %s",
    (origin) => {
      const result = marketSignals(source([etf(origin)]), "ETF", [], [], null, start);
      expect(result.onsets).toEqual([]);
    },
  );
  it("accepts new-origin entries and pending confirmations at the restart boundary", () => {
    expect(marketSignals(source([kospi(start)]), "KOSPI", [], [], null, start).onsetCount).toBe(1);
    expect(
      marketSignals(source([kospi(date, "pending")]), "KOSPI", [], [], null, start).pendingCount,
    ).toBe(1);
    expect(marketSignals(source([etf(start)]), "ETF", [], [], null, start).onsetCount).toBe(1);
    expect(
      marketSignals(source([etf(date, "pending")]), "ETF", [], [], null, start).pendingCount,
    ).toBe(1);
  });
  it("preserves new-held EXIT even when the current entry origin is pre-start", () => {
    const held = [hold("005930", 2, start)];
    const result = marketSignals(source([kospi("2026-10-09")]), "KOSPI", held, [], null, start);
    expect(result.onsetCount).toBe(0);
    expect(result.exitCount).toBe(1);
    expect(result.exits[0]?.symbol).toBe("005930");
  });
});

describe("actual lifecycle and independent entry-condition evidence", () => {
  const asOf = "2026-10-14";
  const source = (market: DashboardIndexRow["market"], signalDate = asOf) => ({
    date: signalDate,
    tradeDates: ["2026-10-12", "2026-10-13", signalDate],
    rows: [
      row("LIFE", {
        market,
        date: signalDate,
        onset: true,
        exitReason: market === "ETF" ? "MA60" : "DATA_UNAVAILABLE",
        ...(market === "KOSPI"
          ? {
              kospiEntry: {
                state: "confirmed",
                originDate: signalDate,
              } as DashboardIndexRow["kospiEntry"],
            }
          : {}),
        ...(market === "ETF"
          ? {
              etfEntry: {
                version: ETF_POLICY.version,
                entryState: "confirmed",
                originDate: signalDate,
                dataStatus: "ready",
              } as DashboardIndexRow["etfEntry"],
            }
          : {}),
      }),
    ],
  });
  it.each(["KOSPI", "KOSDAQ", "ETF", "US"] as const)(
    "keeps conditions while actual %s holdings and sales change actions",
    (market) => {
      const current = source(market);
      const evaluate = (
        positions: DashboardHolding[] | null,
        executions: Parameters<typeof marketSignals>[3] = [],
        input = current,
      ) => marketSignals(input, market, positions, executions, null, "2026-10-12");
      const unbought = evaluate([]);
      expect(unbought.conditionCount).toBe(1);
      expect(unbought.onsetCount).toBe(1);
      expect(unbought.conditions![0]!.actualState).toBe("READY");
      expect(evaluate([])).toEqual(unbought); // Re-reading is not a new signal or an order.
      const held = evaluate([hold("LIFE", 10, "2026-10-13")]);
      expect(held.conditionCount).toBe(1);
      expect(held.onsetCount).toBe(0);
      expect(held.conditions![0]).toMatchObject({ actualState: "HELD", actualQuantity: 10 });
      expect(held.exitCount).toBe(1);
      const sell = { symbol: "LIFE", market, date: asOf, side: "SELL" as const, shares: 4 };
      const partial = evaluate([hold("LIFE", 6, "2026-10-13")], [sell]);
      expect(partial.exits[0]).toMatchObject({ actualQuantity: 6, actualEntryDate: "2026-10-13" });
      const closed = evaluate([], [{ ...sell, shares: 10 }]);
      expect(closed.conditionCount).toBe(1);
      expect(closed.conditions![0]!.actualState).toBe("CONSUMED");
      expect(closed.onsetCount).toBe(0);
      expect(closed.exitCount).toBe(0);
      expect(evaluate([], [sell], source(market, "2026-10-15")).onsetCount).toBe(1);
      const unknown = evaluate(null);
      expect(unknown.conditionCount).toBe(1);
      expect(unknown.conditions![0]!.actualState).toBe("UNKNOWN");
      expect(unknown.onsetCount).toBeNull();
      expect(unknown.exitCount).toBeNull();
      expect(unknown.onsets).toEqual([]);
      const stale = { ...current, date: "2026-10-15" };
      expect(evaluate([], [], stale).conditionCount).toBe(0);
      expect(evaluate([hold("LIFE")], [], stale).exitCount).toBe(0);
    },
  );
});

describe("dashboard heading", () => {
  it("keeps the title and PDF export while omitting the requested subtitle", () => {
    const route = readFileSync(new URL("../src/routes/index.tsx", import.meta.url), "utf8");
    const header = route.slice(
      route.indexOf('<div className="mb-5'),
      route.indexOf("<PdfExportButton"),
    );
    expect(header).toContain("대시보드 · V8 Final</h1>");
    expect(header).not.toContain("<p ");
    expect(route).toContain('<PdfExportButton documentTitle="CloudTrend V8 Final 대시보드" />');
  });
});

describe("ETF current-data uncertainty on the dashboard", () => {
  const pendingSymbol = Object.keys(ETF_MAPPING).find((symbol) =>
    isEtfStrategyAssetClass(ETF_MAPPING[symbol]),
  )!;
  const session = "2024-04-15";
  function fixture() {
    const targets = Object.keys(ETF_MAPPING).filter(
      (symbol) => symbol !== pendingSymbol && isEtfStrategyAssetClass(ETF_MAPPING[symbol]),
    );
    const incomplete = new Set(targets.slice(0, 17));
    const previousMissing = new Set(targets.slice(17, 21));
    const symbols = [...Object.keys(ETF_MAPPING), "999999"];
    const rows = symbols.map((symbol) => {
      const missing = incomplete.has(symbol);
      const pending = symbol === pendingSymbol;
      return krRow(symbol, {
        instrument: {
          symbol,
          name: symbol,
          market: "KOSPI",
          instrumentType: "ETF",
          isLeveraged: false,
          isInverse: false,
        } as ScreeningRow["instrument"],
        snapshot: { tradeDate: session, close: 10000 } as ScreeningRow["snapshot"],
        etfStrategy: {
          version: ETF_POLICY.version,
          date: session,
          previousDate: "2024-04-12",
          eligible: !missing,
          score: missing ? null : pending ? 85 : 70,
          previousScore: previousMissing.has(symbol) ? null : pending ? 75 : 90,
          technical: missing ? null : 70,
          priority: 70,
          health: 70,
          environment: 70,
          environmentSource: "stock_sector",
          region: "KR",
          sector: "시장",
          annualVolatility: 0.2,
          entryWeight: 0.1,
          underlyingClose: 110,
          underlyingMa60: 100,
          onset: false,
          rawOnset: pending,
          entryState: missing ? "data_pending" : pending ? "pending" : "none",
          originDate: pending ? session : null,
          confirmationDate: null,
          confirmationIssues: [],
          averageTradingValue20: 2e9,
          dataStatus: missing ? "incomplete" : "ready",
          krxReferenceDate: session,
          exit: null,
          issues: missing ? ["기술점수 이력 부족"] : [],
        } as ScreeningRow["etfStrategy"],
      });
    });
    return { asOfDate: session, tradeDates: ["2024-04-12", session], rows } as AnalysisResult;
  }
  const evaluate = (value: DashboardIndex | null) =>
    marketSignals(value, "ETF", [], [], null, session);

  it("separates synthetic current-data 17 from raw-onset unknown 21 and confirmation 1", () => {
    const source = fixture();
    const before = structuredClone(source);
    const projected = projectKrDashboard(source);
    expect(projected.rows).toHaveLength(Object.keys(ETF_MAPPING).length + 1);
    expect(
      projected.rows.filter(
        (r) => r.etfAssessment?.isStrategyTarget && r.etfAssessment.rawOnset === null,
      ),
    ).toHaveLength(21);
    const result = evaluate(projected);
    expect(result.dataUnconfirmedCount).toBe(17);
    expect(result.pendingCount).toBe(1);
    expect(result.pending?.map((r) => r.symbol)).toEqual([pendingSymbol]);
    expect(result.onsetCount).toBe(0);
    expect(source).toEqual(before);
  });

  it("does not count non-target, leveraged, inverse or previous-score-only gaps", () => {
    const source = fixture();
    for (const r of source.rows) r.etfStrategy!.dataStatus = "ready";
    const target = source.rows.find((r) => r.instrument.symbol === "360750")!;
    target.etfStrategy!.dataStatus = "krx_batch_pending";
    expect(evaluate(projectKrDashboard(source)).dataUnconfirmedCount).toBe(1);
    target.instrument.isLeveraged = true;
    expect(evaluate(projectKrDashboard(source)).dataUnconfirmedCount).toBe(0);
    target.instrument.isLeveraged = false;
    target.instrument.isInverse = true;
    expect(evaluate(projectKrDashboard(source)).dataUnconfirmedCount).toBe(0);
    source.rows.at(-1)!.etfStrategy!.dataStatus = "incomplete";
    expect(evaluate(projectKrDashboard(source)).dataUnconfirmedCount).toBe(0);
  });

  it.each(["missing strategy", "stale strategy", "stale snapshot", "old policy"])(
    "leaves %s unconfirmed rather than inventing zero",
    (kind) => {
      const source = fixture();
      const r = source.rows[0]!;
      if (kind === "missing strategy") r.etfStrategy = undefined;
      if (kind === "stale strategy") r.etfStrategy!.date = "2024-04-12";
      if (kind === "stale snapshot") r.snapshot.tradeDate = "2024-04-12";
      if (kind === "old policy") r.etfStrategy!.version = "old";
      expect(evaluate(projectKrDashboard(source)).dataUnconfirmedCount).toBeNull();
    },
  );

  it("keeps absent, legacy, invalid and pre-start indexes unknown", () => {
    expect(evaluate(null).dataUnconfirmedCount).toBeNull();
    expect(evaluate({ date: session, rows: [], tradeDates: [] }).dataUnconfirmedCount).toBeNull();
    const projected = projectKrDashboard(fixture());
    const legacy = structuredClone(projected);
    delete legacy.rows[0]!.etfAssessment;
    expect(evaluate(legacy).dataUnconfirmedCount).toBeNull();
    for (const date of ["2024-04-12", "2026-02-30", "invalid"]) {
      expect(evaluate({ ...projected, date }).dataUnconfirmedCount).toBeNull();
    }
    // A valid session is not reinterpreted using UTC/KST wall-clock dates.
    expect(evaluate(projected).dataUnconfirmedCount).toBe(17);
  });
});
