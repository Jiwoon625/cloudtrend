import { describe, it, expect, vi } from "vitest";
import { runScreeningFollowups } from "./screening-followups";
describe("screening follow-up isolation", () => {
  it("refreshes actual marks before a broken model and reports the blocked model", async () => {
    const order: string[] = [];
    const result = await runScreeningFollowups({
      refreshPortfolio: async () => {
        order.push("actual");
        return { status: "REFRESHED" };
      },
      replayModels: async () => {
        order.push("model");
        throw new Error("private source details");
      },
    });
    expect(order).toEqual(["actual", "model"]);
    expect(result.portfolioRefresh.status).toBe("REFRESHED");
    expect(result.octoberShadow).toEqual({
      status: "FAILED",
      deferred: { reason: "MODEL_REPLAY_FAILED" },
    });
    expect(JSON.stringify(result)).not.toContain("private source details");
  });
  it("preserves successful model results when actual refresh fails without retrying either writer", async () => {
    const refreshPortfolio = vi.fn().mockRejectedValue(new Error("failed"));
    const replayModels = vi.fn().mockResolvedValue({ deferred: null, processed: ["existing"] });
    const result = await runScreeningFollowups({ refreshPortfolio, replayModels });
    expect(result.portfolioRefresh.status).toBe("FAILED");
    expect(result.octoberShadow).toEqual({ deferred: null, processed: ["existing"] });
    expect(refreshPortfolio).toHaveBeenCalledTimes(1);
    expect(replayModels).toHaveBeenCalledTimes(1);
  });
});
