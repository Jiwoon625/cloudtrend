import { beforeEach, describe, expect, it, vi } from "vitest";
import { readScreeningArchive } from "../src/lib/screeningArchiveQuery";
import { archiveScreeningRun } from "../src/lib/screeningRunArchive";
import type { ScreeningSnapshot } from "../src/lib/screeningSnapshot";
import type { SupabaseClient } from "@supabase/supabase-js";
const fixture = vi.hoisted(() => ({
  snapshot: null as unknown,
  filters: [] as unknown[],
  writes: [] as unknown[],
}));
vi.mock("../src/lib/cloud", () => ({
  userId: async () => "owner",
  supabase: {
    from: (table: string) => {
      fixture.filters.push(table);
      const q = {
        select: () => q,
        eq: (...values: unknown[]) => {
          fixture.filters.push(values);
          return q;
        },
        maybeSingle: async () => ({
          data: fixture.snapshot ? { snapshot: fixture.snapshot } : null,
          error: null,
        }),
      };
      return q;
    },
  },
}));
const snapshot = () =>
  ({
    date: "2026-10-12",
    asOfDate: "2026-10-12",
    savedAt: "2026-10-13T00:10:00Z",
    runId: "run-one",
    market: "KR",
    strategyVersion: "v4",
    entries: [],
    marketGateStatus: "NEUTRAL",
    totalCount: 0,
    passedCount: 0,
    gradeACount: 0,
    gradeBCount: 0,
  }) as ScreeningSnapshot;
beforeEach(() => {
  fixture.snapshot = snapshot();
  fixture.filters = [];
  fixture.writes = [];
});
describe("immutable execution history", () => {
  it("accepts PostgreSQL timestamp normalization while retaining the original calculation time", async () => {
    const saved = await readScreeningArchive("run-one", "2026-10-12", "2026-10-13T00:10:00+00:00");
    expect(saved).toEqual(snapshot());
    expect(fixture.filters).toContainEqual(["user_id", "owner"]);
    expect(fixture.filters).toContainEqual(["run_id", "run-one"]);
  });
  it("rejects a different execution/date instead of replacing it with current analysis", async () => {
    await expect(
      readScreeningArchive("run-two", "2026-10-12", "2026-10-13T00:10:00Z"),
    ).rejects.toThrow("요청한 기록과");
    fixture.snapshot = null;
    await expect(
      readScreeningArchive("run-one", "2026-10-12", "2026-10-13T00:10:00Z"),
    ).rejects.toThrow("과거 실행 기록이 없습니다");
    expect(
      fixture.filters.every(
        (value) => typeof value !== "string" || value === "screening_run_archive",
      ),
    ).toBe(true);
  });
  it("accepts JSONB key reordering but rejects an existing run ID with different evidence", async () => {
    const db = {
      from: () => {
        const q = {
          upsert: async (payload: unknown, options: unknown) => {
            fixture.writes.push([payload, options]);
            return { error: null };
          },
          select: () => q,
          eq: () => q,
          single: async () => ({ data: { snapshot: fixture.snapshot }, error: null }),
        };
        return q;
      },
    } as unknown as SupabaseClient;
    fixture.snapshot = Object.fromEntries(Object.entries(snapshot()).reverse());
    await archiveScreeningRun(db, "owner", snapshot());
    expect(fixture.writes[0]).toEqual([
      expect.objectContaining({ user_id: "owner", run_id: "run-one" }),
      { onConflict: "user_id,run_id", ignoreDuplicates: true },
    ]);
    fixture.snapshot = { ...snapshot(), strategyVersion: "changed" };
    await expect(archiveScreeningRun(db, "owner", snapshot())).rejects.toThrow("재사용");
  });
});
