import { afterEach, describe, expect, it, vi } from "vitest";
import { PORTFOLIO_SYNC_TIMEOUT_MESSAGE, waitForPortfolioSync } from "./portfolioSyncRequest";

afterEach(() => vi.useRealTimers());

describe("bounded explicit portfolio synchronization", () => {
  it("returns the canonical result and clears the timer without retrying", async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => ({ revision: 3 }));
    await expect(waitForPortfolioSync(sync)).resolves.toEqual({ revision: 3 });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an uncertain result at the deadline without replaying or pretending to abort", async () => {
    vi.useFakeTimers();
    let finish: (value: { revision: number }) => void = () => undefined;
    const sync = vi.fn(
      () =>
        new Promise<{ revision: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const result = waitForPortfolioSync(sync, 100);
    const rejection = expect(result).rejects.toThrow(PORTFOLIO_SYNC_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    finish({ revision: 4 });
    await vi.runAllTimersAsync();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves request failures with no timeout or retry", async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => {
      throw new Error("synthetic request failure");
    });
    await expect(waitForPortfolioSync(sync)).rejects.toThrow("synthetic request failure");
    expect(sync).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
