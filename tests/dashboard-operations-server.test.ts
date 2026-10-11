import { describe, it, expect, vi } from "vitest";
import {
  SCREENING_CACHE_VERSION,
  DASHBOARD_CACHE_VERSION,
} from "../src/lib/screeningCacheContract";
import { createClient } from "@supabase/supabase-js";
import { loadDashboardOperations, projection } from "../src/lib/dashboardOperations.server";
import { downloadFreshObject } from "../src/lib/freshStorage";
import {
  loadActualPositionSnapshotForOwner,
  loadWebsitePositionContextForOwner,
} from "../src/lib/websitePositionContext.server";
import { ETF_POLICY } from "../src/lib/engine/etfStrategy";
import { projectNewActualPool } from "../src/lib/newActualPortfolio";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
vi.mock("../src/lib/websitePositionContext.server", () => ({
  loadWebsitePositionContextForOwner: vi.fn(),
  loadActualPositionSnapshotForOwner: vi.fn(),
}));
vi.mock("../src/lib/freshStorage", () => ({ downloadFreshObject: vi.fn() }));
const client = {
  storage: { from: () => ({ upload: async () => ({ error: null }) }) },
} as unknown as SupabaseClient;
describe("dashboard projection policy cache identity", () => {
  it("refuses stale policy summary before reading/reusing a sidecar", async () => {
    vi.mocked(downloadFreshObject).mockResolvedValueOnce({
      data: new Blob([JSON.stringify({ version: "old-policy", resultDigest: "old" })]),
      error: null,
    });
    await expect(projection(client, "old-summary", "kr")).rejects.toThrow("다시 실행");
  });
  it("refuses matching digest when full payload policy version is old", async () => {
    vi.mocked(downloadFreshObject).mockImplementation(async (_client, _bucket, path) => {
      const value = path.endsWith("dashboard/latest.json")
        ? { version: DASHBOARD_CACHE_VERSION, resultDigest: "same" }
        : path.endsWith("screening/latest.json")
          ? {
              version: "old",
              resultDigest: "same",
              payload: { analysis: { rows: [], asOfDate: "2026-10-05" } },
            }
          : null;
      return { data: value ? new Blob([JSON.stringify(value)]) : null, error: null };
    });
    await expect(projection(client, "old-full", "kr")).rejects.toThrow("갱신 중");
  });
  it("reprojects current partial evidence rather than reusing the pre-evidence sidecar", async () => {
    vi.mocked(downloadFreshObject).mockImplementation(async (_client, _bucket, path) => {
      const value = path.endsWith("dashboard/latest.json")
        ? { version: DASHBOARD_CACHE_VERSION, resultDigest: "sector-code" }
        : path.endsWith("dashboard-operations/kr-v1.json")
          ? {
              key: "old-sidecar:kr:dashboard-operations-sector-codes-v5:sector-code",
              index: { date: "2026-10-01", rows: [{ symbol: "OLD" }] },
            }
          : path.endsWith("screening/latest.json")
            ? {
                version: SCREENING_CACHE_VERSION,
                resultDigest: "sector-code",
                payload: {
                  analysis: {
                    asOfDate: "2026-10-01",
                    tradeDates: ["2026-10-01"],
                    rows: [
                      {
                        instrument: {
                          symbol: "NEW",
                          market: "KOSDAQ",
                          instrumentType: "STOCK",
                          sectorCode: "SEMI",
                        },
                        snapshot: { tradeDate: "2026-10-01" },
                        priority: { points: 1 },
                      },
                    ],
                  },
                },
              }
            : null;
      return { data: value ? new Blob([JSON.stringify(value)]) : null, error: null };
    });
    const projected = await projection(client, "old-sidecar", "kr");
    expect(projected?.rows[0]).toMatchObject({
      symbol: "NEW",
      sectorCode: "SEMI",
      assessment: { current: false, score: null },
    });
  });
  it("overlays fresh generation metadata on a saved sidecar", async () => {
    vi.mocked(downloadFreshObject).mockImplementation(async (_client, _bucket, path) => {
      const value = path.endsWith("dashboard/latest.json")
        ? {
            version: DASHBOARD_CACHE_VERSION,
            resultDigest: "same-sidecar",
            createdAt: "2026-10-02T00:40:00.000Z",
          }
        : {
            key: "timestamp-sidecar:kr:dashboard-operations-partial-evidence-v6:same-sidecar",
            index: {
              date: "2026-10-01",
              rows: [],
              tradeDates: [],
              screeningCreatedAt: "2026-10-02T00:20:00.000Z",
            },
          };
      return { data: new Blob([JSON.stringify(value)]), error: null };
    });
    expect((await projection(client, "timestamp-sidecar", "kr"))?.screeningCreatedAt).toBe(
      "2026-10-02T00:40:00.000Z",
    );
  });
  it("preserves each request's fresh generation when sharing an in-flight projection", async () => {
    let createdAt = "2026-10-02T00:20:00.000Z";
    let ready!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(downloadFreshObject).mockImplementation(async (_client, _bucket, path) => {
      if (path.endsWith("dashboard/latest.json"))
        return {
          data: new Blob([
            JSON.stringify({
              version: DASHBOARD_CACHE_VERSION,
              resultDigest: "in-flight",
              createdAt,
            }),
          ]),
          error: null,
        };
      if (path.endsWith("dashboard-operations/kr-v1.json")) {
        ready();
        await hold;
        return { data: null, error: null };
      }
      return {
        data: new Blob([
          JSON.stringify({
            version: SCREENING_CACHE_VERSION,
            resultDigest: "in-flight",
            payload: {
              analysis: { asOfDate: "2026-10-01", rows: [], tradeDates: [] },
            },
          }),
        ]),
        error: null,
      };
    });
    const older = projection(client, "timestamp-in-flight", "kr");
    await reached;
    createdAt = "2026-10-02T00:40:00.000Z";
    const newer = projection(client, "timestamp-in-flight", "kr");
    release();
    expect((await older)?.screeningCreatedAt).toBe("2026-10-02T00:20:00.000Z");
    expect((await newer)?.screeningCreatedAt).toBe("2026-10-02T00:40:00.000Z");
  });
  it("accepts current summary/full policy versions with matching digest", async () => {
    vi.mocked(downloadFreshObject).mockImplementation(async (_client, _bucket, path) => {
      const value = path.endsWith("dashboard/latest.json")
        ? { version: DASHBOARD_CACHE_VERSION, resultDigest: "new" }
        : path.endsWith("screening/latest.json")
          ? {
              version: SCREENING_CACHE_VERSION,
              resultDigest: "new",
              payload: { analysis: { rows: [], tradeDates: [], asOfDate: "2026-10-05" } },
            }
          : null;
      return { data: value ? new Blob([JSON.stringify(value)]) : null, error: null };
    });
    expect((await projection(client, "new-full", "kr"))?.date).toBe("2026-10-05");
  });
});

