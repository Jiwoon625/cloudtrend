import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  listScreeningArchive,
  readScreeningArchive,
  screeningArchiveQueryOptions,
} from "../src/lib/screeningArchiveQuery";
import { archiveScreeningRun } from "../src/lib/screeningRunArchive";
import type { ScreeningSnapshot } from "../src/lib/screeningSnapshot";
import type { SupabaseClient } from "@supabase/supabase-js";
const fixture = vi.hoisted(() => ({
  snapshot: null as unknown,
  us: null as Record<string, unknown> | null,
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
        order: () => q,
        limit: async () => ({
          data: table === "us_screening_history" ? (fixture.us ? [fixture.us] : []) : [],
          error: null,
        }),
        maybeSingle: async () => ({
          data:
            table === "us_screening_history"
              ? fixture.us
              : fixture.snapshot
                ? { snapshot: fixture.snapshot }
                : null,
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
  fixture.us = null;
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

describe("US daily history bridge", () => {
  const record = {
    date: "2026-10-07",
    data_hash: "original-hash",
    rule_version: "original-version",
    created_at: "2026-10-08T02:35:30Z",
    signals: [
      {
        symbol: "TEST",
        name: "Test",
        coreRank: 0.95,
        betaRank: 0.92,
        tkRank: 0.85,
        a0Entry: true,
        a2Exit: true,
        b3Entry: false,
      },
    ],
  };
  it("lists and reads original US signals without synthesizing missing evidence", async () => {
    fixture.us = record;
    const listed = await listScreeningArchive(record.date);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      market: "US",
      dataHash: record.data_hash,
      strategyVersion: record.rule_version,
      storedAt: record.created_at,
    });
    const saved = await readScreeningArchive("", record.date, record.created_at, {
      market: "US",
      strategyVersion: record.rule_version,
      dataHash: record.data_hash,
    });
    expect(saved.runId).toBeUndefined();
    expect(saved.entries[0]?.evidence).toEqual(record.signals[0]);
    expect(saved.entries[0]?.evidence).not.toHaveProperty("rawOnset");
    expect(saved.entries[0]?.evidence).not.toHaveProperty("eligibleBase");
    expect(fixture.filters).toContainEqual(["user_id", "owner"]);
  });
  it.each([{ strategyVersion: "recomputed-version" }, { dataHash: "replaced-input" }])(
    "rejects a replaced US record instead of resolving to latest analysis",
    async (changed) => {
      fixture.us = record;
      await expect(
        readScreeningArchive("", record.date, record.created_at, {
          market: "US",
          strategyVersion: record.rule_version,
          dataHash: record.data_hash,
          ...changed,
        }),
      ).rejects.toThrow("요청한 기록과");
    },
  );
  it("reuses a list snapshot in detail while rejecting changed archive identity", async () => {
    fixture.us = record;
    const client = new QueryClient();
    const listed = (await listScreeningArchive(record.date))[0]!;
    fixture.filters = [];
    const first = await client.fetchQuery(screeningArchiveQueryOptions(listed));
    const detail = await client.fetchQuery(
      screeningArchiveQueryOptions({
        runId: "",
        asOfDate: record.date,
        savedAt: record.created_at,
        market: "US",
        strategyVersion: record.rule_version,
        dataHash: record.data_hash,
      }),
    );
    expect(detail).toBe(first);
    expect(fixture.filters.filter((value) => value === "us_screening_history")).toHaveLength(1);
    await expect(
      client.fetchQuery(
        screeningArchiveQueryOptions({
          ...listed,
          dataHash: "replaced-input",
        }),
      ),
    ).rejects.toThrow("요청한 기록과");
    expect(fixture.filters.filter((value) => value === "us_screening_history")).toHaveLength(2);
    client.clear();
  });
  it("keeps different markets and strategy signals distinct", async () => {
    const { usHistorySnapshot, historyRecordKey, usHistorySignals } =
      await import("../src/lib/usScreeningHistory");
    const us = usHistorySnapshot(record);
    expect(historyRecordKey(us)).not.toEqual(historyRecordKey({ ...us, market: "KR" }));
    expect(usHistorySignals(us.entries[0]!, "A0").entries).toEqual(["A0"]);
    expect(usHistorySignals(us.entries[0]!, "A2").exits).toEqual(["A2"]);
    expect(usHistorySignals(us.entries[0]!, "B3").entries).toEqual([]);
    expect(usHistorySignals(us.entries[0]!).onset).toBeUndefined();
  });
});
