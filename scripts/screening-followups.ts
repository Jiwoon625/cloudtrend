/** Optional model failures must not prevent actual valuation or snapshot archival. */
export async function runScreeningFollowups<P, S>(callbacks: {
  refreshPortfolio: () => Promise<P>;
  replayModels: () => Promise<S>;
}) {
  const portfolioRefresh = await callbacks.refreshPortfolio().catch(() => ({
    status: "FAILED" as const,
    asOfDate: null,
    calculatedAt: null,
  }));
  const octoberShadow = await callbacks.replayModels().catch(() => ({
    deferred: { reason: "MODEL_REPLAY_FAILED" },
    status: "FAILED" as const,
  }));
  return { portfolioRefresh, octoberShadow };
}
