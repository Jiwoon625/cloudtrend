import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NewActualPool } from "./newActualPortfolio";
const mock = vi.hoisted(() => ({
  bars: [] as { tradeDate: string; close: number }[],
  marketDates: null as string[] | null,
  hash: 0,
  unavailable: false,
}));
vi.mock("./screeningSources.server", () => ({
  listActiveSources: async () => [{ id: "source", file_hash: String(mock.hash) }],
}));
vi.mock("./portfolioLedgers.server", () => ({
  getCachedActualPriceInputs: async () => {
    if (mock.unavailable) throw new Error("offline");
    return {
      bars: { ABC: mock.bars },
      marketDates: mock.marketDates ?? mock.bars.map((b) => b.tradeDate),
    };
  },
}));
import { attachActualHoldingPriceExits } from "./actualHoldingPriceExit.server";
function fixture(market: "ETF" | "KOSPI" = "ETF") {
  const storage = {
    uploadFailure: "" as
      | ""
      | "returned"
      | "thrown"
      | "duplicate"
      | "duplicate-read"
      | "duplicate-match"
      | "duplicate-mismatch",
    downloads: 0,
  };
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
        download: async (path: string) => {
          storage.downloads++;
          if (storage.uploadFailure === "duplicate-read") throw new Error("read unavailable");
          return { data: files.has(path) ? new Blob([files.get(path)!]) : null, error: null };
        },
        upload: async (path: string, content: string) => {
          if (storage.uploadFailure === "thrown") throw new Error("write unavailable");
          if (storage.uploadFailure === "returned")
            return { error: { message: "write unavailable" } };
          if (storage.uploadFailure === "duplicate-match") files.set(path, content);
          if (storage.uploadFailure === "duplicate-mismatch")
            files.set(path, "different existing content");
          if (storage.uploadFailure.startsWith("duplicate"))
            return { error: { message: "already exists" } };
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
  return { client, pool, files, storage };
}
beforeEach(() => {
  mock.hash++;
  mock.unavailable = false;
  mock.marketDates = null;
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
      reason: "E4",
      threshold: "108",
      lotCount: 2,
      auditStatus: "VERIFIED",
    });
  });
  it("does not backdate a K4 stop using a later, more expensive acquisition", async () => {
    const { client, pool } = fixture("KOSPI");
    pool.positions[0]!.quantity = "20";
    pool.positions[0]!.cost = "3004.5";
    pool.trades.push({
      execution: {
        id: "later-buy",
        symbol: "ABC",
        market: "KOSPI",
        side: "BUY",
        date: "2026-10-16",
      },
      allocation: { quantity: 10, gross: 2000, fee: 3 },
    } as NewActualPool["trades"][number]);
    mock.bars = [
      { tradeDate: "2026-10-14", close: 100 },
      { tradeDate: "2026-10-15", close: 95 },
      { tradeDate: "2026-10-16", close: 150 },
    ];
    await attachActualHoldingPriceExits(client, "owner-asof-higher", pool, "2026-10-16T07:00:00Z");
    expect(pool.positions[0]!.priceExit).toMatchObject({
      reason: null,
      threshold: "138.207",
      auditStatus: "VERIFIED",
      observationDate: "2026-10-16",
    });
  });
  it("does not erase an earlier valid K4 crossing with a later cheaper acquisition", async () => {
    const { client, pool } = fixture("KOSPI");
    pool.positions[0]!.quantity = "20";
    pool.positions[0]!.cost = "1802.7";
    pool.trades.push({
      execution: {
        id: "later-cheap-buy",
        symbol: "ABC",
        market: "KOSPI",
        side: "BUY",
        date: "2026-10-16",
      },
      allocation: { quantity: 10, gross: 800, fee: 1.2 },
    } as NewActualPool["trades"][number]);
    mock.bars = [
      { tradeDate: "2026-10-14", close: 100 },
      { tradeDate: "2026-10-15", close: 90 },
      { tradeDate: "2026-10-16", close: 100 },
    ];
    await attachActualHoldingPriceExits(client, "owner-asof-cheaper", pool, "2026-10-16T07:00:00Z");
    expect(pool.positions[0]!.priceExit).toMatchObject({
      reason: "K4",
      signalDate: "2026-10-15",
      threshold: "92.138",
      auditStatus: "VERIFIED",
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

describe("actual exit fail-closed publication and evidence", () => {
  it.each(["returned", "thrown", "duplicate", "duplicate-read"] as const)(
    "never publishes an unsaved signal after %s storage failure, including cache reuse",
    async (failure) => {
      const { client, pool, files, storage } = fixture();
      pool.issues = ["unrelated_issue"];
      storage.uploadFailure = failure;
      const originalTrades = JSON.stringify(pool.trades);
      await attachActualHoldingPriceExits(
        client,
        `failure-${failure}`,
        pool,
        "2026-10-15T07:00:00Z",
      );
      expect(pool.positions[0]!.priceExit).toMatchObject({ reason: null, signalDate: null });
      expect(pool.positions[0]!.priceExit?.status).toContain("확인 대기");
      expect(pool.positions[0]!.priceExit?.status).not.toMatch(/청산 대기|다음 거래/);
      expect(pool.positions[0]!.priceExit?.auditStatus).not.toBe("VERIFIED");
      expect(files.size).toBe(0);
      const issues = [...pool.issues];
      const freshPool = structuredClone(pool);
      freshPool.issues = ["fresh_unrelated_issue"];
      await attachActualHoldingPriceExits(
        client,
        `failure-${failure}`,
        freshPool,
        "2026-10-15T07:00:00Z",
      );
      expect(freshPool.positions[0]!.priceExit).toMatchObject({ reason: null, signalDate: null });
      expect(freshPool.issues).toEqual(
        expect.arrayContaining(issues.filter((i) => i.startsWith("price_exit_"))),
      );
      expect(freshPool.issues).toContain("fresh_unrelated_issue");
      expect(freshPool.issues).not.toContain("unrelated_issue");
      expect(JSON.stringify(pool.trades)).toBe(originalTrades);
    },
  );
  it.each(["duplicate-match", "duplicate-mismatch"] as const)(
    "verifies %s content before publishing",
    async (failure) => {
      const { client, pool, files, storage } = fixture();
      storage.uploadFailure = failure;
      await attachActualHoldingPriceExits(client, `race-${failure}`, pool, "2026-10-15T07:00:00Z");
      expect(storage.downloads).toBe(1);
      expect(files.size).toBe(1);
      if (failure === "duplicate-match") {
        expect(pool.positions[0]!.priceExit).toMatchObject({
          reason: "E4",
          auditStatus: "VERIFIED",
        });
      } else {
        expect(pool.positions[0]!.priceExit).toMatchObject({
          reason: null,
          signalDate: null,
          auditStatus: "MISMATCH",
        });
        expect([...files.values()]).toEqual(["different existing content"]);
      }
    },
  );
  it("can confirm a previously failed immutable write after the short cache expires", async () => {
    const { client, pool, files, storage } = fixture();
    storage.uploadFailure = "returned";
    await attachActualHoldingPriceExits(client, "retry-write", pool, "2026-10-15T07:00:00Z");
    storage.uploadFailure = "";
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
    try {
      await attachActualHoldingPriceExits(client, "retry-write", pool, "2026-10-15T07:00:00Z");
      expect(pool.positions[0]!.priceExit).toMatchObject({ reason: "E4", auditStatus: "VERIFIED" });
      expect(files.size).toBe(1);
      expect(pool.trades).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });
  it("does not revive a closed holding cycle's saved signal after re-entry", async () => {
    const { client, pool, files } = fixture();
    await attachActualHoldingPriceExits(client, "new-cycle", pool, "2026-10-15T07:00:00Z");
    const originalSignal = [...files.entries()][0]!;
    pool.trades.push({
      execution: { id: "sell-all", symbol: "ABC", market: "ETF", side: "SELL", date: "2026-10-15" },
      allocation: { quantity: 10, gross: 1080, fee: 1.62 },
    } as NewActualPool["trades"][number]);
    pool.trades.push({
      execution: { id: "new-buy", symbol: "ABC", market: "ETF", side: "BUY", date: "2026-10-16" },
      allocation: { quantity: 10, gross: 1000, fee: 1.5 },
    } as NewActualPool["trades"][number]);
    mock.hash++;
    mock.bars.push({ tradeDate: "2026-10-16", close: 105 });
    await attachActualHoldingPriceExits(client, "new-cycle", pool, "2026-10-16T07:00:00Z");
    expect(pool.positions[0]!.priceExit).toMatchObject({
      reason: null,
      signalDate: null,
      auditStatus: "VERIFIED",
      lotCount: 1,
    });
    expect(files.get(originalSignal[0])).toBe(originalSignal[1]);
  });
  it("restores diagnostic issues on a cache hit without duplicates", async () => {
    const { client, pool } = fixture();
    pool.issues = [];
    pool.positions[0]!.currentPrice = "107";
    pool.positions[0]!.priceDate = "2026-10-15";
    await attachActualHoldingPriceExits(client, "cached-issues", pool, "2026-10-15T07:00:00Z");
    const again = structuredClone(pool);
    again.issues = ["unrelated"];
    await attachActualHoldingPriceExits(client, "cached-issues", again, "2026-10-15T07:00:00Z");
    await attachActualHoldingPriceExits(client, "cached-issues", again, "2026-10-15T07:00:00Z");
    expect(again.issues).toEqual(["unrelated", "price_exit_mark_mismatch:ABC"]);
  });
  it("rehydrates the exact first signal evidence when the source is unavailable", async () => {
    const { client, pool } = fixture();
    await attachActualHoldingPriceExits(client, "saved-evidence", pool, "2026-10-15T07:00:00Z");
    mock.hash++;
    mock.unavailable = true;
    await attachActualHoldingPriceExits(client, "saved-evidence", pool, "2026-10-16T07:00:00Z");
    expect(pool.positions[0]!.priceExit).toMatchObject({
      reason: "E4",
      signalDate: "2026-10-15",
      threshold: "108",
      observedClose: "108.00000000",
      observationDate: "2026-10-15",
      distancePercent: "0",
      auditStatus: "LATCHED",
      lotCount: 1,
      basisMethod: "SINGLE_FILL",
    });
    expect(pool.positions[0]!.priceExit?.priceSource).toBeTruthy();
  });
  it.each(["source", "mark"] as const)(
    "audits %s changes before reusing a saved signal",
    async (change) => {
      const { client, pool, files } = fixture();
      pool.issues = [];
      pool.positions[0]!.priceDate = "2026-10-15";
      pool.positions[0]!.currentPrice = "108";
      await attachActualHoldingPriceExits(client, "saved-audit", pool, "2026-10-15T07:00:00Z");
      const originalFiles = [...files];
      if (change === "source") {
        mock.hash++;
        mock.bars[1]!.close = 109;
      } else pool.positions[0]!.currentPrice = "107";
      await attachActualHoldingPriceExits(client, "saved-audit", pool, "2026-10-15T07:00:00Z");
      expect(pool.positions[0]!.priceExit).toMatchObject({
        auditStatus: "MISMATCH",
        reason: null,
        signalDate: null,
      });
      expect(pool.issues).toContain(`price_exit_${change}_mismatch:ABC`);
      expect([...files]).toEqual(originalFiles);
    },
  );
  it("blocks a latched signal when a loaded source loses its saved overlap", async () => {
    const { client, pool, files } = fixture();
    await attachActualHoldingPriceExits(client, "missing-overlap", pool, "2026-10-15T07:00:00Z");
    const before = [...files];
    mock.hash++;
    mock.bars = [{ tradeDate: "2026-10-16", close: 110 }];
    await attachActualHoldingPriceExits(client, "missing-overlap", pool, "2026-10-16T07:00:00Z");
    expect(pool.positions[0]!.priceExit).toMatchObject({
      reason: null,
      signalDate: null,
      auditStatus: "MISMATCH",
    });
    expect([...files]).toEqual(before);
  });
  it.each(["ETF", "KOSPI"] as const)(
    "shows the trigger bar rather than rebound close during %s catch-up",
    async (market) => {
      const { client, pool } = fixture(market);
      mock.bars = [
        { tradeDate: "2026-10-14", close: 120 },
        { tradeDate: "2026-10-15", close: 90 },
        { tradeDate: "2026-10-16", close: 125 },
      ];
      await attachActualHoldingPriceExits(
        client,
        `catchup-${market}`,
        pool,
        "2026-10-16T07:00:00Z",
      );
      expect(pool.positions[0]!.priceExit).toMatchObject({
        signalDate: "2026-10-15",
        observationDate: "2026-10-15",
        observedClose: "90.00000000",
        threshold: market === "ETF" ? "108" : "92.138",
      });
      expect(Number(pool.positions[0]!.priceExit?.distancePercent)).toBeLessThan(0);
    },
  );
});

// Regression cases found during independent adversarial review.
describe("independent review adversarial evidence", () => {
  it("reconciles available same-date actual mark against durable close during source outage", async () => {
    const { client, pool } = fixture();
    pool.issues = [];
    pool.positions[0]!.priceDate = "2026-10-15";
    pool.positions[0]!.currentPrice = "108";
    await attachActualHoldingPriceExits(client, "review-mark-outage", pool, "2026-10-15T07:00:00Z");
    mock.unavailable = true;
    pool.positions[0]!.currentPrice = "107";
    await attachActualHoldingPriceExits(client, "review-mark-outage", pool, "2026-10-15T07:00:00Z");
    expect(pool.positions[0]!.priceExit?.auditStatus).toBe("MISMATCH");
    expect(pool.positions[0]!.priceExit?.reason).toBeNull();
  });
  it("latches a fully evidenced crossing from any valid ETF lot despite another incomplete lot", async () => {
    const { client, pool, files } = fixture();
    pool.issues = [];
    // First seed the original lot's complete historical peak.
    mock.bars[1]!.close = 119;
    await attachActualHoldingPriceExits(
      client,
      "review-partial-lots",
      pool,
      "2026-10-15T07:00:00Z",
    );
    // A later lot has no entry-session close in the currently available source.
    pool.positions[0]!.quantity = "20";
    pool.positions[0]!.cost = "2003";
    pool.trades.push({
      execution: { id: "buy-2", symbol: "ABC", market: "ETF", side: "BUY", date: "2026-10-14" },
      allocation: { quantity: 10, gross: 1000, fee: 1.5 },
    } as NewActualPool["trades"][number]);
    mock.hash++;
    mock.bars = [
      { tradeDate: "2026-10-15", close: 119 },
      { tradeDate: "2026-10-16", close: 108 },
    ];
    await attachActualHoldingPriceExits(
      client,
      "review-partial-lots",
      pool,
      "2026-10-16T07:00:00Z",
    );
    expect(pool.positions[0]!.priceExit?.reason).toBe("E4");
    expect(pool.positions[0]!.priceExit?.auditStatus).toBe("LATCHED");
    expect(pool.issues).toContain("price_exit_partial_evidence:ABC");
    expect([...files.keys()].some((k) => k.endsWith("/signal.json"))).toBe(true);
  });
  it("does not expose a later same-session signal in an earlier intraday replay during source outage", async () => {
    const { client, pool } = fixture();
    await attachActualHoldingPriceExits(client, "review-cutoff", pool, "2026-10-15T07:00:00Z");
    mock.unavailable = true;
    await attachActualHoldingPriceExits(client, "review-cutoff", pool, "2026-10-15T03:00:00Z");
    expect(pool.positions[0]!.priceExit?.reason).toBeNull();
  });
});

describe("independent replay after trigger", () => {
  it("preserves an already-proven E4 crossing when a later catch-up bar is invalid", async () => {
    const { client, pool, files } = fixture();
    mock.bars = [
      { tradeDate: "2026-10-14", close: 120 },
      { tradeDate: "2026-10-15", close: 108 },
      { tradeDate: "2026-10-16", close: NaN },
      { tradeDate: "2026-10-19", close: 125 },
    ];
    await attachActualHoldingPriceExits(
      client,
      "review-post-trigger-gap",
      pool,
      "2026-10-19T07:00:00Z",
    );
    expect(pool.positions[0]!.priceExit?.reason).toBe("E4");
    expect(pool.positions[0]!.priceExit?.signalDate).toBe("2026-10-15");
    expect([...files.keys()].some((k) => k.endsWith("/signal.json"))).toBe(true);
  });
  it("audits available same-date actual mark even if the source has newer bars", async () => {
    const { client, pool } = fixture();
    pool.positions[0]!.priceDate = "2026-10-15";
    pool.positions[0]!.currentPrice = "107";
    mock.bars.push({ tradeDate: "2026-10-16", close: 115 });
    await attachActualHoldingPriceExits(
      client,
      "review-nontail-mark",
      pool,
      "2026-10-16T07:00:00Z",
    );
    expect(pool.positions[0]!.priceExit?.auditStatus).toBe("MISMATCH");
    expect(pool.positions[0]!.priceExit?.reason).toBeNull();
  });
});

it("does not fabricate a trigger when missing history precedes the potential E4 crossing", async () => {
  const { client, pool, files } = fixture();
  mock.bars = [
    { tradeDate: "2026-10-14", close: 120 },
    { tradeDate: "2026-10-15", close: NaN },
    { tradeDate: "2026-10-16", close: 108 },
    { tradeDate: "2026-10-19", close: 125 },
  ];
  await attachActualHoldingPriceExits(client, "pre-trigger-gap", pool, "2026-10-19T07:00:00Z");
  expect(pool.positions[0]!.priceExit).toMatchObject({
    reason: null,
    signalDate: null,
    auditStatus: "PENDING",
  });
  expect([...files.keys()].some((k) => k.endsWith("/signal.json"))).toBe(false);
});

describe("symbol gaps against the confirmed market calendar", () => {
  it.each(["before", "after"] as const)(
    "handles a missing symbol session %s the first proven crossing",
    async (gap) => {
      const { client, pool, files } = fixture();
      mock.marketDates = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19"];
      mock.bars =
        gap === "after"
          ? [
              { tradeDate: "2026-10-14", close: 120 },
              { tradeDate: "2026-10-15", close: 108 },
              { tradeDate: "2026-10-19", close: 125 },
            ]
          : [
              { tradeDate: "2026-10-14", close: 120 },
              { tradeDate: "2026-10-16", close: 108 },
              { tradeDate: "2026-10-19", close: 125 },
            ];
      await attachActualHoldingPriceExits(
        client,
        `calendar-gap-${gap}`,
        pool,
        "2026-10-19T07:00:00Z",
      );
      expect(pool.positions[0]!.priceExit?.reason).toBe(gap === "after" ? "E4" : null);
      expect([...files.keys()].some((k) => k.endsWith("/signal.json"))).toBe(gap === "after");
      if (gap === "after") {
        expect(pool.positions[0]!.priceExit).toMatchObject({
          observedClose: "108.00000000",
          threshold: "108",
          signalDate: "2026-10-15",
          auditStatus: "LATCHED",
        });
        expect(pool.issues).toContain("price_exit_partial_evidence:ABC");
        mock.hash++;
        mock.unavailable = true;
        await attachActualHoldingPriceExits(
          client,
          `calendar-gap-${gap}`,
          pool,
          "2026-10-20T07:00:00Z",
        );
        expect(pool.positions[0]!.priceExit).toMatchObject({
          observedClose: "108.00000000",
          threshold: "108",
          signalDate: "2026-10-15",
          auditStatus: "LATCHED",
        });
      }
    },
  );
});
