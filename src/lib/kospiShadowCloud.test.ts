import { describe, expect, it, vi } from "vitest";
import { loadKospiShadowFromReader } from "./kospiShadowCloud";
import type { KospiShadowView } from "./kospiShadowStore";
import type { KospiShadowSnapshot } from "./engine/kospiShadow";
import { hashSeriesValue } from "./ledger/modelSeries";
import {
  createShadowRevisionFixture,
  SHADOW_TEST_UID,
  SHADOW_TEST_ROOT,
  SHADOW_TEST_REVISION_ROOT,
} from "../../tests/fixtures/kospiShadowRevision";
vi.mock("./cloud", () => ({
  ownerPath: async (suffix: string) => `00000000-0000-0000-0000-000000000001/${suffix}`,
  readObject: vi.fn(),
}));
type Fixture = Awaited<ReturnType<typeof createShadowRevisionFixture>>;
const CONTROLS = ["revision.json", "registry.json", "latest.json"] as const;
function reader(f: Fixture) {
  const seen: string[] = [];
  const read = async <T>(relativePath: string): Promise<T | null> => {
    seen.push(relativePath);
    return f.read<T>(`${SHADOW_TEST_UID}/${relativePath}`);
  };
  return { read, seen };
}
function get<T>(f: Fixture, path: string): T {
  const value = f.data.get(path);
  if (value === undefined) throw new Error(`missing fixture: ${path}`);
  return structuredClone(value) as T;
}
function removeControls(f: Fixture) {
  for (const suffix of CONTROLS) f.data.delete(`${SHADOW_TEST_REVISION_ROOT}/${suffix}`);
}
function replaceLineage(f: Fixture, patch: Record<string, unknown>) {
  const lineage = {
    ...get<Record<string, unknown>>(f, `${SHADOW_TEST_REVISION_ROOT}/revision.json`),
    ...patch,
  };
  f.data.set(`${SHADOW_TEST_REVISION_ROOT}/revision.json`, structuredClone(lineage));
  const registry = get<Record<string, unknown>>(f, `${SHADOW_TEST_REVISION_ROOT}/registry.json`);
  registry["revision"] = structuredClone(lineage);
  f.data.set(`${SHADOW_TEST_REVISION_ROOT}/registry.json`, registry);
  const view = get<KospiShadowView>(f, `${SHADOW_TEST_REVISION_ROOT}/latest.json`);
  (view.registry as unknown as { revision: unknown }).revision = structuredClone(lineage);
  f.data.set(`${SHADOW_TEST_REVISION_ROOT}/latest.json`, view);
}
describe("read-only KOSPI Shadow correction selection", () => {
  it("prefers complete validated correction without writes", async () => {
    const f = await createShadowRevisionFixture(),
      before = f.bytes();
    expect(await loadKospiShadowFromReader(reader(f).read)).toEqual(f.correctedView);
    expect(f.bytes()).toBe(before);
  });
  it("falls back only when all correction control objects are absent", async () => {
    const f = await createShadowRevisionFixture();
    removeControls(f);
    const before = f.bytes();
    expect(await loadKospiShadowFromReader(reader(f).read)).toEqual(f.original);
    expect(f.bytes()).toBe(before);
  });
  it.each([1, 2, 3, 4, 5, 6])(
    "rejects partial correction mask %i without fallback",
    async (mask) => {
      const f = await createShadowRevisionFixture();
      for (const [index, suffix] of CONTROLS.entries())
        if (!(mask & (1 << index))) f.data.delete(`${SHADOW_TEST_REVISION_ROOT}/${suffix}`);
      const before = f.bytes();
      await expect(loadKospiShadowFromReader(reader(f).read)).rejects.toThrow();
      expect(f.bytes()).toBe(before);
    },
  );
  it("returns null for uninitialized store", async () => {
    const read = async <T>(): Promise<T | null> => null;
    expect(await loadKospiShadowFromReader(read)).toBeNull();
  });
  it("does not hide an original registry with missing latest", async () => {
    const f = await createShadowRevisionFixture();
    removeControls(f);
    f.data.delete(`${SHADOW_TEST_ROOT}/latest.json`);
    const before = f.bytes();
    await expect(loadKospiShadowFromReader(reader(f).read)).rejects.toThrow();
    expect(f.bytes()).toBe(before);
  });
  it("rejects malformed correction metadata", async () => {
    const f = await createShadowRevisionFixture();
    f.data.set(`${SHADOW_TEST_REVISION_ROOT}/revision.json`, { revisionId: "../escape" });
    const before = f.bytes();
    await expect(loadKospiShadowFromReader(reader(f).read)).rejects.toThrow();
    expect(f.bytes()).toBe(before);
  });
  it("explicit original mode bypasses invalid correction metadata", async () => {
    const f = await createShadowRevisionFixture();
    f.data.set(`${SHADOW_TEST_REVISION_ROOT}/revision.json`, { invalid: true });
    const before = f.bytes(),
      { read, seen } = reader(f);
    expect(await loadKospiShadowFromReader(read, true)).toEqual(f.original);
    expect(seen.every((path) => !path.includes("/revisions/"))).toBe(true);
    expect(f.bytes()).toBe(before);
  });
  it("propagates read failures instead of treating as absence", async () => {
    const f = await createShadowRevisionFixture(),
      base = reader(f).read;
    const read = async <T>(path: string): Promise<T | null> => {
      if (path.endsWith("/revision.json")) throw new Error("synthetic read failure");
      return base<T>(path);
    };
    const before = f.bytes();
    await expect(loadKospiShadowFromReader(read)).rejects.toThrow("synthetic read failure");
    expect(f.bytes()).toBe(before);
  });
  it.each(["expectedPredecessorHash", "expectedOriginalTargetHash", "parentRegistryHash"])(
    "binds copied %s to original artifacts",
    async (field) => {
      const f = await createShadowRevisionFixture();
      replaceLineage(f, { [field]: await hashSeriesValue({ fixture: "wrong-binding", field }) });
      const before = f.bytes();
      await expect(loadKospiShadowFromReader(reader(f).read)).rejects.toThrow();
      expect(f.bytes()).toBe(before);
    },
  );
  it.each(["2026-10-02", "2026-10-13"])("rejects altered inherited snapshot %s", async (date) => {
    const f = await createShadowRevisionFixture(),
      path = `${SHADOW_TEST_REVISION_ROOT}/sessions/${date}.json`,
      changed = get<KospiShadowSnapshot>(f, path);
    changed.state.cashKrw += 1;
    f.data.set(path, changed);
    const before = f.bytes();
    await expect(loadKospiShadowFromReader(reader(f).read)).rejects.toThrow();
    expect(f.bytes()).toBe(before);
  });
  it("rejects target that mismatches projection", async () => {
    const f = await createShadowRevisionFixture(),
      path = `${SHADOW_TEST_REVISION_ROOT}/sessions/2026-10-14.json`,
      changed = get<KospiShadowSnapshot>(f, path);
    changed.state.cashKrw += 1;
    f.data.set(path, changed);
    const before = f.bytes();
    await expect(loadKospiShadowFromReader(reader(f).read)).rejects.toThrow();
    expect(f.bytes()).toBe(before);
  });
  it.each(["history", "recentTrades", "tradeHistoryTruncated"] as const)(
    "rejects altered projection %s",
    async (field) => {
      const f = await createShadowRevisionFixture(),
        path = `${SHADOW_TEST_REVISION_ROOT}/latest.json`,
        changed = get<KospiShadowView>(f, path);
      if (field === "history") changed.history[0]!.navKrw += 1;
      else if (field === "recentTrades") {
        expect(changed.recentTrades.length).toBeGreaterThan(0);
        changed.recentTrades = [];
      } else changed.tradeHistoryTruncated = !changed.tradeHistoryTruncated;
      f.data.set(path, changed);
      const before = f.bytes();
      await expect(loadKospiShadowFromReader(reader(f).read)).rejects.toThrow();
      expect(f.bytes()).toBe(before);
    },
  );
});
