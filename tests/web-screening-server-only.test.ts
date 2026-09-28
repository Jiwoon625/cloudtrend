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
  it("deduplicates a cache miss and never falls back to downloading raw data when the server fails", async () => {
    mocks.read.mockResolvedValue(null);
    mocks.build.mockRejectedValue(new Error("timeout"));
    const results = await Promise.allSettled([
      getOrBuildDashboardSummaryServerFirst(),
      getOrBuildScreeningPayloadServerFirst(),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(mocks.build).toHaveBeenCalledTimes(1);
    expect(mocks.raw).not.toHaveBeenCalled();
  });
});
