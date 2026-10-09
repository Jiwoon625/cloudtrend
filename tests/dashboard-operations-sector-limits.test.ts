import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  dashboardSectorLimit,
  projectDashboardSectorContext,
} from "../src/lib/dashboardOperationsSectorLimits";
import {
  marketSignals,
  projectKrDashboard,
  type DashboardIndexRow,
} from "../src/lib/dashboardOperations";
import type { LedgerDocument } from "../src/lib/portfolioLedgers";
import type { PortfolioTrade } from "../src/lib/portfolioStoreCore";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import { STRATEGY_CONFIG } from "../src/lib/engine/operationalStrategy";

const date = "2026-10-01";
const createdAt = "2026-10-02T00:20:00.000Z";
const trade = (symbol: string, values: Partial<PortfolioTrade> = {}): PortfolioTrade =>
  ({
    symbol,
    name: symbol,
    market: "KOSDAQ",
    sectorCode: "SEMI",
    sectorName: "반도체",
    shares: 1,
    status: "OPEN",
    entryDate: "2026-09-01",
    exitDate: null,
    ...values,
  }) as PortfolioTrade;
const ledger = (trades: PortfolioTrade[], asOf = date): LedgerDocument =>
  ({
    settings: { maxPositions: 30, sectorCap: 0.3 },
    strategy: { trades, summary: { latestDate: asOf }, calculatedAt: "2026-10-02T00:30:00.000Z" },
    executions: [],
  }) as unknown as LedgerDocument;
const row = (values: Partial<DashboardIndexRow> = {}): DashboardIndexRow => ({
  symbol: "CANDIDATE",
  name: "후보",
  market: "KOSPI",
  sector: "반도체",
  sectorCode: "SEMI",
  date,
  score: 8.5,
  priority: 1,
  price: 10000,
  onset: true,
  exitReason: null,
  ...values,
});
const check = (doc: LedgerDocument | null, values: Partial<DashboardIndexRow> = {}) =>
  dashboardSectorLimit(row(values), projectDashboardSectorContext(doc, createdAt))!;

