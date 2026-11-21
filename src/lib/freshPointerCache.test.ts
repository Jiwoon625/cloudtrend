import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FRESH_POINTER_TTL_MS,
  readFreshPointerOnce,
  resetFreshPointerCache,
} from "./freshPointerCache";

beforeEach(() => {
  vi.useFakeTimers();
  resetFreshPointerCache();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("fresh pointer reuse", () => {
  it("reads one pointer once per short window and re-reads after it", async () => {
    const read = vi.fn(async () => ({ value: 1 }));
    expect(await readFreshPointerOnce("owner:head", read)).toEqual({ value: 1 });
    expect(await readFreshPointerOnce("owner:head", read)).toEqual({ value: 1 });
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FRESH_POINTER_TTL_MS + 1);
    await readFreshPointerOnce("owner:head", read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight read between simultaneous requests", async () => {
    let release: (value: string) => void = () => undefined;
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const first = readFreshPointerOnce("owner:head", read);
    const second = readFreshPointerOnce("owner:head", read);
    release("loaded");
    expect(await first).toBe("loaded");
    expect(await second).toBe("loaded");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("remembers a missing object so the 404 round trip is not repeated", async () => {
    const read = vi.fn(async () => null);
    await expect(readFreshPointerOnce("owner:missing", read)).resolves.toBeNull();
    await expect(readFreshPointerOnce("owner:missing", read)).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
