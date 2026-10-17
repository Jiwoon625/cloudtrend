import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  screening: vi.fn(),
  summary: vi.fn(),
  run: vi.fn(),
  session: vi.fn(),
}));
vi.mock("./cloud", () => ({ supabase: { auth: { getSession: mocks.session } } }));
vi.mock("./scoringConfigStore", () => ({ getActiveScoringConfig: () => ({}) }));
vi.mock("./screeningCache", () => ({
  readScreeningCache: mocks.screening,
  readDashboardCache: mocks.summary,
}));
vi.mock("./webScreening.functions", () => ({ runWebScreeningServer: mocks.run }));
import {
  getOrBuildScreeningPayloadServerFirst,
  getOrBuildDashboardSummaryServerFirst,
  rebuildScreeningCachesServerFirst,
} from "./webScreeningClient";

describe("page reads never authorize screening", () => {
  beforeEach(() => vi.resetAllMocks());
  it("returns saved results without engine or authentication calls", async () => {
    mocks.screening.mockResolvedValue({ payload: { analysis: "saved" } });
    mocks.summary.mockResolvedValue({ resultDigest: "saved" });
    expect(await getOrBuildScreeningPayloadServerFirst()).toEqual({ analysis: "saved" });
    expect(await getOrBuildDashboardSummaryServerFirst()).toEqual({ resultDigest: "saved" });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it("fails safely on missing or invalidated results without screening or ledger publication", async () => {
    mocks.screening.mockResolvedValue(null);
    mocks.summary.mockResolvedValue(null);
    await expect(getOrBuildScreeningPayloadServerFirst()).rejects.toThrow("저장된 결과");
    await expect(getOrBuildDashboardSummaryServerFirst()).rejects.toThrow("저장된 결과");
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("preserves explicit authenticated screening and verifies readback", async () => {
    mocks.session.mockResolvedValue({ data: { session: { access_token: "synthetic" } } });
    mocks.run.mockResolvedValue({ reused: false });
    mocks.screening.mockResolvedValue({ payload: {} });
    mocks.summary.mockResolvedValue({ resultDigest: "saved" });
    await rebuildScreeningCachesServerFirst();
    expect(mocks.run).toHaveBeenCalledOnce();
  });
});
