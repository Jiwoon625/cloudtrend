import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePortfolioModelConsolidation } from "../src/lib/usePortfolioModelConsolidation";
const h = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  mounted: false,
  cleanup: null as null | (() => void),
  auth: null as null | ((event: string, session: unknown) => void),
  sessions: vi.fn(),
  call: vi.fn(),
  unsubscribe: vi.fn(),
  options: null as null | {
    queryKey: unknown[];
    enabled: boolean;
    queryFn: () => Promise<unknown>;
  },
  cache: new Map<string, unknown>(),
  failed: false,
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (!(i in h.states)) h.states[i] = initial;
    return [
      h.states[i],
      (value: unknown) => {
        h.states[i] = value;
      },
    ];
  },
  useEffect: (setup: () => () => void) => {
    if (!h.mounted) {
      h.mounted = true;
      h.cleanup = setup();
    }
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: {
    queryKey: unknown[];
    enabled: boolean;
    queryFn: () => Promise<unknown>;
  }) => {
    h.options = options;
    return {
      data: h.cache.get(String(options.queryKey[1])),
      isError: h.failed,
      error: h.failed ? new Error("denied") : null,
      isPending: !h.cache.has(String(options.queryKey[1])),
      isFetching: false,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@/lib/cloud", () => ({
  supabase: {
    auth: {
      getSession: h.sessions,
      onAuthStateChange: (cb: typeof h.auth) => {
        h.auth = cb;
        return { data: { subscription: { unsubscribe: h.unsubscribe } } };
      },
    },
  },
}));
vi.mock("@/lib/octoberShadowSummary.functions", () => ({ octoberShadowSummaryServer: h.call }));
const kinds = [
  "KR_MIXED",
  "KR_KOSPI",
  "KR_KOSDAQ",
  "US_A0",
  "ETF_V02",
  "US_A2",
  "US_B3",
  "KR_KOSPI_CONFIRM1_BEAR",
];
const summary = {
  viewVersion: "october-shadow-holdings-tax-v1",
  readyForPortfolioConsolidation: true,
  books: kinds.map((kind) => ({
    bookId: kind,
    kind,
    currency: kind.startsWith("US_") ? "USD" : "KRW",
    status: "INITIALIZED_WAITING",
    initialCapital: "1000",
    cash: "1000",
    positions: 0,
    holdings: [],
    tax: kind.startsWith("US_") ? { status: "UNAVAILABLE" } : null,
  })),
};
const session = (id: string) => ({ user: { id }, access_token: "synthetic-token" });
const HookHarness = (enabled = true) => {
  h.cursor = 0;
  return usePortfolioModelConsolidation(enabled);
};
beforeEach(() => {
  vi.clearAllMocks();
  h.states = [];
  h.cursor = 0;
  h.mounted = false;
  h.cleanup = null;
  h.auth = null;
  h.options = null;
  h.cache.clear();
  h.failed = false;
  h.sessions.mockResolvedValue({ data: { session: null }, error: null });
});
describe("owner-bound portfolio consolidation read", () => {
  it("cannot reuse another account's readiness cache and fails closed on logout", async () => {
    h.sessions.mockResolvedValue({ data: { session: session("one") }, error: null });
    h.cache.set("one", summary);
    expect(HookHarness().ready).toBe(false);
    await Promise.resolve();
    expect(HookHarness().ready).toBe(true);
    h.auth!("SIGNED_IN", session("two"));
    expect(HookHarness().ready).toBe(false);
    expect(h.options?.queryKey).toEqual(["october-shadow-summary", "two"]);
    h.auth!("SIGNED_OUT", null);
    expect(HookHarness().ready).toBe(false);
    expect(h.options?.enabled).toBe(false);
  });
  it("does not restore stale initial session after a newer logout event", async () => {
    let resolve!: (result: unknown) => void;
    h.sessions.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    h.cache.set("one", summary);
    HookHarness();
    h.auth!("SIGNED_OUT", null);
    resolve({ data: { session: session("one") }, error: null });
    await Promise.resolve();
    expect(HookHarness().ready).toBe(false);
    expect(h.options?.queryKey).toEqual(["october-shadow-summary", null]);
  });
  it("validates the current owner again before the authenticated server read", async () => {
    h.sessions.mockResolvedValue({ data: { session: session("one") }, error: null });
    HookHarness();
    await Promise.resolve();
    HookHarness();
    h.sessions.mockResolvedValue({ data: { session: session("two") }, error: null });
    await expect(h.options!.queryFn()).rejects.toThrow("로그인 소유자");
    expect(h.call).not.toHaveBeenCalled();
  });
  it("keeps old cards after a read error and skips reads outside the US panel", async () => {
    h.sessions.mockResolvedValue({ data: { session: session("one") }, error: null });
    h.cache.set("one", summary);
    HookHarness();
    await Promise.resolve();
    h.failed = true;
    expect(HookHarness().ready).toBe(false);
    h.failed = false;
    expect(HookHarness(false).ready).toBe(false);
    expect(h.options?.enabled).toBe(false);
    h.cleanup!();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });
});
