import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDashboardOperations } from "../src/lib/dashboardOperations.server";
import {
  DASHBOARD_CACHE_VERSION,
  SCREENING_CACHE_VERSION,
} from "../src/lib/screeningCacheContract";
import { ETF_POLICY } from "../src/lib/engine/etfStrategy";
import type { ScreeningRow } from "../src/lib/engine/pipeline";
import { etfOperationalDisplay } from "../src/lib/etfOperationalDisplay";
import { projectNewActualPool, type NewActualPosition } from "../src/lib/newActualPortfolio";
const mock = vi.hoisted(() => ({
  run: 0,
  exit: {} as NonNullable<NewActualPosition["priceExit"]>,
  screeningExit: true,
  symbol: "ABC",
  fullProjection: false,
  fullReads: 0,
  dataStatus: "incomplete" as "incomplete" | "krx_batch_pending",
}));
function cashEtfRow(): ScreeningRow {
  return {
    instrument: {
      symbol: mock.symbol,
      name: "Synthetic cash ETF",
      market: "ETF",
      instrumentType: "ETF",
      sectorCode: "BOND_CASH",
    },
    snapshot: { tradeDate: "2026-10-15", close: 107 },
    etfStrategy: {
      version: ETF_POLICY.version,
      date: "2026-10-15",
      previousDate: "2026-10-14",
      dataStatus: mock.dataStatus,
      score: null,
      eligible: false,
      onset: false,
      rawOnset: false,
      entryState: "none",
      exit: mock.dataStatus === "krx_batch_pending" ? null : "DATA_UNAVAILABLE",
      underlyingClose: null,
      underlyingMa60: null,
      issues: ["주식형·커버드콜 ETF 전략 대상 아님", "기초지수 MA60·추세 이력 부족"],
    },
  } as ScreeningRow;
}
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: `price-exit-${mock.run}` } }, error: null }),
    },
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));
vi.mock("../src/lib/actualHoldingPriceExit.server", () => ({
  attachActualHoldingPriceExits: vi.fn(),
}));
vi.mock("../src/lib/dashboardActualAllocation.server", () => ({
  projectDashboardActualAllocation: async () => null,
}));
vi.mock("../src/lib/freshStorage", () => ({
  downloadFreshObject: async (_client: unknown, _bucket: string, path: string) => {
    if (mock.fullProjection && path.endsWith("screening/latest.json")) {
      mock.fullReads++;
      return {
        data: new Blob([
          JSON.stringify({
            version: SCREENING_CACHE_VERSION,
            resultDigest: "screen",
            payload: {
              analysis: {
                asOfDate: "2026-10-15",
                tradeDates: ["2026-10-14", "2026-10-15"],
                rows: [cashEtfRow()],
              },
            },
          }),
        ]),
        error: null,
      };
    }
    const value = path.endsWith("dashboard/latest.json")
      ? { version: DASHBOARD_CACHE_VERSION, resultDigest: "screen" }
      : path.endsWith("dashboard-operations/kr-v1.json") && !mock.fullProjection
        ? {
            key: `price-exit-${mock.run}:kr:dashboard-operations-exit-diagnostics-v7:screen`,
            index: {
              date: "2026-10-14",
              tradeDates: ["2026-10-14"],
              rows: [
                {
                  symbol: mock.symbol,
                  name: "Synthetic ETF",
                  market: "ETF",
                  sector: "-",
                  date: "2026-10-14",
                  price: 120,
                  score: null,
                  priority: 0,
                  onset: false,
                  exitReason: mock.screeningExit ? "MA60" : null,
                },
              ],
            },
          }
        : null;
    return { data: value ? new Blob([JSON.stringify(value)]) : null, error: null };
  },
}));
vi.mock("../src/lib/websitePositionContext.server", () => ({
  loadActualPositionSnapshotForOwner: async () => {
    const pool = (currency: "KRW" | "USD") =>
      projectNewActualPool({
        currency,
        executions: [],
        quotes: {},
        valuationDate: null,
        today: "2026-10-15",
      });
    const krw = pool("KRW");
    krw.positions.push({
      symbol: mock.symbol,
      name: "Synthetic ETF",
      market: "ETF",
      asset: "ETF",
      quantity: "10",
      cost: "1001.5",
      priceExit: mock.exit,
    } as NewActualPosition);
    return {
      context: {
        positions: [
          {
            symbol: mock.symbol,
            name: "Synthetic ETF",
            market: "ETF",
            shares: 10,
            firstEntryDate: "2026-10-12",
          },
        ],
        actualExecutions: [],
        actualPools: { KRW: krw, USD: pool("USD") },
        heldSymbols: [mock.symbol],
        lastSellDateBySymbol: {},
      },
    };
  },
}));
beforeEach(() => {
  mock.run++;
  mock.screeningExit = true;
  mock.symbol = "ABC";
  mock.fullProjection = false;
  mock.fullReads = 0;
  mock.dataStatus = "incomplete";
  mock.exit = {
    policyVersion: "holding-price-exit-k4-e4-v1",
    status: "청산 대기 · 다음 거래 가능 시가",
    reason: "E4",
    signalDate: "2026-10-15",
    threshold: "108",
    peak: "120",
    observedClose: "107",
    observationDate: "2026-10-15",
    auditStatus: "VERIFIED",
  };
});
describe("dashboard actual price-exit evidence", () => {
  it("merges one sale with the actual signal date/price, preserving the older screen reason and date", async () => {
    const result = await loadDashboardOperations("synthetic-valid-session-token");
    const group = result.markets.find((m) => m.market === "ETF")!;
    expect(group.exits).toHaveLength(1);
    expect(group.exitCount).toBe(1);
    expect(group.exits[0]).toMatchObject({
      date: "2026-10-15",
      price: 107,
      actualQuantity: 10,
      held: true,
    });
    expect(group.exits[0]!.reason).toContain("E4 · 2026-10-15");
    expect(group.exits[0]!.reason).toContain("MA60");
    expect(group.exits[0]!.reason).toContain("2026-10-14");
  });
  it.each(["PENDING", "MISMATCH", undefined] as const)(
    "does not publish a %s holding exit",
    async (auditStatus) => {
      if (auditStatus) mock.exit.auditStatus = auditStatus;
      else delete mock.exit.auditStatus;
      mock.screeningExit = false;
      const result = await loadDashboardOperations("synthetic-valid-session-token");
      expect(result.markets.find((m) => m.market === "ETF")!.exits).toEqual([]);
    },
  );
  it("keeps an independently verified MA60 reason when a price exit is pending", async () => {
    mock.exit.auditStatus = "PENDING";
    const result = await loadDashboardOperations("synthetic-valid-session-token");
    const exits = result.markets.find((m) => m.market === "ETF")!.exits;
    expect(exits).toHaveLength(1);
    expect(exits[0]!.reason).not.toContain("E4");
    expect(exits[0]!.date).toBe("2026-10-14");
  });

  it.each([
    ["incomplete", "VERIFIED"],
    ["incomplete", "LATCHED"],
    ["krx_batch_pending", "VERIFIED"],
    ["krx_batch_pending", "LATCHED"],
  ] as const)(
    "retains a %s cash ETF's %s actual E4 without promoting missing data",
    async (dataStatus, auditStatus) => {
      mock.symbol = "0046A0";
      mock.fullProjection = true;
      mock.dataStatus = dataStatus;
      mock.exit.auditStatus = auditStatus;

      const result = await loadDashboardOperations("synthetic-valid-session-token");
      const group = result.markets.find((market) => market.market === "ETF")!;

      expect(mock.fullReads).toBe(1);
      expect(group.exitCount).toBe(1);
      expect(group.exits).toHaveLength(1);
      expect(group.exits[0]).toMatchObject({
        symbol: "0046A0",
        date: "2026-10-15",
        price: 107,
        score: null,
        actualQuantity: 10,
        held: true,
      });
      expect(group.exits[0]!.reason).toContain("E4 · 2026-10-15");
      expect(group.exits[0]!.reason).not.toMatch(/DATA_UNAVAILABLE|데이터 오류|청산 점검|MA60/);
      expect(group.onsetCount).toBe(0);
      expect(group.assessments?.[0]?.etfAssessment).toMatchObject({
        current: true,
        krxPending: dataStatus === "krx_batch_pending",
        isStrategyTarget: false,
        score: null,
        underlyingJudgment: "unconfirmed",
      });
      expect(etfOperationalDisplay(cashEtfRow(), "2026-10-15", true, false, mock.exit)).toBe(
        "E4 · 2026-10-15 종가 신호 · 다음 거래 가능 시가 청산 대기",
      );
    },
  );

  it.each([
    ["incomplete", "PENDING"],
    ["incomplete", "MISMATCH"],
    ["incomplete", undefined],
    ["krx_batch_pending", "PENDING"],
    ["krx_batch_pending", "MISMATCH"],
    ["krx_batch_pending", undefined],
  ] as const)(
    "does not turn %s cash ETF data or %s price-exit evidence into an EXIT",
    async (dataStatus, auditStatus) => {
      mock.symbol = "0046A0";
      mock.fullProjection = true;
      mock.dataStatus = dataStatus;
      if (auditStatus) mock.exit.auditStatus = auditStatus;
      else delete mock.exit.auditStatus;

      const result = await loadDashboardOperations("synthetic-valid-session-token");
      const group = result.markets.find((market) => market.market === "ETF")!;

      expect(mock.fullReads).toBe(1);
      expect(group.exitCount).toBe(0);
      expect(group.exits).toEqual([]);
      expect(group.onsetCount).toBe(0);
      expect(group.assessments?.[0]).toMatchObject({
        symbol: "0046A0",
        held: true,
        exitReason: null,
        etfAssessment: {
          current: true,
          krxPending: dataStatus === "krx_batch_pending",
          isStrategyTarget: false,
          score: null,
          underlyingJudgment: "unconfirmed",
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/DATA_UNAVAILABLE|데이터 오류|청산 점검/);
      const display = etfOperationalDisplay(cashEtfRow(), "2026-10-15", true, false, mock.exit);
      expect(display).toContain(dataStatus === "krx_batch_pending" ? "KRX 자료 대기" : "확인 대기");
      expect(display).not.toMatch(/E4 ·|다음 거래 가능 시가|청산 점검/);
    },
  );
});
