import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  uid: "bdfc8818-33a7-4030-9dbd-ecad39f223ac",
  authError: null as null | { status: number },
  active: [] as Array<{ id: string; created_at: string; status: string }>,
  history: [] as Array<{ id: string; created_at: string; status: string }>,
  queryError: false,
  service: vi.fn(),
  getUser: vi.fn(),
  authorization: "",
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("../../scripts/analysis-run-store", () => ({ trustedSupabaseClient: state.service }));
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

beforeEach(() => {
  vi.clearAllMocks();
  state.uid = "bdfc8818-33a7-4030-9dbd-ecad39f223ac";
  process.env["SUPABASE_USER_ID"] = state.uid;
  state.authError = null;
  state.queryError = false;
  state.active = [];
  state.history = [];
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
