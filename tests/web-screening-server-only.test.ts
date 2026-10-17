import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), build: vi.fn(), raw: vi.fn() }));
vi.mock("../src/lib/cloud", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "token" } } }) },
  },
}));
vi.mock("../src/lib/scoringConfigStore", () => ({ getActiveScoringConfig: () => ({}) }));
vi.mock("../src/lib/screeningCache", () => ({
  readDashboardCache: mocks.read,
  readScreeningCache: mocks.read,
  getOrBuildDashboardSummary: mocks.raw,
  getOrBuildScreeningPayload: mocks.raw,
}));
vi.mock("../src/lib/webScreening.functions", () => ({ runWebScreeningServer: mocks.build }));
import {
  getOrBuildDashboardSummaryServerFirst,
  getOrBuildScreeningPayloadServerFirst,
} from "../src/lib/webScreeningClient";
beforeEach(() => {
  vi.resetAllMocks();
});
describe("normal page loads", () => {
  it("returns a cached dashboard without starting another calculation", async () => {
    const summary = { asOfDate: "2026-09-25" };
    mocks.read.mockResolvedValue(summary);
    expect(await getOrBuildDashboardSummaryServerFirst()).toBe(summary);
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.raw).not.toHaveBeenCalled();
  });
  it("keeps pre-reference screening readable without calculation or write-capable server calls", async () => {
    const payload = {
      analysis: {
        asOfDate: "2026-10-08",
        rows: [{ instrument: { symbol: "005930" }, snapshot: { tradeDate: "2026-10-08" } }],
      },
    };
    mocks.read.mockResolvedValue({ payload });
    expect(await getOrBuildScreeningPayloadServerFirst()).toBe(payload);
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.raw).not.toHaveBeenCalled();
  });
  it("rejects cache misses without any screening or raw-data fallback", async () => {
    mocks.read.mockResolvedValue(null);
    mocks.build.mockRejectedValue(new Error("timeout"));
    const results = await Promise.allSettled([
      getOrBuildDashboardSummaryServerFirst(),
      getOrBuildScreeningPayloadServerFirst(),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.raw).not.toHaveBeenCalled();
  });
});
