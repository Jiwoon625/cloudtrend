import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  owner: "11111111-1111-4111-8111-111111111111" as string | null,
  authError: false,
  clients: [] as unknown[],
  load: vi.fn(),
  save: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (x: unknown) => unknown) => ({
      handler: (handler: (a: { data: unknown }) => unknown) => async (args: { data: unknown }) =>
        handler({ data: validate(args.data) }),
    }),
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: unknown) => {
    state.clients.push(options);
    return {
      auth: {
        getUser: async (token: string) => {
          state.getUser(token);
          return {
            data: {
              user: state.owner
                ? { id: state.owner, user_metadata: { userId: "spoofed-owner" } }
                : null,
            },
            error: state.authError ? { message: "sensitive-auth-error" } : null,
          };
        },
      },
    };
  },
}));
vi.mock("./newActualPortfolio.server", () => ({
  loadNewActualPortfolio: state.load,
  saveNewActualPortfolio: state.save,
}));
import { newActualPortfolioServer } from "./newActualPortfolio.functions";
const call = (data: unknown) =>
  (newActualPortfolioServer as unknown as (input: { data: unknown }) => Promise<unknown>)({ data });
beforeEach(() => {
  state.owner = "11111111-1111-4111-8111-111111111111";
  state.authError = false;
  state.clients = [];
  vi.clearAllMocks();
  state.load.mockResolvedValue({ domesticRevision: 2, usRevision: 7, pools: {}, warnings: [] });
  state.save.mockResolvedValue({ revision: 2, reused: false });
});
describe("new actual owner API boundary", () => {
  it("authenticates exact supplied token and uses verified account ID, read-only for load", async () => {
    await call({ action: "load", accessToken: "synthetic-token" });
    expect(state.getUser).toHaveBeenCalledWith("synthetic-token");
    expect(state.load).toHaveBeenCalledWith(expect.anything(), state.owner);
    expect(state.save).not.toHaveBeenCalled();
    expect(state.clients[0]).toMatchObject({
      global: { headers: { Authorization: "Bearer synthetic-token" } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  });
  it.each(["missing", "expired"])("rejects %s auth before all data access", async (condition) => {
    if (condition === "missing") state.owner = null;
    else state.authError = true;
    await expect(call({ action: "load", accessToken: "synthetic" })).rejects.toThrow(/로그인/);
    expect(state.load).not.toHaveBeenCalled();
    expect(state.save).not.toHaveBeenCalled();
  });
  it("rejects owner/source override at schema boundary", async () => {
    await expect(
      call({ action: "load", accessToken: "synthetic", userId: "someone-else" }),
    ).rejects.toThrow();
    expect(state.getUser).not.toHaveBeenCalled();
  });
  it("writes only after explicit confirmation, then rereads new-only result", async () => {
    const input = {
      action: "cash",
      accessToken: "synthetic",
      expectedRevision: 1,
      requestId: "00000000-0000-4000-8000-000000000001",
      currency: "KRW",
      event: {
        id: "",
        date: "2026-10-12",
        kind: "DEPOSIT",
        amount: 1,
        reference: "real-allocation",
      },
      confirmed: true,
    };
    await call(input);
    expect(state.save).toHaveBeenCalledWith(expect.anything(), state.owner, input);
    expect(state.load).toHaveBeenCalledWith(expect.anything(), state.owner);
    expect(state.save.mock.invocationCallOrder[0]).toBeLessThan(
      state.load.mock.invocationCallOrder[0]!,
    );
  });
  it("never retries failed write or leaks SQL/source secrets", async () => {
    state.load.mockRejectedValueOnce(new Error("private SQL with token"));
    await expect(call({ action: "load", accessToken: "synthetic" })).rejects.toThrow(
      /신규 배정 자료/,
    );
    expect(state.load).toHaveBeenCalledTimes(1);
    expect(state.save).not.toHaveBeenCalled();
  });
});
