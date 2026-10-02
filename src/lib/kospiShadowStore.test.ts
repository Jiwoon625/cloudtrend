import { describe, it, expect } from "vitest";
import { persistKospiShadow, shadowObjectPath, type ShadowObjectStore } from "./kospiShadowStore";
import type { KospiShadowSession } from "./engine/kospiShadow";
const uid = "00000000-0000-0000-0000-000000000001";
const session = (date = "2026-10-02", prev = "2026-10-01"): KospiShadowSession => ({
  date,
  previousSessionDate: prev,
  sourceHash: date,
  configHash: "cfg",
  codeVersion: "sha",
  sourceCollectedAt: `${date}T08:00:00Z`,
  confirmedClose: true,
  benchmarkClose: 2500,
  gate: { date, status: "NEUTRAL", issues: [] },
  rows: [],
});
function store() {
  const data = new Map<string, unknown>();
  let failLatest = false;
  const io: ShadowObjectStore = {
    read: async <T>(path: string) => structuredClone(data.get(path) ?? null) as T | null,
    latestSessionDate: async (namespace) =>
      [...data.keys()]
        .filter((path) => path.startsWith(`${namespace}/`))
        .map((path) => path.split("/").at(-1)!.replace(".json", ""))
        .sort()
        .at(-1) ?? null,
    putImmutable: async (path, value) => {
      if (data.has(path)) throw new Error("immutable collision");
      data.set(path, structuredClone(value));
    },
    putLatest: async (path, value) => {
      if (failLatest) throw new Error("upload failure");
      data.set(path, structuredClone(value));
    },
  };
  return {
    data,
    io,
    fail: (x: boolean) => {
      failLatest = x;
    },
  };
}
describe("private prospective Shadow journal", () => {
  it("writes only isolated owner paths and freezes its registry", async () => {
    const s = store();
    await persistKospiShadow(s.io, uid, session(), {});
    expect(
      [...s.data.keys()].every((x) =>
        x.startsWith(`${uid}/shadow/kospi-confirm1-bear-rsaccel-v1/`),
      ),
    ).toBe(true);
    expect(s.data.size).toBe(3);
    await expect(
      persistKospiShadow(
        s.io,
        uid,
        { ...session("2026-10-05", "2026-10-02"), configHash: "new" },
        {},
      ),
    ).rejects.toThrow(/frozen/);
  });
  it("same date rerun is idempotent; changed frozen input is rejected", async () => {
    const s = store(),
      a = await persistKospiShadow(s.io, uid, session(), {});
    const b = await persistKospiShadow(s.io, uid, session(), {});
    expect(b.reused).toBe(true);
    expect(b.view).toEqual(a.view);
    expect(s.data.size).toBe(3);
    await expect(
      persistKospiShadow(s.io, uid, { ...session(), sourceHash: "changed" }, {}),
    ).rejects.toThrow(/immutable/);
  });
  it("retries a projection failure from the original immutable daily state", async () => {
    const s = store();
    s.fail(true);
    await expect(persistKospiShadow(s.io, uid, session(), {})).rejects.toThrow("upload failure");
    expect(s.data.size).toBe(2);
    s.fail(false);
    const r = await persistKospiShadow(s.io, uid, session(), {});
    expect(r.reused).toBe(true);
    expect(r.view.history).toHaveLength(1);
    expect(r.view.latest.state.cashKrw).toBe(100_000_000);
  });
  it("never resets capital after a missing projection or missing authoritative snapshot", async () => {
    const s = store();
    await persistKospiShadow(s.io, uid, session(), {});
    s.data.delete(shadowObjectPath(uid, "latest.json"));
    await expect(
      persistKospiShadow(s.io, uid, session("2026-10-05", "2026-10-02"), {}),
    ).rejects.toThrow(/initialization/);
  });
  it("keeps history once, rejects stale past writes and missing-session advances", async () => {
    const s = store();
    await persistKospiShadow(s.io, uid, session(), {});
    await expect(
      persistKospiShadow(s.io, uid, session("2026-10-06", "2026-10-05"), {}),
    ).rejects.toThrow(/exact next session/);
    const next = await persistKospiShadow(s.io, uid, session("2026-10-05", "2026-10-02"), {});
    expect(next.view.history).toHaveLength(2);
    await expect(persistKospiShadow(s.io, uid, session(), {})).rejects.toThrow(/Past/);
  });
  it("cannot rewind after a missing cache if later immutable sessions exist", async () => {
    const s = store();
    await persistKospiShadow(s.io, uid, session(), {});
    await persistKospiShadow(s.io, uid, session("2026-10-05", "2026-10-02"), {});
    s.data.delete(shadowObjectPath(uid, "latest.json"));
    await expect(persistKospiShadow(s.io, uid, session(), {})).rejects.toThrow(/Newer immutable/);
  });
  it("retains the original code provenance when unchanged input is rerun after deployment", async () => {
    const s = store();
    await persistKospiShadow(s.io, uid, session(), {});
    const result = await persistKospiShadow(
      s.io,
      uid,
      { ...session(), codeVersion: "new-code" },
      {},
    );
    expect(result.reused).toBe(true);
    expect(result.view.latest.source.codeVersion).toBe("sha");
  });
  it("does not swap initialization input after only registry was written", async () => {
    const s = store(),
      original = s.io.putImmutable;
    s.io.putImmutable = async (path, value) => {
      if (path.includes("/sessions/")) throw new Error("snapshot failure");
      return original(path, value);
    };
    await expect(persistKospiShadow(s.io, uid, session(), {})).rejects.toThrow("snapshot failure");
    s.io.putImmutable = original;
    await expect(
      persistKospiShadow(s.io, uid, { ...session(), sourceHash: "changed" }, {}),
    ).rejects.toThrow(/froze source and code/);
    await expect(
      persistKospiShadow(s.io, uid, { ...session(), codeVersion: "changed" }, {}),
    ).rejects.toThrow(/froze source and code/);
    expect((await persistKospiShadow(s.io, uid, session(), {})).view.history).toHaveLength(1);
  });
  it("requires the prior authoritative snapshot before advancing", async () => {
    const s = store();
    await persistKospiShadow(s.io, uid, session(), {});
    s.data.delete(shadowObjectPath(uid, "sessions/2026-10-02.json"));
    await expect(
      persistKospiShadow(s.io, uid, session("2026-10-05", "2026-10-02"), {}),
    ).rejects.toThrow(/authoritative/);
  });
  it("rejects a projection altered independently from the authoritative state", async () => {
    const s = store();
    await persistKospiShadow(s.io, uid, session(), {});
    const latest = s.data.get(shadowObjectPath(uid, "latest.json")) as {
      latest: { state: { cashKrw: number } };
    };
    latest.latest.state.cashKrw = 999;
    await expect(
      persistKospiShadow(s.io, uid, session("2026-10-05", "2026-10-02"), {}),
    ).rejects.toThrow(/authoritative/);
  });
  it("rejects traversal and nonowner paths", () => {
    expect(() => shadowObjectPath("../user", "latest.json")).toThrow();
    expect(() => shadowObjectPath(uid, "../../kr.json")).toThrow();
  });
});
