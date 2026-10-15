import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDashboardOperations } from "../src/lib/dashboardOperations.server";
import { DASHBOARD_CACHE_VERSION } from "../src/lib/screeningCacheContract";
import { projectNewActualPool, type NewActualPosition } from "../src/lib/newActualPortfolio";
const mock = vi.hoisted(() => ({
  run: 0,
  exit: {} as NonNullable<NewActualPosition["priceExit"]>,
  screeningExit: true,
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: `price-exit-${mock.run}` } }, error: null }),
    },
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
    const value = path.endsWith("dashboard/latest.json")
      ? { version: DASHBOARD_CACHE_VERSION, resultDigest: "screen" }
      : path.endsWith("dashboard-operations/kr-v1.json")
        ? {
            key: `price-exit-${mock.run}:kr:dashboard-operations-partial-evidence-v6:screen`,
            index: {
              date: "2026-10-14",
              tradeDates: ["2026-10-14"],
              rows: [
                {
                  symbol: "ABC",
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
      symbol: "ABC",
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
            symbol: "ABC",
            name: "Synthetic ETF",
            market: "ETF",
            shares: 10,
            firstEntryDate: "2026-10-12",
          },
        ],
        actualExecutions: [],
        actualPools: { KRW: krw, USD: pool("USD") },
        heldSymbols: ["ABC"],
        lastSellDateBySymbol: {},
      },
    };
  },
}));
beforeEach(() => {
  mock.run++;
  mock.screeningExit = true;
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
});
