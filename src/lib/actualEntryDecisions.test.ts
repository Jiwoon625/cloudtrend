import { describe, it, expect } from "vitest";
import {
  activeEntryDecisions,
  applyEntryCommand,
  emptyEntryDecisions,
  findEntryDecision,
  entryCommandSchema,
  type EntryCommand,
} from "./actualEntryDecisions";
import { projectActualEntryDecisions } from "./actualEntryDecisionProjection";
import { dashboardInbox } from "./dashboardInbox";
import type { DashboardMarketSignals, DashboardSignal } from "./dashboardOperations";
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const command: EntryCommand = {
  action: "set",
  id: id(1),
  market: "KOSDAQ",
  symbol: "TEST",
  name: "Synthetic",
  signalOriginDate: "2026-10-16",
  scope: "symbol",
  reason: "독립성 제한",
  note: "",
};
const now = "2026-10-17T01:00:00.000Z";
const saved = () => applyEntryCommand(emptyEntryDecisions(), command, 0, now);
const row: DashboardSignal = {
  market: "KOSDAQ",
  symbol: "TEST",
  name: "Synthetic",
  date: "2026-10-19",
  signalOriginDate: "2026-10-16",
  reason: "entry",
  sector: "A",
  price: 100,
  score: 8,
  priority: 1,
};
const market = (): DashboardMarketSignals => ({
  market: "KOSDAQ",
  date: row.date,
  holdingsKnown: true,
  onsets: [row],
  onsetCount: 1,
  conditions: [row],
  conditionCount: 1,
  exits: [],
  exitCount: 0,
});
describe("actual-only nonpurchase decisions", () => {
  it("persists independence for subsequent signals without adding events during reads", () => {
    const doc = saved();
    const before = JSON.stringify(doc);
    const entries = activeEntryDecisions(doc);
    expect(findEntryDecision(entries, "KOSDAQ", "TEST", "2026-11-02")?.reason).toBe("독립성 제한");
    expect(findEntryDecision(entries, "US", "TEST", "2026-11-02")).toBeUndefined();
    expect(findEntryDecision(entries, "KOSDAQ", "OTHER", "2026-11-02")).toBeUndefined();
    expect(JSON.stringify(doc)).toBe(before);
  });
  it("one-signal choice survives morning/evening and confirmation dates, but not a new origin", () => {
    const doc = applyEntryCommand(emptyEntryDecisions(), { ...command, scope: "signal" }, 0, now);
    const entries = activeEntryDecisions(doc);
    expect(projectActualEntryDecisions([market()], entries)[0]?.notPurchased).toHaveLength(1);
    expect(findEntryDecision(entries, "KOSDAQ", "TEST", "2026-10-20")).toBeUndefined();
    expect(findEntryDecision(entries, "KOSDAQ", "TEST", "2026-10-16")).toBeDefined();
  });
  it("release restores eligibility while retaining both audit events and retry is idempotent", () => {
    const original = saved();
    expect(applyEntryCommand(original, command, 0, now)).toBe(original);
    const released = applyEntryCommand(
      original,
      { action: "release", id: id(2), targetId: id(1) },
      1,
      now,
    );
    expect(activeEntryDecisions(released)).toEqual([]);
    expect(released.events).toHaveLength(2);
    expect(
      projectActualEntryDecisions([market()], activeEntryDecisions(released))[0]?.onsets,
    ).toHaveLength(1);
  });
  it("rejects stale writes, reused request IDs with changed contents and duplicate active restrictions", () => {
    expect(() => applyEntryCommand(saved(), { ...command, id: id(2) }, 0, now)).toThrow(/다른 창/);
    expect(() => applyEntryCommand(saved(), { ...command, note: "changed" }, 1, now)).toThrow(
      /동일 요청/,
    );
    expect(() => applyEntryCommand(saved(), { ...command, id: id(2) }, 1, now)).toThrow(
      /이미 미매수/,
    );
  });
  it("filters actual budget candidates, counts once in inbox, preserves raw conditions and input data", () => {
    const raw = [market()];
    const before = JSON.stringify(raw);
    const projected = projectActualEntryDecisions(raw, activeEntryDecisions(saved()));
    expect(projected[0]?.onsets).toEqual([]);
    expect(projected[0]?.onsetCount).toBe(0);
    expect(projected[0]?.conditionCount).toBe(1);
    expect(projected[0]?.conditions?.[0]?.entryDecision).toBeDefined();
    expect(dashboardInbox(projected).map((r) => r.inboxKind)).toEqual(["notPurchased"]);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it("never changes actual exits or hides a held K4/E4 exit when restrictions fail to load", () => {
    const exit = { ...row, held: true, reason: "E4 next open" };
    const source = { ...market(), exits: [exit], exitCount: 1 };
    const projected = projectActualEntryDecisions([source], null)[0]!;
    expect(projected.exits).toBe(source.exits);
    expect(projected.exits[0]).toBe(exit);
    expect(projected.onsetCount).toBeNull();
    expect(projected.onsets).toEqual([]);
    expect(dashboardInbox([projected])[0]?.inboxKind).toBe("exits");
  });
  it.each(["KOSPI", "KOSDAQ", "ETF", "US"] as const)("matches %s independently", (marketName) => {
    const doc = applyEntryCommand(
      emptyEntryDecisions(),
      { ...command, market: marketName },
      0,
      now,
    );
    expect(
      findEntryDecision(activeEntryDecisions(doc), marketName, "TEST", "2027-01-01"),
    ).toBeDefined();
  });
  it.each([
    { ...command, signalOriginDate: "2026-02-30" },
    { ...command, shares: 0 },
    { ...command, reason: "invalid" },
    { ...command, note: "x".repeat(301) },
  ])("rejects invalid dates, trade fields, reasons and oversized notes", (input) => {
    expect(entryCommandSchema.safeParse(input).success).toBe(false);
  });
});
