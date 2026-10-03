import { beforeEach, expect, test, vi } from "vitest";

const cloud = vi.hoisted(() => ({
  rows: [] as { snapshot: { asOfDate: string } }[],
  limits: [] as number[],
  mutations: vi.fn(),
}));

vi.mock("@/lib/cloud", () => ({
  userId: vi.fn(async () => "synthetic-owner"),
  supabase: {
    from: vi.fn((table: string) => {
      expect(table).toBe("screening_history");
      return {
        delete: cloud.mutations,
        upsert: cloud.mutations,
        select: (columns: string) => {
          expect(columns).toBe("snapshot");
          return {
            order: (column: string, options: { ascending: boolean }) => {
              expect(column).toBe("date");
              expect(options.ascending).toBe(false);
              return {
                limit: async (count: number) => {
                  cloud.limits.push(count);
                  return { data: cloud.rows.slice(0, count), error: null };
                },
              };
            },
          };
        },
      };
    }),
  },
}));

import { hydrateSnapshots, loadSnapshots } from "../src/lib/screeningHistory";

beforeEach(() => {
  cloud.rows = Array.from({ length: 120 }, (_, i) => ({
    snapshot: {
      asOfDate: new Date(Date.UTC(2026, 9, 1 - i)).toISOString().slice(0, 10),
    },
  }));
  cloud.limits = [];
  cloud.mutations.mockClear();
});

test("display still reads only the newest 90 dates without deleting older records", async () => {
  const original = JSON.stringify(cloud.rows);
  await hydrateSnapshots();
  expect(cloud.limits).toEqual([90]);
  expect(loadSnapshots()).toEqual(cloud.rows.slice(0, 90).map((row) => row.snapshot));
  expect(JSON.stringify(cloud.rows)).toBe(original);
  expect(cloud.rows).toHaveLength(120);
  expect(cloud.mutations).not.toHaveBeenCalled();
});

test("repeat refresh remains a bounded read and does not trim retained history", async () => {
  await hydrateSnapshots();
  await hydrateSnapshots();
  expect(cloud.limits).toEqual([90, 90]);
  expect(loadSnapshots()).toHaveLength(90);
  expect(cloud.rows).toHaveLength(120);
  expect(cloud.mutations).not.toHaveBeenCalled();
});
