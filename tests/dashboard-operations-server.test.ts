vi.mock("../src/lib/ledger/websiteRepository.server", () => ({
  readWebsiteDocument: async (client: SupabaseClient, uid: string, source: string) => {
    const result = await client
      .from(source)
      .select("revision,payload")
      .eq("user_id", uid)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    return result.data;
  },
}));
import { describe, it, expect, vi } from "vitest";
import {
  SCREENING_CACHE_VERSION,
  DASHBOARD_CACHE_VERSION,
} from "../src/lib/screeningCacheContract";
import { createClient } from "@supabase/supabase-js";
import { loadDashboardOperations, projection } from "../src/lib/dashboardOperations.server";
import { downloadFreshObject } from "../src/lib/freshStorage";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
vi.mock("../src/lib/usOrderPreview.server", () => ({
  loadUsOrderPreview: vi.fn(async () => null),
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

describe("dashboard saved strategy-sector transport", () => {
  let run = 0;
  const signalDate = "2026-10-01";
  const strategyDoc = () => ({
    actualCapital: 100000,
    executions: [],
    settings: { maxPositions: 30, sectorCap: 0.3 },
    strategy: {
      summary: { latestDate: signalDate },
      calculatedAt: "2026-10-02T00:30:00.000Z",
      trades: Array.from({ length: 6 }, (_, i) => ({
        symbol: `HELD${i}`,
        market: "KOSDAQ",
        sectorCode: "SEMI",
        sectorName: "반도체",
        status: "OPEN",
        shares: 1,
        entryDate: "2026-09-01",
        exitDate: null,
      })),
    },
  });
  function mockRead(doc: unknown, error: string | null = null) {
    const uid = `sector-owner-${++run}`;
    const generation = { createdAt: "2026-10-02T00:20:00.000Z" };
    const requests: { table: string; columns: string; owner: string }[] = [];
    const upload = vi.fn(async () => ({ error: null }));
    const from = vi.fn((table: string) => {
      const call = { table, columns: "", owner: "" };
      requests.push(call);
      const query = {
        select: (columns: string) => {
          call.columns = columns;
          return query;
        },
        eq: (column: string, owner: string) => {
          expect(column).toBe("user_id");
          call.owner = owner;
          return query;
        },
        maybeSingle: async () => ({
          data: table === "portfolio_ledgers" && doc ? { payload: doc } : null,
          error: table === "portfolio_ledgers" && error ? { message: error } : null,
        }),
      };
      return query;
    });
    const client = {
      from,
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: uid } }, error: null })) },
      storage: { from: () => ({ upload }) },
    } as unknown as SupabaseClient;
    vi.mocked(createClient).mockReturnValue(client);
    vi.mocked(downloadFreshObject).mockImplementation(async (_client, _bucket, path) => {
      const value = path.endsWith("dashboard/latest.json")
        ? { version: DASHBOARD_CACHE_VERSION, resultDigest: uid, createdAt: generation.createdAt }
        : path.endsWith("screening/latest.json")
          ? {
              version: SCREENING_CACHE_VERSION,
              resultDigest: uid,
              payload: {
                analysis: {
                  asOfDate: signalDate,
                  tradeDates: [signalDate],
                  rows: [
                    {
                      instrument: {
                        symbol: "NEW",
                        name: "신규",
                        market: "KOSDAQ",
                        instrumentType: "STOCK",
                        sectorCode: "SEMI",
                        sectorName: "반도체",
                      },
                      snapshot: { tradeDate: signalDate, close: 1000 },
                      priority: { points: 1 },
                      operatingScore10: 8.5,
                      kosdaq80Onset: true,
                    },
                  ],
                },
              },
            }
          : null;
      return { data: value ? new Blob([JSON.stringify(value)]) : null, error: null };
    });
    return { requests, uid, upload, generation };
  }
  it("reads strategy and actual book together once, with owner-scoped SELECT and no ledger mutation", async () => {
    const doc = strategyDoc();
    const before = structuredClone(doc);
    const { requests, uid } = mockRead(doc);
    const result = await loadDashboardOperations("valid-session-token-for-test");
    expect(result.markets.find((m) => m.market === "KOSDAQ")?.onsets[0]?.sectorLimit).toMatchObject(
      { count: 6, limit: 6, status: "blocked" },
    );
    expect(requests.filter((r) => r.table === "portfolio_ledgers")).toEqual([
      { table: "portfolio_ledgers", columns: "revision,payload", owner: uid },
    ]);
    expect(doc).toEqual(before);
  });
  it.each(["missing", "failure", "stale"])(
    "keeps signals visible when the strategy ledger is %s",
    async (kind) => {
      const doc = strategyDoc();
      if (kind === "stale") doc.strategy.summary.latestDate = "2026-09-30";
      mockRead(kind === "missing" ? null : doc, kind === "failure" ? "read failed" : null);
      const result = await loadDashboardOperations("valid-session-token-for-test");
      const market = result.markets.find((m) => m.market === "KOSDAQ")!;
      expect(market.onsetCount).toBe(1);
      expect(market.onsets[0]?.sectorLimit?.status).toBe("unknown");
      expect(market.onsets[0]?.sectorLimit?.count).toBe(kind === "stale" ? 6 : null);
    },
  );
  it("overlays newer generation metadata even when the projection digest is cached", async () => {
    const { generation } = mockRead(strategyDoc());
    const first = await loadDashboardOperations("valid-session-token-for-test");
    generation.createdAt = "2026-10-02T00:40:00.000Z";
    const second = await loadDashboardOperations("valid-session-token-for-test");
    expect(first.markets.find((m) => m.market === "KOSDAQ")?.onsets[0]?.sectorLimit?.status).toBe(
      "blocked",
    );
    expect(second.markets.find((m) => m.market === "KOSDAQ")?.onsets[0]?.sectorLimit).toMatchObject(
      { count: 6, status: "unknown", issue: "최신 신호보다 이전 전략 장부" },
    );
  });
  it("refreshes ledger counts for the same screening digest without replaying its strategy", async () => {
    const doc = strategyDoc();
    mockRead(doc);
    const first = await loadDashboardOperations("valid-session-token-for-test");
    doc.strategy.trades = [];
    const second = await loadDashboardOperations("valid-session-token-for-test");
    expect(first.markets.find((m) => m.market === "KOSDAQ")?.onsets[0]?.sectorLimit?.count).toBe(6);
    expect(second.markets.find((m) => m.market === "KOSDAQ")?.onsets[0]?.sectorLimit).toMatchObject(
      { count: 0, status: "room" },
    );
  });
});
