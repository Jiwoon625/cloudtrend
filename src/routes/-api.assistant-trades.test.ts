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

import { newActualAsset } from "../lib/newActualPortfolio";
import { parseNewActualPortfolioRequest } from "../lib/newActualPortfolioInput";
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

const post = (action: "CONFIRM" | "REJECT" = "CONFIRM", token = "test-jwt") => {
  const handlers = (
    Route as unknown as {
      options: { server: { handlers: { POST: (x: { request: Request }) => Promise<Response> } } };
    }
  ).options.server.handlers;
  return handlers.POST({
    request: new Request("https://cloudtrend.vercel.app/api/assistant-trades", {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
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

  it("releases a mismatched domestic ETF claim before attempting a ledger write", async () => {
    state.rpc.mockImplementation(async (name: string) => ({
      data: name === "assistant_trade_claim" ? "claim-token" : true,
      error: null,
    }));
    state.proposal!["trade"] = {
      ...(state.proposal!["trade"] as object),
      market: "KOSPI",
      symbol: "423160",
    };
    state.snapshot.mockResolvedValue({
      revision: 92,
      payload: {
        executions: [{ id: "previous", symbol: "423160", market: "ETF" }],
        newActualPortfolio: { assignments: {} },
      },
    });
    const response = await post();
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("MARKET_MISMATCH");
    expect(state.save).not.toHaveBeenCalled();
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual([
      "assistant_trade_claim",
      "assistant_trade_release",
    ]);
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

  function usProposal() {
    state.proposal!["trade"] = {
      ...(state.proposal!["trade"] as object),
      market: "US",
      symbol: "AAPL",
      name: "Apple",
      accountLabel: "GENERAL",
      price: 0.1,
      shares: 3,
      fee: 0.012345,
    };
    state.rpc.mockImplementation(async (name: string) => ({
      data: name === "assistant_trade_claim" ? "claim-token" : true,
      error: null,
    }));
  }
  it.each([
    ["0046A0", 9175, 77, 25],
    ["423160", 110864.82352941, 17, 68],
    ["0048J0", 13220, 8, 3],
  ])("records ETF %s using the ETF asset accepted by the real writer", async (symbol, price, shares, fee) => {
    usProposal();
    state.proposal!["trade"] = {
      ...(state.proposal!["trade"] as object), market: "ETF", symbol, price, shares, fee,
    };
    state.snapshot.mockResolvedValue({ revision: 12, payload: { executions: [] } });
    state.save.mockImplementation(async (_client, _uid, raw) => {
      const input = parseNewActualPortfolioRequest(raw);
      if (input.action !== "execution" || newActualAsset(input.execution.market) !== input.asset)
        throw new Error("종목 시장과 선택한 자산군이 다릅니다.");
      return { revision: 13, reused: false };
    });
    expect((await post()).status).toBe(200);
    expect(state.save).toHaveBeenCalledWith(expect.anything(), state.uid,
      expect.objectContaining({ asset: "ETF" }));
    expect(state.snapshot).toHaveBeenCalledWith(expect.anything(), state.uid, "portfolio_ledgers");
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual([
      "assistant_trade_claim", "assistant_trade_record",
    ]);
  });
  it("records US proposals through the same owner session and USD CAS ledger", async () => {
    usProposal();
    state.snapshot.mockResolvedValue({ revision: 12, payload: { executions: [] } });
    state.save.mockResolvedValue({ revision: 13, reused: false });
    const response = await post();
    expect(response.status).toBe(200);
    expect(state.authorization).toBe("Bearer test-jwt");
    expect(state.snapshot).toHaveBeenCalledWith(
      expect.anything(),
      state.uid,
      "us_actual_portfolio_ledgers",
    );
    expect(state.save).toHaveBeenCalledWith(
      expect.anything(),
      state.uid,
      expect.objectContaining({
        asset: "US",
        accessToken: "test-jwt",
        expectedRevision: 12,
        execution: expect.objectContaining({
          market: "US",
          symbol: "AAPL",
          shares: 3,
          price: 0.1,
          fee: 0.012345,
        }),
        allocation: expect.objectContaining({ gross: 0.3, fee: 0.012345 }),
      }),
    );
    expect(state.service).not.toHaveBeenCalled();
  });
  it("keeps the common owner check for US approvals without a second login", async () => {
    usProposal();
    expect((await post("CONFIRM", "")).status).toBe(401);
    state.uid = "11111111-1111-4111-8111-111111111111";
    expect((await post()).status).toBe(403);
    expect(state.snapshot).not.toHaveBeenCalled();
    expect(state.save).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("rejects a retry whose existing execution belongs to another market", async () => {
    usProposal();
    const id = "new-actual:" + state.proposal!["id"];
    state.snapshot.mockResolvedValue({
      revision: 13,
      payload: {
        executions: [{ ...(state.proposal!["trade"] as object), id, market: "KOSDAQ" }],
        newActualPortfolio: {
          assignments: {
            [id]: {
              quantity: 3,
              gross: 0.3,
              fee: 0.012345,
              brokerReference: "notion:" + state.proposal!["source_page_id"],
            },
          },
        },
      },
    });
    expect((await post()).status).toBe(409);
    expect(state.save).not.toHaveBeenCalled();
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual([
      "assistant_trade_claim",
      "assistant_trade_release",
    ]);
  });
  it("recovers a US fill left PROCESSING after the ledger save without writing it twice", async () => {
    usProposal();
    const id = "new-actual:" + state.proposal!["id"];
    const trade = state.proposal!["trade"] as Record<string, unknown>;
    let recordAttempts = 0;
    state.rpc.mockImplementation(async (name: string) => {
      if (name === "assistant_trade_claim") return { data: "claim-token", error: null };
      if (name === "assistant_trade_record") return { data: ++recordAttempts > 1, error: null };
      return { data: null, error: null };
    });
    state.snapshot
      .mockResolvedValueOnce({ revision: 12, payload: { executions: [] } })
      .mockResolvedValueOnce({
        revision: 13,
        payload: {
          executions: [{ ...trade, id }],
          newActualPortfolio: {
            assignments: {
              [id]: {
                quantity: 3,
                gross: 0.3,
                fee: 0.012345,
                brokerReference: "notion:" + state.proposal!["source_page_id"],
              },
            },
          },
        },
      });
    state.save.mockResolvedValue({ revision: 13, reused: false });

    // The first request has already committed the ledger fill when recording
    // the proposal status fails. Model the stale PROCESSING row on retry.
    expect((await post()).status).toBe(409);
    expect(state.save).toHaveBeenCalledTimes(1);
    state.proposal!["status"] = "PROCESSING";
    state.proposal!["processing_started_at"] = "2026-10-21T00:00:00Z";

    const retry = await post();
    expect(retry.status).toBe(200);
    expect((await retry.json()).reused).toBe(true);
    expect(state.save).toHaveBeenCalledTimes(1);
    expect(recordAttempts).toBe(2);
  });

  it("reconciles a US retry without recording the fill twice", async () => {
    usProposal();
    const id = "new-actual:" + state.proposal!["id"];
    state.snapshot.mockResolvedValue({
      revision: 13,
      payload: {
        executions: [{ ...(state.proposal!["trade"] as object), id }],
        newActualPortfolio: {
          assignments: {
            [id]: {
              quantity: 3,
              gross: 0.3,
              fee: 0.012345,
              brokerReference: "notion:" + state.proposal!["source_page_id"],
            },
          },
        },
      },
    });
    const response = await post();
    expect(response.status).toBe(200);
    expect((await response.json()).reused).toBe(true);
    expect(state.save).not.toHaveBeenCalled();
  });
  it("does not write a US fill when its ledger is unavailable or revision changed", async () => {
    usProposal();
    state.snapshot.mockResolvedValue(null);
    expect((await post()).status).toBe(409);
    expect(state.save).not.toHaveBeenCalled();
    expect(state.rpc.mock.calls.map(([name]) => name)).toContain("assistant_trade_release");
    state.snapshot.mockResolvedValue({ revision: 12, payload: { executions: [] } });
    state.save.mockRejectedValue(new Error("원장 버전이 변경됐습니다."));
    const before = state.rpc.mock.calls.length;
    expect((await post()).status).not.toBe(200);
    expect(state.rpc.mock.calls.slice(before).map(([name]) => name)).toEqual([
      "assistant_trade_claim",
    ]);
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
