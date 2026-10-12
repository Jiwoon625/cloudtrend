import { expect, it, vi } from "vitest";
import type { ScreeningSnapshot } from "./screeningSnapshot";
import {
  DASHBOARD_CACHE_VERSION,
  INSTRUMENT_CACHE_VERSION,
  SCREENING_CACHE_VERSION,
} from "./screeningCacheContract";

const fixture = vi.hoisted(() => ({ value: null as unknown, tables: [] as string[] }));
vi.mock("./cloud", () => ({
  userId: async () => "fixture-owner",
  supabase: {
    from: (table: string) => {
      fixture.tables.push(table);
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: { snapshot: fixture.value }, error: null }),
      };
      return query;
    },
  },
}));
import { readScreeningArchive } from "./screeningArchiveQuery";

it("invalidates all three live calculation caches with the reviewed reference-display revision", () => {
  expect([SCREENING_CACHE_VERSION, DASHBOARD_CACHE_VERSION, INSTRUMENT_CACHE_VERSION]).toEqual([
    "screening-cache-v8-krx-review-reference-20261012-v1",
    "dashboard-cache-v8-krx-review-reference-20261012-v1",
    "instrument-cache-v8-krx-review-reference-20261012-v1",
  ]);
});

it.each(["frozen-run", ""])(
  "reads original stored membership-era priority through history identity %s",
  async (runId) => {
    fixture.tables = [];
    const snapshot = {
      asOfDate: "2026-10-08",
      date: "2026-10-08",
      savedAt: "2026-10-09T00:00:00Z",
      ...(runId ? { runId } : {}),
      entries: [{ symbol: "033340", priorityPoints: 4.5 }],
    } as ScreeningSnapshot;
    fixture.value = snapshot;
    const restored = await readScreeningArchive(runId, snapshot.asOfDate, snapshot.savedAt);
    expect(restored).toBe(snapshot);
    expect(restored.entries[0]!.priorityPoints).toBe(4.5);
    expect(fixture.tables).toEqual([runId ? "screening_run_archive" : "screening_history"]);
  },
);

it("fails closed if a date-only representative was replaced, without substituting current results", async () => {
  fixture.value = { asOfDate: "2026-10-08", savedAt: "2026-10-11T00:00:00Z", entries: [] };
  await expect(readScreeningArchive("", "2026-10-08", "2026-10-09T00:00:00Z")).rejects.toThrow(
    "최신 결과로 대체하지 않습니다",
  );
});