describe("Korean dashboard strategy-sector annotation", () => {
  it("combines both markets, applies candidate-market caps, and ignores persisted 30%", () => {
    const doc = ledger([
      ...Array.from({ length: 6 }, (_, i) => trade(`S${i}`)),
      trade("E1", { market: "KOSPI", sectorCode: "ENERGY" }),
      trade("E2", { market: "KOSPI", sectorCode: "ENERGY" }),
      trade("E3", { market: "KOSDAQ", sectorCode: "ENERGY" }),
    ]);
    expect(check(doc)).toMatchObject({
      status: "blocked",
      count: 6,
      limit: 3,
      cap: 0.1,
      asOfDate: date,
    });
    expect(check(doc, { market: "KOSDAQ" })).toMatchObject({
      status: "blocked",
      count: 6,
      limit: 6,
      cap: 0.2,
    });
    expect(check(doc, { sectorCode: "ENERGY" })).toMatchObject({
      status: "blocked",
      count: 3,
      limit: 3,
    });
    expect(check(doc, { market: "KOSDAQ", sectorCode: "ENERGY" })).toMatchObject({
      status: "room",
      count: 3,
      limit: 6,
    });
  });
  it("counts a different market's held sector even without same-market holdings", () => {
    expect(check(ledger([trade("PI", { market: "KOSPI" })]), { market: "KOSDAQ" }).count).toBe(1);
  });
  it("uses exact engine sector codes rather than names", () => {
    const doc = ledger([
      trade("A", { sectorName: "old name" }),
      trade("B", { sectorCode: "OTHER_CODE", sectorName: "반도체" }),
    ]);
    expect(check(doc).count).toBe(1);
    expect(check(doc, { sectorCode: "semi" }).count).toBe(0);
  });
  it("keeps real zero distinct from missing or incomplete data", () => {
    expect(check(ledger([]))).toMatchObject({ status: "room", count: 0, limit: 3 });
    expect(check(null)).toMatchObject({ status: "unknown", count: null, limit: null });
    const doc = ledger([]);
    doc.strategy = null;
    expect(check(doc)).toMatchObject({ status: "unknown", count: null, limit: 3 });
  });
  it.each([undefined, "", "-", "UNKNOWN", "ETC", "미분류"])(
    "fails closed for candidate sector %s",
    (sectorCode) => {
      expect(check(ledger([]), { sectorCode })).toMatchObject({
        status: "unknown",
        count: null,
        issue: "종목 섹터 미확인",
      });
    },
  );
  it("does not undercount if any held Korean sector or market is unknown", () => {
    expect(check(ledger([trade("A", { sectorCode: "" })]))).toMatchObject({
      status: "unknown",
      count: null,
    });
    expect(
      check(ledger([trade("A", { market: undefined } as unknown as Partial<PortfolioTrade>)])),
    ).toMatchObject({ status: "unknown", count: null });
  });
  it("ignores closed/zero-share trades, ETFs, and US positions", () => {
    const doc = ledger([
      trade("S"),
      trade("CLOSED", { status: "CLOSED" }),
      trade("ZERO", { shares: 0 }),
      trade("ETF", { market: "ETF" }),
      trade("US", { market: "US" } as unknown as Partial<PortfolioTrade>),
    ]);
    expect(check(doc).count).toBe(1);
    expect(check(doc, { market: "ETF" })).toBeUndefined();
    expect(check(doc, { market: "US" })).toBeUndefined();
  });
  it.each(["2026-09-30", "2026-10-02"])(
    "marks date mismatch %s unknown while retaining dated snapshot count",
    (asOf) => {
      expect(check(ledger([trade("A")], asOf))).toMatchObject({
        status: "unknown",
        count: 1,
        asOfDate: asOf,
        issue: "신호·장부 기준일 불일치",
      });
    },
  );
  it.each(["", "2026-02-30", "not-a-date"])("fails closed for invalid ledger date %s", (asOf) => {
    expect(check(ledger([], asOf))).toMatchObject({ status: "unknown", count: null });
  });
  it.each([0, -1, Number.NaN, 2.5])("rejects invalid position capacity %s", (maxPositions) => {
    const doc = ledger([]);
    doc.settings.maxPositions = maxPositions;
    expect(check(doc)).toMatchObject({ status: "unknown", limit: null });
  });
  it("reflects operational cap and portfolio-capacity changes, including engine floor/minimum", () => {
    const doc = ledger([]);
    doc.settings.maxPositions = 29;
    expect(check(doc).limit).toBe(2);
    expect(check(doc, { market: "KOSDAQ" }).limit).toBe(5);
    doc.settings.maxPositions = 1;
    expect(check(doc).limit).toBe(1);
    doc.settings.maxPositions = 30;
    const original = Object.getOwnPropertyDescriptor(STRATEGY_CONFIG.KOSPI, "sectorCap")!;
    Object.defineProperty(STRATEGY_CONFIG.KOSPI, "sectorCap", { value: 0.2, configurable: true });
    try {
      expect(check(doc).limit).toBe(6);
    } finally {
      Object.defineProperty(STRATEGY_CONFIG.KOSPI, "sectorCap", original);
    }
  });
  it("keeps pending exits occupied until the saved ledger actually closes them", () => {
    const doc = ledger(
      Array.from({ length: 3 }, (_, i) =>
        trade(`S${i}`, { exitSignalDate: date, currentStatus: "전략 청산 대기" }),
      ),
    );
    expect(check(doc)).toMatchObject({ status: "blocked", count: 3 });
  });
  it.each([
    { shares: Number.NaN },
    { shares: -1 },
    { entryDate: "2026-10-02" },
    { exitDate: "2026-10-02" },
  ])("fails closed for inconsistent active trades %j", (values) => {
    expect(check(ledger([trade("A", values)]))).toMatchObject({ status: "unknown", count: null });
  });
  it("fails closed for duplicate positions instead of inventing a count", () => {
    expect(check(ledger([trade("A"), trade("A")]))).toMatchObject({
      status: "unknown",
      count: null,
    });
  });
  it("attaches labels without consuming same-day slots or changing signals/order/counts", () => {
    const rows = [row(), row({ symbol: "B", priority: 2 })];
    const index = { date, rows, tradeDates: [date] };
    const context = projectDashboardSectorContext(ledger([trade("A")]), createdAt);
    const signals = marketSignals(index, "KOSPI", [], [], context);
    expect(signals.onsetCount).toBe(2);
    expect(signals.onsets.map((r) => r.symbol)).toEqual(["B", "CANDIDATE"]);
    expect(signals.onsets.map((r) => r.sectorLimit?.count)).toEqual([1, 1]);
    const blocked = marketSignals(
      index,
      "KOSPI",
      [],
      [],
      projectDashboardSectorContext(
        ledger(Array.from({ length: 3 }, (_, i) => trade(`A${i}`))),
        createdAt,
      ),
    );
    expect(blocked.onsetCount).toBe(2);
    expect(blocked.onsets.every((r) => r.sectorLimit?.status === "blocked")).toBe(true);
    expect(blocked.onsets[0]?.reason).toBe(signals.onsets[0]?.reason);
    expect(rows.every((r) => r.sectorLimit === undefined)).toBe(true);
  });
  it("annotates KOSPI pending confirmation without changing confirmation state", () => {
    const pending = row({
      onset: false,
      kospiEntry: { state: "pending" } as DashboardIndexRow["kospiEntry"],
    });
    const signals = marketSignals(
      { date, rows: [pending], tradeDates: [date] },
      "KOSPI",
      [],
      [],
      projectDashboardSectorContext(ledger([]), createdAt),
    );
    expect(signals.pendingCount).toBe(1);
    expect(signals.pending?.[0]).toMatchObject({
      reason: "8.0 원신호 · 다음 거래일 종가 확인 대기",
      sectorLimit: { count: 0, limit: 3 },
    });
    expect(signals.onsetCount).toBe(0);
  });
  it("copies canonical sectorCode into projection without using name-based taxonomy", () => {
    const projected = projectKrDashboard({
      asOfDate: date,
      tradeDates: [date],
      rows: [
        {
          instrument: {
            symbol: "A",
            market: "KOSDAQ",
            instrumentType: "STOCK",
            sectorCode: "EXACT",
            sectorName: "반도체",
          },
          snapshot: { tradeDate: date },
          priority: { points: 1 },
        },
      ],
    } as AnalysisResult);
    expect(projected.rows[0]?.sectorCode).toBe("EXACT");
  });
  it.each([undefined, "invalid", "2026-10-02T00:10:00.000Z"])(
    "fails closed for missing/invalid/older same-day ledger generation %s",
    (calculatedAt) => {
      const doc = ledger([]);
      doc.strategy!.calculatedAt = calculatedAt as string;
      const label = dashboardSectorLimit(row(), projectDashboardSectorContext(doc, createdAt));
      expect(label).toMatchObject({ status: "unknown", count: 0, limit: 3 });
    },
  );
  it("fails closed when screening generation is missing and accepts equal generation", () => {
    const doc = ledger([]);
    expect(dashboardSectorLimit(row(), projectDashboardSectorContext(doc))).toMatchObject({
      status: "unknown",
      count: 0,
    });
    doc.strategy!.calculatedAt = createdAt;
    expect(check(doc).status).toBe("room");
  });
  it("never calls strategy replay/mutation and versions old sector-less sidecars out", () => {
    const source = readFileSync(
      new URL("../src/lib/dashboardOperations.server.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("dashboard-operations-partial-evidence-v6");
    expect(source).toContain("projectDashboardSectorContext(krDoc, kr?.screeningCreatedAt)");
    expect(source).not.toMatch(/operateLedgers|simulateStrategy|refreshStrategy/);
  });
});
