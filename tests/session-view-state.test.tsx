import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.values)) {
      state.values[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      state.values[index],
      (next: unknown) => {
        state.values[index] = typeof next === "function" ? next(state.values[index]) : next;
      },
    ];
  },
}));
import {
  syncSessionViewOwner,
  readSessionViewState,
  useSessionViewState,
  viewText,
  viewPage,
  viewChoice,
} from "../src/lib/useSessionViewState";
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  state.values = [];
  state.cursor = 0;
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
      key: (i: number) => [...storage.keys()][i] ?? null,
      get length() {
        return storage.size;
      },
    },
  });
  syncSessionViewOwner("test-owner");
});
afterEach(() => vi.unstubAllGlobals());
function remount() {
  state.values = [];
  state.cursor = 0;
}
describe("tab-local navigation filter restoration", () => {
  it("restores ETF search across detail/back and a remount, and honors explicit clearing", () => {
    const [, set] = useSessionViewState("etf:query", "", viewText);
    set("0000H0");
    remount();
    const [restored, clear] = useSessionViewState("etf:query", "", viewText);
    expect(restored).toBe("0000H0");
    clear("");
    remount();
    expect(useSessionViewState("etf:query", "", viewText)[0]).toBe("");
  });
  it("keeps history dates/run keys and different page filters separate", () => {
    useSessionViewState("history:date", "", viewText)[1]("2026-10-07");
    remount();
    useSessionViewState("history:run", "", viewText)[1]("run-seven");
    remount();
    useSessionViewState("etf:page", 0, viewPage)[1](2);
    remount();
    expect(readSessionViewState("history:date", "", viewText)).toBe("2026-10-07");
    expect(readSessionViewState("history:run", "", viewText)).toBe("run-seven");
    expect(readSessionViewState("etf:page", 0, viewPage)).toBe(2);
    expect(readSessionViewState("history:page", 0, viewPage)).toBe(0);
  });
  it("preserves same-owner reload but clears logout or account switches before child views mount", () => {
    syncSessionViewOwner("owner-a");
    useSessionViewState("history:search", "", viewText)[1]("private-query");
    syncSessionViewOwner("owner-a");
    expect(readSessionViewState("history:search", "", viewText)).toBe("private-query");
    storage.set("unrelated", "keep");
    syncSessionViewOwner("owner-b");
    expect(readSessionViewState("history:search", "", viewText)).toBe("");
    expect(storage.get("unrelated")).toBe("keep");
    remount();
    useSessionViewState("etf:query", "", viewText)[1]("0000H0");
    syncSessionViewOwner(null);
    expect(readSessionViewState("etf:query", "", viewText)).toBe("");
  });
  it("rejects malformed, wrong-type, unbounded or unknown saved choices", () => {
    storage.set("cloudtrend-view-v1:a", "{invalid");
    expect(readSessionViewState("a", "", viewText)).toBe("");
    storage.set("cloudtrend-view-v1:a", JSON.stringify(-1));
    expect(readSessionViewState("a", 0, viewPage)).toBe(0);
    storage.set("cloudtrend-view-v1:a", JSON.stringify("script"));
    expect(readSessionViewState("a", "ALL", viewChoice(["ALL", "KR"]))).toBe("ALL");
  });
  it("survives denied storage and preserves functional state updates", () => {
    vi.stubGlobal("window", {
      get sessionStorage() {
        throw new Error("disabled");
      },
    });
    const [initial, set] = useSessionViewState("etf:page", 0, viewPage);
    expect(initial).toBe(0);
    expect(() => set((p) => p + 1)).not.toThrow();
    expect(state.values[0]).toBe(1);
  });
  it("does not read or write storage for callers without a persistence key", () => {
    const getItem = vi.fn(() => {
      throw new Error("must not read");
    });
    const setItem = vi.fn(() => {
      throw new Error("must not write");
    });
    vi.stubGlobal("window", { sessionStorage: { getItem, setItem } });
    const [initial, set] = useSessionViewState(undefined, 0, viewPage);
    expect(initial).toBe(0);
    set((page) => page + 1);
    expect(state.values[0]).toBe(1);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });
  it("restores the new key instead of carrying state between modes without a remount", () => {
    useSessionViewState("kr-screener:query", "", viewText)[1]("삼성");
    state.cursor = 0;
    expect(useSessionViewState("legacy-etf-screener:query", "", viewText)[0]).toBe("");
    state.cursor = 0;
    useSessionViewState("legacy-etf-screener:query", "", viewText)[1]("ETF");
    state.cursor = 0;
    expect(useSessionViewState("kr-screener:query", "", viewText)[0]).toBe("삼성");
    expect(readSessionViewState("legacy-etf-screener:query", "", viewText)).toBe("ETF");
  });
  it("resets mounted screen state on owner changes and logout", () => {
    const [, staleSetter] = useSessionViewState("kr-screener:query", "", viewText);
    staleSetter("private-query");
    syncSessionViewOwner("owner-b");
    staleSetter("old-owner-late-update");
    expect(storage.has("cloudtrend-view-v1:kr-screener:query")).toBe(false);
    state.cursor = 0;
    expect(useSessionViewState("kr-screener:query", "", viewText)[0]).toBe("");
    state.cursor = 0;
    useSessionViewState("kr-screener:query", "", viewText)[1]("owner-b-query");
    syncSessionViewOwner(null);
    state.cursor = 0;
    expect(useSessionViewState("kr-screener:query", "", viewText)[0]).toBe("");
    expect(storage.has("cloudtrend-view-v1:kr-screener:query")).toBe(false);
  });
});
