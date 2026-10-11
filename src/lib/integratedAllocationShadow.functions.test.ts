import { beforeEach, describe, expect, it, vi } from "vitest";
import { integratedAllocationShadowServer } from "./integratedAllocationShadow.functions";
const state = vi.hoisted(() => ({
  uid: "owner-a",
  anonymous: false,
  fail: false,
  reads: [] as unknown[][],
  writes: [] as unknown[][],
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (x: unknown) => unknown) => ({
      handler: (handler: (x: { data: unknown }) => unknown) => (x: { data: unknown }) =>
        handler({ data: validate(x.data) }),
    }),
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({
        error: state.fail ? new Error("backend") : null,
        data: { user: { id: state.uid, is_anonymous: state.anonymous } },
      }),
    },
  }),
}));
vi.mock("./integratedAllocationStore.server", () => ({
  readIntegratedAllocationBook: async (...args: unknown[]) => {
    state.reads.push(args);
    return {};
  },
  initializeIntegratedAllocationBook: async (...args: unknown[]) => {
    state.writes.push(args);
    return {};
  },
}));
const call = async (data: unknown) =>
  (integratedAllocationShadowServer as unknown as (x: { data: unknown }) => Promise<unknown>)({
    data,
  });
beforeEach(() => {
  state.uid = "owner-a";
  state.anonymous = false;
  state.fail = false;
  state.reads = [];
  state.writes = [];
});
describe("integrated Shadow endpoint ownership", () => {
  it("a read never initializes books and uses only verified owner", async () => {
    await call({ action: "load", accessToken: "test" });
    expect(state.reads.map((x) => x.slice(1))).toEqual([
      ["owner-a", "O1"],
      ["owner-a", "S07"],
    ]);
    expect(state.writes).toEqual([]);
    state.uid = "owner-b";
    await call({ action: "initialize", accessToken: "test", kind: "O1" });
    expect(state.writes[0]?.slice(1)).toEqual(["owner-b", "O1"]);
  });
  it.each(["anonymous", "fail"] as const)("rejects %s before storage", async (flag) => {
    state[flag] = true;
    await expect(call({ action: "initialize", accessToken: "test" })).rejects.toThrow(
      "로그인 소유자",
    );
    expect(state.writes).toEqual([]);
    expect(state.reads).toEqual([]);
  });
  it("rejects arbitrary user, strategy, reset and capital overrides", async () => {
    for (const extra of [{ userId: "other" }, { kind: "A0" }, { reset: true }, { capital: 1 }])
      await expect(call({ action: "initialize", accessToken: "test", ...extra })).rejects.toThrow();
    expect(state.writes).toEqual([]);
  });
});
