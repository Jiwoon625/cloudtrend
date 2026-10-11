import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATING_ALLOCATION_ERRORS as errors } from "./operatingAllocation";
import { operatingAllocationServer } from "./operatingAllocation.functions";

const state = vi.hoisted(() => ({
  uid: "",
  fail: false,
  missing: false,
  anonymous: false,
  tokens: [] as string[],
  loads: [] as unknown[][],
  writes: [] as unknown[][],
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (value: unknown) => unknown) => ({
      handler: (handler: (value: { data: unknown }) => unknown) => (value: { data: unknown }) =>
        handler({ data: validate(value.data) }),
    }),
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async (token: string) => {
        state.tokens.push(token);
        return {
          error: state.fail ? { message: "secret backend detail" } : null,
          data: {
            user: state.missing
              ? null
              : {
                  id: state.uid,
                  is_anonymous: state.anonymous,
                  user_metadata: { userId: "spoofed" },
                },
          },
        };
      },
    },
  }),
}));
vi.mock("./operatingAllocation.server", () => ({
  loadOperatingAllocation: async (...args: unknown[]) => {
    state.loads.push(args);
    return { revision: 1, plan: null, authority: null, cash: null };
  },
  writeOperatingAllocation: async (...args: unknown[]) => {
    state.writes.push(args);
    return { revision: 2, plan: null, authority: null, cash: null };
  },
}));
const call = async (data: unknown) =>
  (operatingAllocationServer as unknown as (value: { data: unknown }) => Promise<unknown>)({
    data,
  });
const load = { accessToken: "synthetic-token", currency: "KRW", action: "load" };
const save = {
  accessToken: "synthetic-token",
  currency: "KRW",
  action: "save",
  expectedRevision: 1,
  requestId: "00000000-0000-4000-8000-000000000001",
  reviewConfirmed: true,
  change: { kind: "CONFIRM_PLAN" },
};
beforeEach(() => {
  state.uid = "00000000-0000-4000-8000-000000000010";
  state.fail = false;
  state.missing = false;
  state.anonymous = false;
  state.tokens = [];
  state.loads = [];
  state.writes = [];
});
describe("owner-authenticated allocation endpoint", () => {
  it("loads only the verified auth owner and selected currency", async () => {
    await call(load);
    expect(state.tokens).toEqual(["synthetic-token"]);
    expect(state.loads[0]?.slice(1)).toEqual([state.uid, "KRW"]);
    expect(state.writes).toEqual([]);
  });
  it("writes through the same authenticated owner", async () => {
    await call(save);
    expect(state.writes[0]?.[1]).toBe(state.uid);
    expect(state.writes[0]?.[2]).toEqual(save);
  });
  it("never reuses another owner's identity", async () => {
    await call(load);
    state.uid = "00000000-0000-4000-8000-000000000020";
    await call({ ...load, currency: "USD" });
    expect(state.loads.map((args) => args[1])).toEqual([
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000020",
    ]);
  });
  it.each(["fail", "missing", "anonymous"] as const)(
    "rejects %s before loading any journal",
    async (field) => {
      state[field] = true;
      await expect(call(save)).rejects.toThrow(errors.auth);
      expect(state.loads).toEqual([]);
      expect(state.writes).toEqual([]);
    },
  );
  it.each([
    { userId: "spoofed" },
    { reviewConfirmed: false },
    { actualCash: "30000000" },
    { change: { kind: "CONFIRM_PLAN", weights: [1, 0, 0] } },
  ])("rejects expanded inputs before authentication %j", async (override) => {
    await expect(call({ ...save, ...override })).rejects.toThrow(errors.input);
    expect(state.tokens).toEqual([]);
    expect(state.writes).toEqual([]);
  });
  it("does not accept client supplied signal sizing", async () => {
    await expect(
      call({
        ...save,
        change: {
          kind: "PIN_SIGNAL_BUDGET",
          market: "ETF",
          symbol: "123456",
          signalOriginDate: "2026-10-12",
          sourceDate: "2026-10-13",
          amount: "600000",
          etfWeight: "0.1",
        },
      }),
    ).rejects.toThrow(errors.input);
    expect(state.tokens).toEqual([]);
  });
});
