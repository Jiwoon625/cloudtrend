import { expect, it, vi } from "vitest";
import {
  checkpointScope,
  checkpointHistoricGenerations,
  type VerifiedCheckpointBook,
} from "./checkpoint-scope";
const days = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
const H = `sha256:${"a".repeat(64)}`;
function book(last = 3): VerifiedCheckpointBook {
  const dates = days.slice(0, last);
  return {
    head: { stateHash: H, receipt: { date: dates.at(-1)! } },
    ledger: {
      markets: {
        K: { sessions: [...dates], lastSessionDate: dates.at(-1)! },
        E: { sessions: [...dates], lastSessionDate: dates.at(-1)! },
        U: { sessions: [...dates], lastSessionDate: dates.at(-1)! },
      },
    },
  };
}
function input() {
  return {
    books: { O1: book(), S07: book(4) },
    calendars: { KR: days, US: days },
    throughDate: days.at(-1)!,
  };
}
const uid = "11111111-1111-4111-8111-111111111111";
it("keeps all KR history and US earliest prior session inclusive with immutable checkpoint hashes", () => {
  const s = checkpointScope(input())!;
  expect(s.pendingDates).toEqual(days.slice(3));
  expect(s.fullKrDates).toEqual(days);
  expect(s.fullUsDates).toEqual(days.slice(2));
  expect(s.metadataOnlyUsDates).toEqual(days.slice(0, 2));
  expect(Object.isFrozen(s.checkpointHashes)).toBe(true);
});
it.each(["K", "E", "U"] as const)("rejects a hash-valid but incomplete %s grid", (market) => {
  const v = input();
  v.books.O1.ledger!.markets[market].sessions.splice(1, 1);
  expect(() => checkpointScope(v)).toThrow("session grid mismatch");
});
it("null head or empty pending scope requests full path", () => {
  const v = input();
  v.books.O1.head = null;
  expect(checkpointScope(v)).toBeNull();
  const done = input();
  done.books = { O1: book(5), S07: book(5) };
  expect(checkpointScope(done)).toBeNull();
});
it("missing or weak old US metadata requests full historical fallback", async () => {
  const s = checkpointScope(input())!;
  expect(await checkpointHistoricGenerations(s, uid, async () => null)).toBeNull();
  expect(await checkpointHistoricGenerations(s, uid, async () => ({ kind: "weak" }))).toBeNull();
});
it("probes old US only with owner scope and returns generation not invented content hash", async () => {
  const s = checkpointScope(input())!;
  const probe = vi.fn(async (path: string) => {
    expect(path.startsWith(uid + "/staging/")).toBe(true);
    return { kind: "strong" as const, objectId: "id", version: "v", etag: "e", size: 4 };
  });
  const result = await checkpointHistoricGenerations(s, uid, probe);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(Object.keys(result!)).toEqual(["US:2026-10-12", "US:2026-10-13"]);
  expect(result!["US:2026-10-12"]).not.toHaveProperty("hash");
});
it("probe failures propagate, not retry or fallback", async () => {
  const probe = vi.fn(async () => {
    throw Error("budget");
  });
  await expect(
    checkpointHistoricGenerations(checkpointScope(input())!, uid, probe),
  ).rejects.toThrow("budget");
  expect(probe).toHaveBeenCalledTimes(1);
});