describe("dashboard new-series holdings boundary", () => {
  let run = 0;
  const signalDate = "2026-10-13";
  const emptyContext = () => ({
    positions: [] as {
      symbol: string;
      name: string;
      market: "KOSDAQ" | "ETF" | "US";
      shares: number;
      firstEntryDate: string;
    }[],
    heldSymbols: [],
    lastSellDateBySymbol: {},
    actualExecutions: [] as {
      symbol: string;
      market: "KOSDAQ";
      date: string;
      side: "SELL";
      shares: number;
    }[],
    actualPools: {
      KRW: projectNewActualPool({
        currency: "KRW",
        executions: [],
        quotes: {},
        valuationDate: null,
        today: signalDate,
      }),
      USD: projectNewActualPool({
        currency: "USD",
        executions: [],
        quotes: {},
        valuationDate: null,
        today: signalDate,
      }),
    },
  });
  const legacyDoc = () => ({
    actualCapital: 99999999,
    executions: [
      {
        id: "old-buy",
        symbol: "NEW",
        market: "KOSDAQ",
        side: "BUY",
        shares: 100,
        date: "2026-09-01",
      },
      {
        id: "old-sell",
        symbol: "LEGACY",
        market: "KOSDAQ",
        side: "SELL",
        shares: 100,
        date: signalDate,
      },
    ],
    settings: { maxPositions: 30 },
    strategy: { trades: [{ symbol: "NEW", market: "KOSDAQ", status: "OPEN", shares: 100 }] },
  });
  function mockRead(
    context = emptyContext(),
    date = signalDate,
    market: "KOSDAQ" | "ETF" | "US" = "KOSDAQ",
  ) {
    const uid = `new-series-owner-${++run}`;
    const oldDocument = legacyDoc();
    const from = vi.fn(() => {
      throw new Error("Dashboard must not request the old complete ledger");
    });
    const upload = vi.fn(async () => ({ error: null }));
    const client = {
      from,
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: uid } }, error: null })) },
      storage: { from: () => ({ upload }) },
    } as unknown as SupabaseClient;
    vi.mocked(createClient).mockReturnValue(client);
    vi.mocked(loadActualPositionSnapshotForOwner).mockImplementation(async (readClient, owner) => {
      expect(readClient).toBe(client);
      expect(owner).toBe(uid);
      return { context, domestic: null, us: null } as unknown as Awaited<
        ReturnType<typeof loadActualPositionSnapshotForOwner>
      >;
    });
    vi.mocked(loadWebsitePositionContextForOwner).mockClear();
    vi.mocked(loadWebsitePositionContextForOwner).mockRejectedValue(
      new Error("Shadow unavailable; actual dashboard must not request the union reader"),
    );
    const paths: string[] = [];
    vi.mocked(downloadFreshObject).mockImplementation(async (_client, _bucket, path) => {
      paths.push(path);
      if (market === "US") {
        const value =
          path.endsWith("us-screening/summary-v1.json") || path.endsWith("us-screening/latest.json")
            ? {
                dataHash: uid,
                generatedAt: `${date}T22:00:00.000Z`,
                analysis: {
                  date,
                  rows: ["NEW", "LEGACY"].map((symbol) => ({
                    symbol,
                    name: symbol,
                    date,
                    close: 100,
                    coreRank: symbol === "NEW" ? 0.6 : 0.9,
                    a0Entry: symbol === "LEGACY",
                    a0Exit: symbol === "NEW",
                    a0BetaExit: false,
                  })),
                },
              }
            : null;
        return { data: value ? new Blob([JSON.stringify(value)]) : null, error: null };
      }
      const value = path.endsWith("dashboard/latest.json")
        ? {
            version: DASHBOARD_CACHE_VERSION,
            resultDigest: uid,
            createdAt: `${date}T08:00:00.000Z`,
          }
        : path.endsWith("screening/latest.json")
          ? {
              version: SCREENING_CACHE_VERSION,
              resultDigest: uid,
              payload: {
                analysis: {
                  asOfDate: date,
                  tradeDates: [date],
                  rows: ["NEW", "LEGACY"].map((symbol) => ({
                    instrument: {
                      symbol,
                      name: symbol,
                      market: market === "ETF" ? "KOSPI" : market,
                      instrumentType: market === "ETF" ? "ETF" : "STOCK",
                      sectorCode: "SEMI",
                      sectorName: "반도체",
                    },
                    snapshot: { tradeDate: date, close: 1000 },
                    priority: { points: 1 },
                    operatingScore10: 9.5,
                    scoreDelta1d: 20,
                    kosdaq80Onset: true,
                    ...(market === "ETF"
                      ? {
                          etfStrategy: {
                            version: ETF_POLICY.version,
                            date,
                            dataStatus: "ready",
                            eligible: true,
                            entryState: symbol === "LEGACY" ? "confirmed" : "none",
                            originDate: "2026-10-12",
                            confirmationDate: date,
                            confirmationIssues: [],
                            onset: symbol === "LEGACY",
                            exit: symbol === "NEW" ? "MA60" : null,
                            score: 85,
                            issues: [],
                            averageTradingValue20: 1000000,
                          },
                        }
                      : {}),
                  })),
                },
              },
            }
          : path.endsWith("portfolio/etf-holdings/latest.json")
            ? { symbols: ["069500"], updatedAt: "2026-09-01" }
            : null;
      return { data: value ? new Blob([JSON.stringify(value)]) : null, error: null };
    });
    return { from, uid, paths, oldDocument };
  }
  it("does not read complete old actual, beta, or manual ETF holdings or inherit old capital", async () => {
    const { from, paths, oldDocument } = mockRead();
    const before = structuredClone(oldDocument);
    const result = await loadDashboardOperations("valid-session-token-for-test");
    const market = result.markets.find((item) => item.market === "KOSDAQ")!;
    expect(market.onsets.map((row) => row.symbol)).toEqual(["LEGACY", "NEW"]);
    expect(market.exitCount).toBe(0);
    expect(market.holdingsKnown).toBe(true);
    expect(market.onsets[0]?.sectorLimit).toMatchObject({
      status: "room",
      count: 0,
      issue: null,
    });
    expect(result.newActualPools?.KRW).toMatchObject({
      fundingStatus: "PENDING",
      netContributions: null,
      cash: null,
      openPositions: 0,
    });
    expect(result.usPortfolio).toBeNull();
    expect(result.etfHoldings).toBeNull();
    expect(result.usOrderPreview).toBeNull();
    expect(from).not.toHaveBeenCalled();
    expect(loadWebsitePositionContextForOwner).not.toHaveBeenCalled();
    expect(paths.some((path) => path.includes("etf-holdings"))).toBe(false);
    expect(oldDocument).toEqual(before);
  });
  it("uses only validated new actual holdings for EXIT and duplicate-entry suppression", async () => {
    const context = emptyContext();
    context.positions.push({
      symbol: "NEW",
      name: "신규 보유",
      market: "KOSDAQ",
      shares: 2,
      firstEntryDate: "2026-10-12",
    });
    // A ticker in a different market cannot consume the Korean stock holding slot.
    context.positions.push({
      symbol: "LEGACY",
      name: "다른 시장",
      market: "US",
      shares: 1,
      firstEntryDate: "2026-10-12",
    });
    mockRead(context);
    const result = await loadDashboardOperations("valid-session-token-for-test");
    const market = result.markets.find((item) => item.market === "KOSDAQ")!;
    expect(market.onsets.map((row) => row.symbol)).toEqual(["LEGACY"]);
    expect(market.exits.map((row) => row.symbol)).toEqual(["NEW"]);
  });
  it.each(["KOSDAQ", "ETF", "US"] as const)(
    "shows %s conditions at zero cash, using actual holdings even when the union reader contains Shadow holdings and sells",
    async (market) => {
      const context = emptyContext();
      context.positions.push({
        symbol: "NEW",
        name: "실제 보유",
        market,
        shares: 1,
        firstEntryDate: "2026-10-12",
      });
      context.actualPools[market === "US" ? "USD" : "KRW"].cash = "0";
      mockRead(context, signalDate, market);
      const shadowContext = structuredClone(context);
      shadowContext.positions.push({
        symbol: "LEGACY",
        name: "Shadow only",
        market,
        shares: 99,
        firstEntryDate: "2026-10-12",
      });
      // Neither Shadow holdings nor a model sale may consume actual entry conditions.
      vi.mocked(loadWebsitePositionContextForOwner).mockResolvedValue({
        ...shadowContext,
        actualExecutions: [
          { symbol: "LEGACY", market, side: "SELL", shares: 99, date: signalDate },
        ],
      } as unknown as Awaited<ReturnType<typeof loadWebsitePositionContextForOwner>>);
      const result = await loadDashboardOperations("valid-session-token-for-test");
      const signals = result.markets.find((item) => item.market === market)!;
      expect(signals.onsets.map((row) => row.symbol)).toEqual(["LEGACY"]);
      expect(signals.exits.map((row) => row.symbol)).toEqual(["NEW"]);
      expect(signals.holdingsKnown).toBe(true);
      expect(signals.conditionCount).toBe(market === "KOSDAQ" ? 2 : 1);
      expect(signals.conditions?.find((row) => row.symbol === "LEGACY")).toMatchObject({
        actualState: "READY",
        held: false,
      });
      if (market === "KOSDAQ")
        expect(signals.conditions?.find((row) => row.symbol === "NEW")).toMatchObject({
          actualState: "HELD",
          held: true,
        });
      if (market === "KOSDAQ")
        expect(signals.onsets[0]?.sectorLimit).toMatchObject({
          count: 1,
          limit: 6,
          maxPositions: 30,
          status: "room",
          issue: null,
        });
      expect(result.newActualPools?.[market === "US" ? "USD" : "KRW"].cash).toBe("0");
      expect(result.warnings).toEqual([]);
      expect(loadWebsitePositionContextForOwner).not.toHaveBeenCalled();
    },
  );
  it("consumes only the new-series allocated sell signal", async () => {
    const context = emptyContext();
    context.actualExecutions.push({
      symbol: "NEW",
      market: "KOSDAQ",
      side: "SELL",
      shares: 1,
      date: signalDate,
    });
    mockRead(context);
    const result = await loadDashboardOperations("valid-session-token-for-test");
    expect(
      result.markets.find((item) => item.market === "KOSDAQ")?.onsets.map((row) => row.symbol),
    ).toEqual(["LEGACY"]);
    const signals = result.markets.find((item) => item.market === "KOSDAQ")!;
    expect(signals.conditionCount).toBe(2);
    expect(signals.conditions?.find((row) => row.symbol === "NEW")).toMatchObject({
      actualState: "CONSUMED",
      held: false,
    });
  });
  it("keeps pre-start screening out of actionable entry and EXIT lists", async () => {
    mockRead(emptyContext(), "2026-10-09");
    const result = await loadDashboardOperations("valid-session-token-for-test");
    const market = result.markets.find((item) => item.market === "KOSDAQ")!;
    expect(market).toMatchObject({
      date: "2026-10-09",
      onsetCount: 0,
      conditionCount: 0,
      conditions: [],
      pendingCount: 0,
      exitCount: 0,
      onsets: [],
      pending: [],
      exits: [],
    });
    expect(result.warnings.join(" ")).toContain("신규 운용 시작 전 자료");
  });
  it("fails closed when new-series validation fails instead of falling back to old books", async () => {
    const { from } = mockRead();
    vi.mocked(loadActualPositionSnapshotForOwner).mockRejectedValueOnce(
      new Error("Invalid new allocation"),
    );
    const result = await loadDashboardOperations("valid-session-token-for-test");
    expect(result.newActualPools).toBeNull();
    expect(result.markets.every((item) => !item.holdingsKnown && item.exitCount === null)).toBe(
      true,
    );
    const signals = result.markets.find((item) => item.market === "KOSDAQ")!;
    expect(signals).toMatchObject({ conditionCount: 2, onsetCount: null, onsets: [] });
    expect(signals.conditions?.every((row) => row.actualState === "UNKNOWN")).toBe(true);
    expect(result.warnings.join(" ")).toContain("신규 실제 보유정보를 확인하지 못해");
    expect(from).not.toHaveBeenCalled();
    expect(loadWebsitePositionContextForOwner).not.toHaveBeenCalled();
  });
  it("refreshes new holdings for the same screening digest without caching old context", async () => {
    const context = emptyContext();
    mockRead(context);
    const first = await loadDashboardOperations("valid-session-token-for-test");
    context.positions.push({
      symbol: "NEW",
      name: "신규",
      market: "KOSDAQ",
      shares: 2,
      firstEntryDate: "2026-10-12",
    });
    const second = await loadDashboardOperations("valid-session-token-for-test");
    expect(first.markets.find((item) => item.market === "KOSDAQ")?.onsetCount).toBe(2);
    expect(second.markets.find((item) => item.market === "KOSDAQ")?.onsetCount).toBe(1);
    expect(first.markets.find((item) => item.market === "KOSDAQ")?.conditionCount).toBe(2);
    expect(second.markets.find((item) => item.market === "KOSDAQ")?.conditionCount).toBe(2);
    expect(
      second.markets
        .find((item) => item.market === "KOSDAQ")
        ?.conditions?.find((row) => row.symbol === "NEW")?.actualState,
    ).toBe("HELD");
  });
});
