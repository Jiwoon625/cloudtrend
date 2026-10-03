import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { downloadFreshObject } from "../src/lib/freshStorage";
import { loadUsOrderPreview, loadUsOrderPreviews } from "../src/lib/usOrderPreview.server";
import { buildUsOrderPreview } from "../src/lib/engine/usProspectiveOrderPreview";
import { US_PROSPECTIVE_RULE_VERSION } from "../src/lib/engine/usProspective";
import {
  US_PROSPECTIVE_STRATEGIES,
  type UsPortfolioState,
} from "../src/lib/engine/usProspectivePortfolio";

vi.mock("../src/lib/freshStorage", () => ({ downloadFreshObject: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
const date = "2026-09-30";
const strategyId = "A0_QUARTER_PRIMARY";
const config = US_PROSPECTIVE_STRATEGIES[0]!;
const quotes = [{ symbol: "ABC", name: "Example", sector: "Tech", close: 100, date }];
const state: UsPortfolioState = {
  lastDate: date,
  initializedDate: "2026-09-28",
  initialCapital: 100000,
  cash: 90000,
  positions: {
    ABC: {
      symbol: "ABC",
      name: "Example",
      sector: "Tech",
      shares: 100,
      lastPrice: 100,
      entryDate: "2026-09-28",
      entryCoreRank: 0.9,
    },
  },
  pendingTargets: { ABC: { symbol: "ABC", targetWeight: 1, signalDate: date, reason: "ONSET80" } },
  pendingExits: {},
  adv20BySymbol: { ABC: 10000000 },
  lastQuarterRebalance: null,
  benchmarkBasePrice: 650,
  benchmarkBaseDate: "2026-09-28",
  totalFees: 0,
};
const snapshot = () => ({
  strategy_id: strategyId,
  date,
  rule_version: US_PROSPECTIVE_RULE_VERSION,
  state: structuredClone(state) as unknown as Record<string, unknown>,
});
const history = () => ({
  date,
  rule_version: US_PROSPECTIVE_RULE_VERSION,
  data_hash: "fixture-hash",
});
function mockClient(
  options: {
    snapshot?: unknown;
    history?: unknown;
    snapshotError?: string;
    historyError?: string;
    authError?: boolean;
  } = {},
) {
  const queries: { table: string; select: string; filters: [string, unknown][] }[] = [];
  const from = vi.fn((table: string) => {
    const call = { table, select: "", filters: [] as [string, unknown][] };
    queries.push(call);
    const query = {
      select: vi.fn((selection: string) => {
        call.select = selection;
        return query;
      }),
      eq: vi.fn((field: string, value: unknown) => {
        call.filters.push([field, value]);
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      maybeSingle: vi.fn(async () =>
        table === "us_portfolio_snapshots"
          ? {
              data: "snapshot" in options ? options.snapshot : snapshot(),
              error: options.snapshotError ? { message: options.snapshotError } : null,
            }
          : {
              data: "history" in options ? options.history : history(),
              error: options.historyError ? { message: options.historyError } : null,
            },
      ),
    };
    return query;
  });
  const getUser = vi.fn(async () => ({
    data: { user: options.authError ? null : { id: "verified-owner" } },
    error: options.authError ? new Error("expired") : null,
  }));
  const client = { from, auth: { getUser } } as unknown as SupabaseClient;
  vi.mocked(createClient).mockReturnValue(client);
  return { client, queries, from, getUser };
}
function source(rows: unknown[] = quotes, overrides: Record<string, unknown> = {}) {
  vi.mocked(downloadFreshObject).mockResolvedValue({
    data: new Blob([
      JSON.stringify({
        dataHash: "fixture-hash",
        analysis: { date, ruleVersion: US_PROSPECTIVE_RULE_VERSION, rows, ...overrides },
      }),
    ]),
    error: null,
  });
}
beforeEach(() => vi.clearAllMocks());

describe("US order preview saved-data transport", () => {
  it("returns a validated saved preview without fetching quotes; every query is owner scoped", async () => {
    const saved = buildUsOrderPreview(config, state, quotes)!;
    const value = snapshot();
    value.state["orderPreview"] = saved;
    const { client, queries } = mockClient({ snapshot: value });
    expect(await loadUsOrderPreview(client, "owner", strategyId, date)).toBe(saved);
    expect(downloadFreshObject).not.toHaveBeenCalled();
    expect(queries.filter((q) => q.table === "us_portfolio_snapshots")).toHaveLength(1);
    expect(queries.map((q) => q.filters)).toEqual([
      [
        ["user_id", "owner"],
        ["strategy_id", strategyId],
      ],
      [
        ["user_id", "owner"],
        ["date", date],
      ],
    ]);
  });
  it("projects a legacy snapshot from its exact immutable completed result without mutation", async () => {
    const value = snapshot();
    const before = JSON.stringify(value);
    const { client } = mockClient({ snapshot: value });
    source();
    const preview = await loadUsOrderPreview(client, "owner", strategyId, date);
    expect(preview).toEqual(buildUsOrderPreview(config, state, quotes));
    expect(JSON.stringify(value)).toBe(before);
    expect(downloadFreshObject).toHaveBeenCalledExactlyOnceWith(
      client,
      "cloudtrend-data",
      `owner/results/us-screening/${date}.json`,
    );
    expect(preview).not.toHaveProperty("state");
    expect(preview).not.toHaveProperty("adv20BySymbol");
  });
  it("ignores stale, future, missing-date, and open-price quotes instead of mixing sessions", async () => {
    const { client } = mockClient();
    source([
      { ...quotes[0], date: "2026-09-29", close: 2 },
      { ...quotes[0], date: "2026-10-01", close: 1000 },
      { ...quotes[0], date: undefined, close: 1 },
      { ...quotes[0], close: null, open: 500 },
    ]);
    const preview = await loadUsOrderPreview(client, "owner", strategyId);
    expect(preview?.nextSession.status).toBe("BLOCKED");
    expect(preview?.nextSession.rows[0]?.referencePrice).toBeNull();
    expect(preview?.nextSession.rows[0]?.estimatedShares).toBeNull();
  });
  it.each([{ date: "2026-10-01" }, { ruleVersion: "different-rule" }])(
    "rejects a result belonging to another session or rule: %j",
    async (overrides) => {
      const { client } = mockClient();
      source(quotes, overrides);
      await expect(loadUsOrderPreview(client, "owner", strategyId)).rejects.toThrow(
        "기준일 또는 규칙",
      );
    },
  );
  it("rejects an immutable result with another completed input hash", async () => {
    const { client } = mockClient({ history: { ...history(), data_hash: "another-hash" } });
    source();
    await expect(loadUsOrderPreview(client, "owner", strategyId)).rejects.toThrow("데이터 해시");
  });
  it("never serves an old saved preview as current; recomputes only the current exact result", async () => {
    const value = snapshot();
    value.state["orderPreview"] = {
      ...buildUsOrderPreview(config, state, quotes),
      sourceDate: "2026-09-29",
    };
    const { client } = mockClient({ snapshot: value });
    source();
    expect((await loadUsOrderPreview(client, "owner", strategyId))?.sourceDate).toBe(date);
    expect(downloadFreshObject).toHaveBeenCalledTimes(1);
  });
  it("rejects an uncompleted latest snapshot even when its saved preview is valid", async () => {
    const value = snapshot();
    value.state["orderPreview"] = buildUsOrderPreview(config, state, quotes);
    const { client } = mockClient({ snapshot: value, history: null });
    await expect(loadUsOrderPreview(client, "owner", strategyId)).rejects.toThrow("아직 완료되지");
    expect(downloadFreshObject).not.toHaveBeenCalled();
  });
  it("rejects a browser/snapshot race and a mismatched engine state date", async () => {
    let current = mockClient();
    await expect(
      loadUsOrderPreview(current.client, "owner", strategyId, "2026-09-29"),
    ).rejects.toThrow("갱신 중");
    const value = snapshot();
    value.state["lastDate"] = "2026-09-29";
    current = mockClient({ snapshot: value });
    await expect(loadUsOrderPreview(current.client, "owner", strategyId)).rejects.toThrow(
      "상태의 기준일",
    );
    expect(downloadFreshObject).not.toHaveBeenCalled();
  });
  it("keeps missing and failed data distinct from a successful empty order plan", async () => {
    let current = mockClient({ snapshot: null });
    await expect(loadUsOrderPreview(current.client, "owner", strategyId)).rejects.toThrow(
      "스냅샷이 없습니다",
    );
    current = mockClient({ snapshotError: "read failed" });
    await expect(loadUsOrderPreview(current.client, "owner", strategyId)).rejects.toThrow(
      "read failed",
    );
    current = mockClient({ historyError: "history failed" });
    await expect(loadUsOrderPreview(current.client, "owner", strategyId)).rejects.toThrow(
      "history failed",
    );
    current = mockClient();
    vi.mocked(downloadFreshObject).mockResolvedValue({ data: null, error: null });
    await expect(loadUsOrderPreview(current.client, "owner", strategyId)).rejects.toThrow(
      "자료가 없습니다",
    );
  });
  it("refuses invalid owner, strategy and source dates before any query", async () => {
    const { client, from } = mockClient();
    await expect(loadUsOrderPreview(client, "", strategyId)).rejects.toThrow("로그인");
    await expect(loadUsOrderPreview(client, "owner", "SPY_BENCHMARK")).rejects.toThrow("지원하지");
    await expect(loadUsOrderPreview(client, "owner", strategyId, "../../other")).rejects.toThrow(
      "기준일",
    );
    expect(from).not.toHaveBeenCalled();
  });
});

describe("US preview authentication boundary", () => {
  it("validates token with getUser and uses only the verified owner", async () => {
    const { queries, getUser } = mockClient();
    source();
    const token = "test-access-token-long-enough";
    const response = await loadUsOrderPreviews(token, [{ strategyId, sourceDate: date }]);
    expect(getUser).toHaveBeenCalledWith(token);
    expect(
      queries.every((q) =>
        q.filters.some(([field, value]) => field === "user_id" && value === "verified-owner"),
      ),
    ).toBe(true);
    expect(response[0]?.preview?.sourceDate).toBe(date);
    expect(response[0]?.error).toBeNull();
    expect(response[0]).not.toHaveProperty("state");
  });
  it("denies a missing or rejected session before any data read", async () => {
    const { from, getUser } = mockClient({ authError: true });
    await expect(loadUsOrderPreviews("", [])).rejects.toThrow("로그인");
    expect(getUser).not.toHaveBeenCalled();
    await expect(
      loadUsOrderPreviews("test-access-token-long-enough", [{ strategyId, sourceDate: date }]),
    ).rejects.toThrow("로그인");
    expect(from).not.toHaveBeenCalled();
    expect(downloadFreshObject).not.toHaveBeenCalled();
  });
  it("returns per-strategy failures with no fabricated preview", async () => {
    mockClient({ snapshotError: "offline" });
    const response = await loadUsOrderPreviews("test-access-token-long-enough", [
      { strategyId, sourceDate: date },
    ]);
    expect(response[0]?.preview).toBeNull();
    expect(response[0]?.error).toContain("offline");
  });
});

it("persists only a presentation sibling after a new session step, never in completed-date replay", () => {
  const source = readFileSync("scripts/run-us-screening.ts", "utf8");
  const completed = source.slice(
    source.indexOf("if (lastHistory?.date === ingest.as_of_date)"),
    source.indexOf("const sourceMetadata"),
  );
  expect(completed).not.toContain("buildUsOrderPreview");
  expect(source).toMatch(
    /state:\s*\{\s*\.\.\.stepped.state,\s*orderPreview: buildUsOrderPreview\(strategy, stepped.state, analysis.rows\)/,
  );
  const read = readFileSync("src/lib/usOrderPreview.server.ts", "utf8");
  expect(read).not.toMatch(
    /\.upsert\(|\.insert\(|\.update\(|\.upload\(|stepUsProspectivePortfolio\(|runUsProspectiveAnalysis\(/,
  );
  expect(read).not.toContain("cache/us-screening/latest");
});

it("reprojects a pre-cutover snapshot read-only once its next session uses fixed20, ignoring saved quarterly preview", async () => {
  const at = "2026-10-02";
  const fixedSource = {
    ...structuredClone(state),
    lastDate: at,
    adv20BySymbol: { ABC: 10000000, NEW: 10000000 },
    pendingTargets: {
      NEW: { symbol: "NEW", targetWeight: 1, signalDate: at, reason: "ENTRY_ONSET80" },
      ABC: {
        symbol: "ABC",
        targetWeight: 0.2,
        signalDate: at,
        reason: "ENTRY_MINIMUM_PROPORTIONAL_FUNDING",
      },
    },
  };
  const fixedQuotes = ["ABC", "NEW"].map((symbol) => ({
    symbol,
    name: symbol,
    sector: "Tech",
    close: 100,
    date: at,
  }));
  const saved = buildUsOrderPreview(config, fixedSource, fixedQuotes)!;
  expect(saved.nextQuarter).not.toBeNull();
  const value = { ...snapshot(), date: at, state: { ...fixedSource, orderPreview: saved } };
  const before = structuredClone(value);
  const { client } = mockClient({ snapshot: value, history: { ...history(), date: at } });
  source(fixedQuotes, { date: at });
  const preview = await loadUsOrderPreview(client, "owner", strategyId, at);
  expect(preview?.nextQuarter).toBeNull();
  expect(preview?.nextSession.rows).toHaveLength(1);
  expect(preview?.nextSession.rows[0]).toMatchObject({
    symbol: "NEW",
    estimatedShares: 50,
    targetShares: 50,
  });
  expect(downloadFreshObject).toHaveBeenCalledExactlyOnceWith(
    client,
    "cloudtrend-data",
    `owner/results/us-screening/${at}.json`,
  );
  expect(value).toEqual(before);
});
