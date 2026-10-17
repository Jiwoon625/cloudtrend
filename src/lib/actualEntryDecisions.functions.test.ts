import { beforeEach, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({
  uid: "verified-owner" as string | null,
  anonymous: false,
  authError: false,
  load: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (x: unknown) => unknown) => ({
      handler: (handler: (args: { data: unknown }) => unknown) => async (args: { data: unknown }) =>
        handler({ data: validate(args.data) }),
    }),
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: state.uid ? { id: state.uid, is_anonymous: state.anonymous } : null },
        error: state.authError ? {} : null,
      }),
    },
  }),
}));
vi.mock("./actualEntryDecisions.server", () => ({
  loadActualEntryDecisions: state.load,
  saveActualEntryDecision: state.save,
}));
import { actualEntryDecisionsServer } from "./actualEntryDecisions.functions";
const call = (data: unknown) =>
  (actualEntryDecisionsServer as unknown as (input: { data: unknown }) => Promise<unknown>)({
    data,
  });
beforeEach(() => {
  vi.clearAllMocks();
  state.uid = "verified-owner";
  state.anonymous = false;
  state.authError = false;
});
it("uses only the authenticated owner for reads", async () => {
  await call({ action: "load", accessToken: "test" });
  expect(state.load).toHaveBeenCalledWith(expect.anything(), "verified-owner");
  expect(state.save).not.toHaveBeenCalled();
});
it.each(["missing", "anonymous", "expired"])("denies %s before data access", async (mode) => {
  if (mode === "missing") state.uid = null;
  if (mode === "anonymous") state.anonymous = true;
  if (mode === "expired") state.authError = true;
  await expect(call({ action: "load", accessToken: "test" })).rejects.toThrow(/로그인/);
  expect(state.load).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
});
it("rejects owner override", async () => {
  await expect(call({ action: "load", accessToken: "test", userId: "other" })).rejects.toThrow();
  expect(state.load).not.toHaveBeenCalled();
});
it("writes decisions only, accepting no fill or Shadow fields", async () => {
  const command = {
    action: "set",
    id: "11111111-1111-4111-8111-111111111111",
    market: "US",
    symbol: "TEST",
    name: "Synthetic",
    signalOriginDate: "2026-10-16",
    reason: "독립성 제한",
    scope: "symbol",
    note: "",
  };
  await call({ action: "save", accessToken: "test", expectedRevision: 0, command });
  expect(state.save).toHaveBeenCalledWith(expect.anything(), "verified-owner", command, 0);
  await expect(
    call({
      action: "save",
      accessToken: "test",
      expectedRevision: 0,
      command: { ...command, shadow: true },
    }),
  ).rejects.toThrow();
  expect(state.save).toHaveBeenCalledTimes(1);
});
