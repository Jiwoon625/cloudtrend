import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  uid: "bdfc8818-33a7-4030-9dbd-ecad39f223ac",
  authError: null as null | { status: number },
  active: [] as Array<{ id: string; created_at: string; status: string }>,
  history: [] as Array<{ id: string; created_at: string; status: string }>,
  queryError: false,
  service: vi.fn(),
  rpc: vi.fn(),
  save: vi.fn(),
  snapshot: vi.fn(),
  proposal: null as null | Record<string, unknown>,
  getUser: vi.fn(),
  authorization: "",
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("../lib/ledger/websiteRepository.server", () => ({ readWebsiteDocument: state.snapshot }));
vi.mock("../lib/newActualPortfolio.server", () => ({ saveNewActualPortfolio: state.save }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (
    _url: string,
    _key: string,
    options: { global: { headers: { Authorization: string } } },
  ) => {
    state.authorization = options.global.headers.Authorization;
    return {
      auth: {
        getUser: async (token: string) => {
          state.getUser(token);
          return {
            data: { user: state.authError ? null : { id: state.uid } },
            error: state.authError,
          };
        },
      },
      rpc: state.rpc,
      from: () => {
        let status: string[] = [];
        let offset = 0;
        let end = 49;
        const query = {
          select: () => query,
          eq: () => query,
          in: (_field: string, values: string[]) => {
            status = values;
            return query;
          },
          order: () => query,
          range: (start: number, finish: number) => {
            offset = start;
            end = finish;
            return query;
          },
          limit: () => query,
          maybeSingle: async () => ({ data: state.proposal, error: null }),
          then: (resolve: (result: unknown) => unknown) => {
            const rows = status.includes("PENDING") ? state.active : state.history;
            return Promise.resolve(
              resolve({
                data: status.includes("PENDING") ? rows.slice(offset, end + 1) : rows.slice(0, 25),
                count: rows.length,
                error: state.queryError ? { message: "private SQL detail" } : null,
              }),
            );
          },
        };
        return query;
      },
    };
  },
}));

import { Route } from "./api.assistant-trades";

const get = (page = 0, token = "test-jwt") => {
  const handlers = (
    Route as unknown as {
      options: { server: { handlers: { GET: (x: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers;
  return handlers.GET({
    request: new Request(`https://cloudtrend.vercel.app/api/assistant-trades?pendingPage=${page}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  });
};

const post = (action: "CONFIRM" | "REJECT" = "CONFIRM") => {
  const handlers = (
    Route as unknown as {
      options: { server: { handlers: { POST: (x: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers;
  return handlers.POST({
    request: new Request("https://cloudtrend.vercel.app/api/assistant-trades", {
      method: "POST",
      headers: { Authorization: "Bearer test-jwt", "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        proposalId: "faa46c4e-ea94-4ff8-85f3-22e458da8b26",
        confirmed: true,
      }),
    }),
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  state.uid = "bdfc8818-33a7-4030-9dbd-ecad39f223ac";
  process.env["SUPABASE_USER_ID"] = state.uid;
  state.authError = null;
  state.queryError = false;
  state.active = [];
  state.history = [];
  state.proposal = null;
  state.rpc.mockReset();
  state.save.mockReset();
  state.snapshot.mockReset();
});

describe("assistant trade owner approval", () => {
  beforeEach(() => {
    state.proposal = {
      id: "faa46c4e-ea94-4ff8-85f3-22e458da8b26",
      user_id: state.uid,
      source_page_id: "3fed908c-ac2f-817e-bf54-c58ab0cde580",
      status: "PENDING",
      trade: {
        date: "2026-10-19",
        name: "인텍플러스",
        symbol: "064290",
        market: "KOSDAQ",
        side: "BUY",
        shares: 7,
        price: 60300,
        fee: 15,
        accountLabel: "ISA",
        sourcePageId: "3fed908c-ac2f-817e-bf54-c58ab0cde580",
      },
    };
  });

  it("reports a missing transition migration before writing the actual ledger", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    const response = await post();
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("SERVER_CONFIG");
    expect(state.save).not.toHaveBeenCalled();
    expect(state.service).not.toHaveBeenCalled();
  });

  it("claims with the owner JWT, saves through the CAS API, then records the same proposal", async () => {
    state.rpc.mockImplementation(async (name: string) => ({
      data: name === "assistant_trade_claim" ? "claim-token" : true,
      error: null,
    }));
    state.snapshot.mockResolvedValue({
      revision: 84,
      payload: { executions: [], newActualPortfolio: { assignments: {} } },
    });
    state.save.mockResolvedValue({ revision: 85, reused: false });
    const response = await post();
    expect(response.status).toBe(200);
    expect((await response.json()).executionId).toBe(
      "new-actual:faa46c4e-ea94-4ff8-85f3-22e458da8b26",
    );
    expect(state.save).toHaveBeenCalledWith(
      expect.anything(),
      state.uid,
      expect.objectContaining({
        requestId: state.proposal!["id"],
        expectedRevision: 84,
        execution: expect.objectContaining({
          date: "2026-10-19",
          shares: 7,
          price: 60300,
          fee: 15,
        }),
        allocation: expect.objectContaining({ gross: 422100, fee: 15 }),
      }),
    );
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual([
      "assistant_trade_claim",
      "assistant_trade_record",
    ]);
    expect(state.service).not.toHaveBeenCalled();
  });

  it("does not reject a proposal already claimed by approval", async () => {
    state.rpc.mockResolvedValue({ data: false, error: null });
    expect((await post("REJECT")).status).toBe(409);
    expect(state.save).not.toHaveBeenCalled();
  });
});

describe("assistant trade inbox owner read", () => {
  it("reads all active pages through owner JWT and RLS without a service role client", async () => {
    state.active = Array.from({ length: 53 }, (_, i) => ({
      id: `${i}`,
      created_at: `2026-10-19T${String(i).padStart(2, "0")}:00:00Z`,
      status: "PENDING",
    }));
    const first = await (await get()).json();
    const second = await (await get(1)).json();
    expect(first.proposals).toHaveLength(50);
    expect(second.proposals.map((p: { id: string }) => p.id)).toEqual(["50", "51", "52"]);
    expect(first.pendingTotal).toBe(53);
    expect(first.hasMorePending).toBe(true);
    expect(second.hasMorePending).toBe(false);
    expect(state.authorization).toBe("Bearer test-jwt");
    expect(state.service).not.toHaveBeenCalled();
  });

  it("distinguishes no session, wrong owner, server setup, query failure and a real empty inbox", async () => {
    expect((await get(0, "")).status).toBe(401);
    state.authError = { status: 401 };
    expect((await get()).status).toBe(401);
    state.authError = null;
    state.uid = "11111111-1111-4111-8111-111111111111";
    expect((await get()).status).toBe(403);
    state.uid = "bdfc8818-33a7-4030-9dbd-ecad39f223ac";
    delete process.env["SUPABASE_USER_ID"];
    expect((await get()).status).toBe(200); // verified single-owner fallback
    process.env["SUPABASE_USER_ID"] = "invalid-owner";
    expect((await get()).status).toBe(503);
    process.env["SUPABASE_USER_ID"] = state.uid;
    state.queryError = true;
    const failure = await get();
    expect(failure.status).toBe(502);
    expect((await failure.json()).code).toBe("QUERY_FAILED");
    state.queryError = false;
    const empty = await get();
    expect(empty.status).toBe(200);
    expect((await empty.json()).pendingTotal).toBe(0);
  });
});
