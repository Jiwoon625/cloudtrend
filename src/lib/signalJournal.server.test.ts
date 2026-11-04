import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ruleAt, type SignalRule } from "./signalJournal";
import { signalRules, recordSignal, signalSessionCalendar } from "./signalJournal.server";
import type { ScreeningSnapshot } from "./screeningSnapshot";
const archive = vi.hoisted(() => vi.fn());
vi.mock("./usScreeningRunArchive", () => ({ archiveUsScreeningRun: archive }));
let objects: Map<string, string>;
let client: SupabaseClient;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T23:00:00Z"));
  archive.mockReset();
  objects = new Map();
  client = {
    storage: {
      from: () => ({
        download: async (path: string) =>
          objects.has(path)
            ? { data: new Blob([objects.get(path)!]), error: null }
            : { data: null, error: { message: "Object not found" } },
        upload: async (path: string, body: Blob, options: { upsert: boolean }) => {
          if (objects.has(path) && !options.upsert)
            return { error: { message: "The resource already exists" } };
          objects.set(path, await body.text());
          return { error: null };
        },
        list: async (root: string, { offset, limit }: { offset: number; limit: number }) => ({
          data: [...objects.keys()]
            .filter((p) => p.startsWith(root + "/"))
            .sort()
            .slice(offset, offset + limit)
            .map((p) => ({ name: p.slice(root.length + 1) })),
          error: null,
        }),
      }),
    },
  } as unknown as SupabaseClient;
});
afterEach(() => vi.useRealTimers());
it("freezes config/code identity, activates changes prospectively, and retains prior versions", async () => {
  const first = await signalRules(
    client,
    "owner",
    "KR",
    "v1",
    { threshold: 8 },
    "2026-11-04T01:00:00Z",
  );
  const retry = await signalRules(
    client,
    "owner",
    "KR",
    "v1",
    { threshold: 8 },
    "2026-11-05T01:00:00Z",
  );
  expect(retry.rules).toHaveLength(1);
  const next = await signalRules(
    client,
    "owner",
    "KR",
    "v2",
    { threshold: 9 },
    "2026-11-06T01:00:00Z",
  );
  expect(next.rules).toHaveLength(2);
  expect(ruleAt(next.rules, "2026-11-05")?.id).toBe(first.currentRuleId);
  expect(ruleAt(next.rules, "2026-11-06")?.id).toBe(next.currentRuleId);
  expect(ruleAt(next.rules, "2026-11-03")).toBeUndefined();
});
it("retries archive failures from the exact original record without rewriting signals/source or observation time", async () => {
  const { rules } = await signalRules(client, "owner", "KR", "v1", { threshold: 8 });
  const rule = rules[0]!;
  const snap = {
    asOfDate: "2026-11-04",
    date: "2026-11-04",
    savedAt: "2026-11-04T10:00:00Z",
    entries: [],
  } as unknown as ScreeningSnapshot;
  archive.mockRejectedValueOnce(new Error("archive unavailable"));
  await expect(
    recordSignal(client, "owner", "KR", snap, rule, "original", "OBSERVED"),
  ).rejects.toThrow("archive unavailable");
  vi.setSystemTime(new Date("2026-11-07T23:00:00Z"));
  const saved = await recordSignal(
    client,
    "owner",
    "KR",
    { ...snap, savedAt: "changed" },
    rule,
    "revised",
    "RECONSTRUCTED",
  );
  expect(saved.savedAt).toBe(snap.savedAt);
  expect(saved.signalJournal.sourceHash).toBe("original");
  expect(saved.signalJournal.kind).toBe("OBSERVED");
  expect(saved.signalJournal.recordedAt).toBe("2026-11-06T23:00:00.000Z");
  expect(archive).toHaveBeenLastCalledWith(client, "owner", saved);
});
it("does not count weekends or sessions that have not closed as missing signals", async () => {
  expect(await signalSessionCalendar("KR", "2026-11-04", new Date("2026-11-05T01:00:00Z"))).toEqual(
    ["2026-11-04"],
  );
  expect(await signalSessionCalendar("US", "2026-11-04", new Date("2026-11-08T23:00:00Z"))).toEqual(
    ["2026-11-04", "2026-11-05", "2026-11-06"],
  );
});
it("never chooses a future rule for an earlier session", () => {
  const rules = [
    { effectiveFrom: "2026-11-10", registeredAt: "2026-11-10T01:00:00Z", id: "future" },
  ] as SignalRule[];
  expect(ruleAt(rules, "2026-11-09")).toBeUndefined();
});

it("keeps journal files inside the authenticated owner screening results policy", async () => {
  const { rules } = await signalRules(client, "owner", "KR", "v1", {});
  await recordSignal(
    client,
    "owner",
    "KR",
    {
      asOfDate: "2026-11-04",
      date: "2026-11-04",
      savedAt: "2026-11-04T10:00:00Z",
      entries: [],
    } as unknown as ScreeningSnapshot,
    rules[0]!,
    "s",
    "OBSERVED",
  );
  expect(
    [...objects.keys()].every((path) => path.startsWith("owner/results/screening/signal-journal/")),
  ).toBe(true);
});

it("scheduled screening can load the last chosen config rather than resetting to defaults", async () => {
  const { latestSignalConfig } = await import("./signalJournal.server");
  await signalRules(client, "owner", "KR", "v1", { threshold: 8 }, "2026-11-04T01:00:00Z");
  await signalRules(client, "owner", "KR", "v1", { threshold: 9 }, "2026-11-05T01:00:00Z");
  expect(await latestSignalConfig(client, "owner")).toEqual({ threshold: 9 });
});

it("past special-hours sessions do not block all subsequent signal history", async () => {
  const dates = await signalSessionCalendar("KR", "2026-11-19", new Date("2026-11-20T01:00:00Z"));
  expect(dates).toContain("2026-11-19");
  expect(dates).not.toContain("2026-11-20");
});
