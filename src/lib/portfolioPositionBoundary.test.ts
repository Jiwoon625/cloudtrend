import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ actual: vi.fn(), shadow: vi.fn(), attach: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (x: unknown) => unknown) => ({
      handler: (handler: (args: { data: unknown }) => unknown) => (args: { data: unknown }) =>
        handler({ data: validate(args.data) }),
    }),
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "verified-owner" } }, error: null }) },
  }),
}));
vi.mock("./websitePositionContext.server", () => ({
  loadActualPositionContextForOwner: state.actual,
  loadWebsitePositionContextForOwner: state.shadow,
}));
vi.mock("./actualHoldingPriceExit.server", () => ({ attachActualHoldingPriceExits: state.attach }));
vi.mock("./portfolioLedgers.server", () => ({ operateLedgers: vi.fn() }));
import { portfolioPositionContextServer } from "./portfolioLedgers.functions";
it("reads only verified actual positions even when Shadow is unavailable", async () => {
  state.actual.mockResolvedValue({
    heldSymbols: ["ACTUAL"],
    lastSellDateBySymbol: { SOLD: "2026-10-16" },
    actualPools: { KRW: { positions: [] } },
  });
  state.shadow.mockRejectedValue(new Error("unavailable shadow"));
  const result = await portfolioPositionContextServer({ data: { accessToken: "synthetic" } });
  expect(result.heldSymbols).toEqual(["ACTUAL"]);
  expect(result.lastSellDateBySymbol).toEqual({ SOLD: "2026-10-16" });
  expect(state.actual).toHaveBeenCalledWith(expect.anything(), "verified-owner");
  expect(state.shadow).not.toHaveBeenCalled();
});
