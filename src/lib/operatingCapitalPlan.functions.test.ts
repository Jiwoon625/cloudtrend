import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPITAL_PLAN_ERRORS, prepareOperatingCapitalPlan } from "./operatingCapitalPlan";
import {
  operatingCapitalPlanServer,
  type OperatingCapitalPlanResponse,
} from "./operatingCapitalPlan.functions";
const A = "00000000-0000-4000-8000-000000000001",
  B = "00000000-0000-4000-8000-000000000002";
const state = vi.hoisted(() => ({
  uid: "",
  authError: false,
  missingUser: false,
  reads: [] as string[],
  writes: [] as { uid: string; revision: number }[],
  rows: {} as Record<string, { revision: number; payload: Record<string, unknown> }>,
  authTokens: [] as string[],
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (x: unknown) => unknown) => ({
      handler: (handle: (x: { data: unknown }) => unknown) => (x: { data: unknown }) =>
        handle({ data: validate(x.data) }),
    }),
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async (token: string) => {
        state.authTokens.push(token);
        return {
          data: {
            user: state.missingUser
              ? null
              : { id: state.uid, user_metadata: { userId: "spoofed" } },
          },
          error: state.authError ? { message: "private credential" } : null,
        };
      },
    },
    rpc: async (name: string, args: { p_user_id: string; p_source_system: string }) => {
      state.reads.push(`${name}:${args.p_user_id}:${args.p_source_system}`);
      const row = state.rows[args.p_user_id];
      return {
        data: row
          ? structuredClone({
              ...row,
              integrityValid: true,
              events: [],
              sourceIdentities: [],
              securities: [],
            })
          : null,
        error: null,
      };
    },
    from: (table: string) => {
      let value: { revision: number; payload: Record<string, unknown> },
        uid = "",
        revision = 0;
      const q = {
        update(v: typeof value) {
          value = v;
          return q;
        },
        eq(k: string, v: unknown) {
          if (k === "user_id") uid = String(v);
          else if (k === "revision") revision = Number(v);
          return q;
        },
        select() {
          return q;
        },
        async maybeSingle() {
          if (
            table !== "portfolio_ledgers" ||
            uid !== state.uid ||
            state.rows[uid]?.revision !== revision
          )
            return { data: null, error: null };
          state.writes.push({ uid, revision });
          state.rows[uid] = structuredClone(value);
          return { data: { revision: value.revision }, error: null };
        },
      };
      return q;
    },
  }),
}));
const call = async (data: unknown) =>
  (
    operatingCapitalPlanServer as unknown as (args: {
      data: unknown;
    }) => Promise<OperatingCapitalPlanResponse>
  )({ data });
const accessToken = "synthetic-not-a-credential";
const change = {
  accessToken,
  action: "save",
  expectedRevision: 9,
  plannedCapitalKrw: "12765432",
  reviewConfirmed: true,
};
beforeEach(() => {
  state.uid = A;
  state.authError = false;
  state.missingUser = false;
  state.reads = [];
  state.writes = [];
  state.authTokens = [];
  state.rows = {
    [A]: {
      revision: 9,
      payload: { executions: [], actualCapital: 55, actualPerformance: { baseline: null } },
    },
    [B]: {
      revision: 3,
      payload: {
        executions: [],
        actualCapital: 77,
        operatingCapitalPlan: prepareOperatingCapitalPlan("700", "2026-10-09T12:00:00Z"),
      },
    },
  };
});
describe("owner authenticated planning endpoint", () => {
  it("loads no fabricated default and uses only the verified user", async () => {
    const result = await call({ accessToken, action: "load" });
    expect(result).toEqual({ action: "load", revision: 9, plan: null });
    expect(state.reads).toEqual([`ledger_read_website_document:${A}:portfolio_ledgers`]);
    expect(state.authTokens).toEqual([accessToken]);
    expect(state.writes).toEqual([]);
  });
  it("preview never writes and never creates an actual baseline", async () => {
    const before = structuredClone(state.rows);
    const { reviewConfirmed: _, ...preview } = change;
    const result = await call({ ...preview, action: "preview" });
    expect(result.plan?.plannedCapitalKrw).toBe("12765432");
    expect(state.rows).toEqual(before);
    expect(state.writes).toEqual([]);
  });
  it("save changes only the authenticated owner's optional plan", async () => {
    const beforeA = structuredClone(state.rows[A]),
      beforeB = structuredClone(state.rows[B]);
    const result = await call(change);
    expect(result.action).toBe("save");
    expect(result.revision).toBe(10);
    const { operatingCapitalPlan: _, ...rest } = state.rows[A]!.payload;
    expect(rest).toEqual(beforeA!.payload);
    expect(state.rows[B]).toEqual(beforeB);
    expect(state.writes).toEqual([{ uid: A, revision: 9 }]);
  });
  it("different authenticated owner reads only its own saved plan", async () => {
    state.uid = B;
    const result = await call({ accessToken, action: "load" });
    expect(result.plan?.plannedCapitalKrw).toBe("700");
    expect(result.revision).toBe(3);
    expect(state.reads.every((x) => x.includes(B))).toBe(true);
    expect(state.writes).toEqual([]);
  });
  it.each(["authError", "missingUser"] as const)("rejects %s before data access", async (key) => {
    state[key] = true;
    await expect(call(change)).rejects.toThrow(CAPITAL_PLAN_ERRORS.auth);
    expect(state.reads).toEqual([]);
    expect(state.writes).toEqual([]);
  });
  it.each([
    { userId: B },
    { owner: B },
    { actualCapital: "12765432" },
    { allocation: { KR: "1" } },
    { action: "confirmBaseline" },
    { reviewConfirmed: false },
  ])("refuses spoofed or expanded request %j before auth", async (override) => {
    await expect(call({ ...change, ...override })).rejects.toThrow(CAPITAL_PLAN_ERRORS.input);
    expect(state.authTokens).toEqual([]);
    expect(state.writes).toEqual([]);
  });
  it("rejects a stale save after a concurrent metadata edit", async () => {
    state.rows[A]!.revision++;
    await expect(call(change)).rejects.toThrow(CAPITAL_PLAN_ERRORS.conflict);
    expect(state.writes).toEqual([]);
  });
  it("does not initialize missing owner ledgers", async () => {
    delete state.rows[A];
    expect((await call({ accessToken, action: "load" })).revision).toBeNull();
    await expect(call(change)).rejects.toThrow(CAPITAL_PLAN_ERRORS.missing);
    expect(state.writes).toEqual([]);
  });
});
