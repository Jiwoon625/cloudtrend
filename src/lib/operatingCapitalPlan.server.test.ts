import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CAPITAL_PLAN_ERRORS, prepareOperatingCapitalPlan } from "./operatingCapitalPlan";
import { loadOperatingCapitalPlan, writeOperatingCapitalPlan } from "./operatingCapitalPlan.server";
const state = vi.hoisted(() => ({
  row: null as { revision: number; payload: Record<string, unknown> } | null,
  reads: [] as string[],
}));
vi.mock("./ledger/websiteRepository.server", () => ({
  readWebsiteDocument: async (_: unknown, uid: string, source: string) => {
    state.reads.push(`${uid}:${source}`);
    return structuredClone(state.row);
  },
}));
const uid = "00000000-0000-4000-8000-000000000001";
const now = "2026-10-09T12:00:00Z";
const input = { action: "save" as const, expectedRevision: 9, plannedCapitalKrw: "12765432" };
function client(mode: "ok" | "conflict" | "corrupt" | "backend" = "ok") {
  const writes: {
    table: string;
    value: { revision: number; payload: Record<string, unknown> };
    filters: [string, unknown][];
  }[] = [];
  return {
    writes,
    value: {
      from(table: string) {
        let value: { revision: number; payload: Record<string, unknown> };
        const filters: [string, unknown][] = [];
        const q = {
          update(v: typeof value) {
            value = v;
            return q;
          },
          eq(k: string, v: unknown) {
            filters.push([k, v]);
            return q;
          },
          select() {
            return q;
          },
          async maybeSingle() {
            writes.push({ table, value, filters });
            if (mode === "backend") return { error: { message: "private SQL" }, data: null };
            if (
              mode === "conflict" ||
              state.row?.revision !== filters.find(([k]) => k === "revision")?.[1]
            )
              return { data: null, error: null };
            state.row = structuredClone(value);
            if (mode === "corrupt") state.row.payload["actualCapital"] = 123;
            return { data: { revision: value.revision }, error: null };
          },
        };
        return q;
      },
    } as unknown as SupabaseClient,
  };
}
beforeEach(() => {
  state.reads = [];
  state.row = {
    revision: 9,
    payload: {
      version: 1,
      settings: { initialCapital: 111, maxPositions: 30 },
      actualCapital: 123456,
      etfCapital: 345,
      executions: [{ id: "old-fill", shares: 3, price: 100 / 3 }],
      excluded: { old: "reason" },
      strategy: { old: true },
      actualPerformance: { baseline: null, observations: [] },
      unknownFutureField: { keep: true },
    },
  };
});
describe("metadata-only preparation", () => {
  it("reads missing plan without initializing anything", async () => {
    const c = client();
    expect(await loadOperatingCapitalPlan(c.value, uid)).toEqual({ revision: 9, plan: null });
    state.row = null;
    expect(await loadOperatingCapitalPlan(c.value, uid)).toEqual({ revision: null, plan: null });
    expect(c.writes).toEqual([]);
  });
  it("preview is read-only and binds to the current revision", async () => {
    const c = client(),
      before = structuredClone(state.row);
    const result = await writeOperatingCapitalPlan(
      c.value,
      uid,
      { ...input, action: "preview" },
      now,
    );
    expect(result.plan.plannedCapitalKrw).toBe("12765432");
    expect(result.revision).toBe(9);
    expect(state.row).toEqual(before);
    expect(c.writes).toEqual([]);
  });
  it("saves exactly one optional field while preserving cash, fills, baseline and unknown metadata", async () => {
    const c = client(),
      before = structuredClone(state.row!);
    const result = await writeOperatingCapitalPlan(c.value, uid, input, now);
    expect(result.revision).toBe(10);
    expect(result.reused).toBe(false);
    const { operatingCapitalPlan, ...rest } = state.row!.payload;
    expect(rest).toEqual(before.payload);
    expect(operatingCapitalPlan).toEqual(prepareOperatingCapitalPlan("12765432", now));
    expect(c.writes).toHaveLength(1);
    expect(c.writes[0]!.table).toBe("portfolio_ledgers");
    expect(c.writes[0]!.filters).toEqual([
      ["user_id", uid],
      ["revision", 9],
    ]);
    expect(state.reads).toEqual([`${uid}:portfolio_ledgers`, `${uid}:portfolio_ledgers`]);
  });
  it("same amount after fresh read is reused without rewriting the timestamp", async () => {
    const c = client();
    await writeOperatingCapitalPlan(c.value, uid, input, now);
    const result = await writeOperatingCapitalPlan(
      c.value,
      uid,
      { ...input, expectedRevision: 10, plannedCapitalKrw: "12765432.00" },
      "2026-10-10T12:00:00Z",
    );
    expect(result.reused).toBe(true);
    expect(result.plan.recordedAt).toBe("2026-10-09T12:00:00.000Z");
    expect(c.writes).toHaveLength(1);
  });
  it("does not silently replace a saved plan", async () => {
    const c = client();
    await writeOperatingCapitalPlan(c.value, uid, input, now);
    await expect(
      writeOperatingCapitalPlan(
        c.value,
        uid,
        { ...input, expectedRevision: 10, plannedCapitalKrw: "23567891" },
        now,
      ),
    ).rejects.toThrow(CAPITAL_PLAN_ERRORS.immutable);
    expect(c.writes).toHaveLength(1);
  });
  it("does not create an actual ledger to store a plan", async () => {
    state.row = null;
    const c = client();
    await expect(writeOperatingCapitalPlan(c.value, uid, input, now)).rejects.toThrow(
      CAPITAL_PLAN_ERRORS.missing,
    );
    expect(c.writes).toEqual([]);
  });
  it("rejects stale revisions before writing", async () => {
    const c = client();
    await expect(
      writeOperatingCapitalPlan(c.value, uid, { ...input, expectedRevision: 8 }, now),
    ).rejects.toThrow(CAPITAL_PLAN_ERRORS.conflict);
    expect(c.writes).toEqual([]);
  });
  it.each(["conflict", "corrupt", "backend"] as const)("fails closed on %s", async (mode) => {
    const c = client(mode);
    await expect(writeOperatingCapitalPlan(c.value, uid, input, now)).rejects.toThrow(
      mode === "conflict"
        ? CAPITAL_PLAN_ERRORS.conflict
        : mode === "corrupt"
          ? CAPITAL_PLAN_ERRORS.uncertain
          : CAPITAL_PLAN_ERRORS.generic,
    );
  });
  it("simultaneous saves can commit at most once", async () => {
    const c = client();
    const results = await Promise.allSettled([
      writeOperatingCapitalPlan(c.value, uid, input, now),
      writeOperatingCapitalPlan(c.value, uid, input, now),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(state.row!.revision).toBe(10);
  });
  it("rejects corrupted existing plan instead of overwriting it", async () => {
    state.row!.payload["operatingCapitalPlan"] = { plannedCapitalKrw: "12765432", allocation: {} };
    const c = client();
    await expect(loadOperatingCapitalPlan(c.value, uid)).rejects.toThrow(
      CAPITAL_PLAN_ERRORS.invalid,
    );
    await expect(writeOperatingCapitalPlan(c.value, uid, input, now)).rejects.toThrow(
      CAPITAL_PLAN_ERRORS.invalid,
    );
    expect(c.writes).toEqual([]);
  });
});
