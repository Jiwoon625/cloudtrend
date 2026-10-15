import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NewActualPool } from "./newActualPortfolio";
const mock = vi.hoisted(() => ({
  bars: [] as { tradeDate: string; close: number }[],
  hash: 0,
  unavailable: false,
}));
vi.mock("./screeningSources.server", () => ({
  listActiveSources: async () => [{ id: "source", file_hash: String(mock.hash) }],
}));
vi.mock("./portfolioLedgers.server", () => ({
  priceInputs: async () => {
    if (mock.unavailable) throw new Error("offline");
    return { bars: { ABC: mock.bars }, marketDates: mock.bars.map((b) => b.tradeDate) };
  },
}));
import { attachActualHoldingPriceExits } from "./actualHoldingPriceExit.server";
function fixture(market: "ETF" | "KOSPI" = "ETF") {
  const files = new Map<string, string>();
  const client = {
    storage: {
      from: () => ({
        list: async (dir: string) => ({
          data: [...files.keys()]
            .filter((k) => k.startsWith(`${dir}/`))
            .sort()
            .reverse()
            .slice(0, 1)
            .map((k) => ({ name: k.split("/").at(-1)! })),
          error: null,
        }),
        download: async (path: string) => ({ data: new Blob([files.get(path)!]), error: null }),
        upload: async (path: string, content: string) => {
          if (!files.has(path)) files.set(path, content);
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  const pool = {
    positions: [{ symbol: "ABC", market, quantity: "10", cost: "1001.5" }],
    trades: [
      {
        execution: { id: "buy-1", symbol: "ABC", market, side: "BUY", date: "2026-10-14" },
        allocation: { quantity: 10, gross: 1000, fee: 1.5 },
      },
    ],
  } as unknown as NewActualPool;
  return { client, pool, files };
}
beforeEach(() => {
  mock.hash++;
  mock.unavailable = false;
  mock.bars = [
    { tradeDate: "2026-10-14", close: 120 },
    { tradeDate: "2026-10-15", close: 108 },
  ];
});
describe("actual holding exit evidence", () => {
  it("persists the first E4 signal independently of ledger trades and retains it during source outages", async () => {
    const { client, pool, files } = fixture();
    const originalTrades = JSON.stringify(pool.trades);
    await attachActualHoldingPriceExits(client, "owner-a", pool, "2026-10-15T07:00:00Z");
    expect(pool.positions[0]!.priceExit).toMatchObject({
      reason: "E4",
      threshold: "108",
      signalDate: "2026-10-15",
    });
    expect(files.size).toBe(1);
    mock.hash++;
    mock.unavailable = true;
    await attachActualHoldingPriceExits(client, "owner-a", pool, "2026-10-16T07:00:00Z");
    expect(pool.positions[0]!.priceExit?.reason).toBe("E4");
    expect(JSON.stringify(pool.trades)).toBe(originalTrades);
  });
  it("does not interpret an intraday quote as today's closing signal", async () => {
    const { client, pool } = fixture();
    await attachActualHoldingPriceExits(client, "owner-b", pool, "2026-10-15T03:00:00Z");
    expect(pool.positions[0]!.priceExit?.reason).toBeNull();
  });
  it("preserves the historical peak when the collector drops the original entry day", async () => {
    const { client, pool } = fixture();
    mock.bars[1]!.close = 119;
    await attachActualHoldingPriceExits(client, "owner-c", pool, "2026-10-15T07:00:00Z");
    mock.hash++;
    mock.bars = [
      { tradeDate: "2026-10-15", close: 119 },
      { tradeDate: "2026-10-16", close: 108 },
    ];
    await attachActualHoldingPriceExits(client, "owner-c", pool, "2026-10-16T07:00:00Z");
    expect(pool.positions[0]!.priceExit).toMatchObject({
      reason: "E4",
      threshold: "108",
      peak: "120",
    });
  });
  it("does not reset a peak after a source-price revision or fabricate a multi-buy convention", async () => {
    const { client, pool } = fixture();
    mock.bars[1]!.close = 119;
    await attachActualHoldingPriceExits(client, "owner-d", pool, "2026-10-15T07:00:00Z");
    mock.hash++;
    mock.bars[1]!.close = 60;
    mock.bars.push({ tradeDate: "2026-10-16", close: 50 });
    await attachActualHoldingPriceExits(client, "owner-d", pool, "2026-10-16T07:00:00Z");
    expect(pool.positions[0]!.priceExit?.status).toContain("확인 대기");
    pool.trades.push(structuredClone(pool.trades[0]!));
    mock.hash++;
    await attachActualHoldingPriceExits(client, "owner-d", pool, "2026-10-16T07:00:00Z");
    expect(pool.positions[0]!.priceExit?.reason).toBeNull();
  });
  it("evaluates ETF peak stops by actual acquisition lot after multiple buys, retaining full-symbol liquidation", async () => {
    const { client, pool } = fixture("ETF");
    pool.positions[0]!.quantity = "20";
    pool.positions[0]!.cost = "2103.15";
    pool.trades.push({
      execution: { id: "buy-2", symbol: "ABC", market: "ETF", side: "BUY", date: "2026-10-15" },
      allocation: { quantity: 10, gross: 1100, fee: 1.65 },
    } as NewActualPool["trades"][number]);
    await attachActualHoldingPriceExits(client, "owner-multi-etf", pool, "2026-10-15T07:00:00Z");
    expect(pool.positions[0]!.priceExit).toMatchObject({
      reason: "E4",
      threshold: "108",
      peak: "120",
      lotCount: 2,
      basisMethod: "WEIGHTED_COST_LOT_PEAKS",
      auditStatus: "VERIFIED",
      observationDate: "2026-10-15",
    });
    expect(pool.trades).toHaveLength(2);
  });
  it("uses the actual pooled cost for K4 after a second buy, without using just the first fill", async () => {
    const { client, pool } = fixture("KOSPI");
    pool.positions[0]!.quantity = "20";
    pool.positions[0]!.cost = "2103.15";
    pool.trades.push({
      execution: { id: "buy-2", symbol: "ABC", market: "KOSPI", side: "BUY", date: "2026-10-15" },
      allocation: { quantity: 10, gross: 1100, fee: 1.65 },
    } as NewActualPool["trades"][number]);
    mock.bars[1]!.close = 96;
    await attachActualHoldingPriceExits(client, "owner-multi-kospi", pool, "2026-10-15T07:00:00Z");
    expect(pool.positions[0]!.priceExit).toMatchObject({
      reason: "K4",
      threshold: "96.7449",
      lotCount: 2,
      auditStatus: "VERIFIED",
    });
  });
  it("reconciles partial sales to exact remaining quantity and fee-inclusive cost", async () => {
    const { client, pool } = fixture("ETF");
    pool.positions[0]!.quantity = "15";
    pool.positions[0]!.cost = "1577.3625";
    pool.trades.push({
      execution: { id: "buy-2", symbol: "ABC", market: "ETF", side: "BUY", date: "2026-10-14" },
      allocation: { quantity: 10, gross: 1100, fee: 1.65 },
    } as NewActualPool["trades"][number]);
    pool.trades.push({
      execution: { id: "sell-1", symbol: "ABC", market: "ETF", side: "SELL", date: "2026-10-15" },
      allocation: { quantity: 5, gross: 550, fee: 0.825 },
    } as NewActualPool["trades"][number]);
    await attachActualHoldingPriceExits(client, "owner-partial", pool, "2026-10-15T07:00:00Z");
    expect(pool.positions[0]!.priceExit).toMatchObject({
      reason: "E4", threshold: "108", lotCount: 2, auditStatus: "VERIFIED",
    });
  });
  it("fails the confirmed-close audit when the actual projection mark disagrees with the source", async () => {
    const { client, pool } = fixture("ETF");
    pool.issues = [];
    pool.positions[0]!.priceDate = "2026-10-15";
    pool.positions[0]!.currentPrice = "107";
    await attachActualHoldingPriceExits(client, "owner-mismatch", pool, "2026-10-15T07:00:00Z");
    expect(pool.positions[0]!.priceExit?.auditStatus).toBe("MISMATCH");
    expect(pool.positions[0]!.priceExit?.reason).toBeNull();
    expect(pool.issues).toContain("price_exit_mark_mismatch:ABC");
  });

});
