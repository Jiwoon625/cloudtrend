import { describe, expect, it } from "vitest";
import type { RuleRow, ScoreBlock } from "./scoring";
import { buildPriorityScoreV8 } from "./priorityScoreV8";

const row = (group: string, points: number, maxPoints: number, status: RuleRow["status"] = "PASS"): RuleRow => ({
  group,
  rule: group,
  actual: "test",
  threshold: "test",
  status,
  points,
  maxPoints,
});

function legacyPriority(): ScoreBlock {
  const rows = [
    row("지수 편입", 2, 2),
    row("외국인 수급", 2, 2),
    row("신고가", 2.5, 2.5),
    row("규모", 1, 1),
    row("상대 성과", 1, 1),
    row("참고지표 (점수 미반영)", 0, 0, "FAIL"),
  ];
  return { points: 8.5, maxPoints: 8.5, availableMaxPoints: 8.5, rows };
}

describe("buildPriorityScoreV8", () => {
  it("keeps the existing 5-point base priority score", () => {
    const result = buildPriorityScoreV8(legacyPriority(), 82);
    expect(result.maxPoints).toBe(5);
    expect(result.availableMaxPoints).toBe(5);
    expect(result.points).toBe(4.82);
  });

  it("applies -0.5 for each worsening Supply Risk component", () => {
    const result = buildPriorityScoreV8(legacyPriority(), 82, {
      shortSellingVolumeRate20dChangePp: 0.35,
      lendingBalanceQuantity20dChange: 120_000,
    });
    expect(result.maxPoints).toBe(5);
    expect(result.points).toBe(3.82);
    const supplyRows = result.rows.filter((r) => r.group === "Supply Risk");
    expect(supplyRows.map((r) => r.points)).toEqual([-0.5, -0.5]);
    expect(supplyRows.every((r) => r.status === "FAIL")).toBe(true);
  });

  it("treats non-increasing Supply Risk as neutral rather than a reward", () => {
    const result = buildPriorityScoreV8(legacyPriority(), 50, {
      shortSellingVolumeRate20dChangePp: -0.2,
      lendingBalanceQuantity20dChange: 0,
    });
    expect(result.maxPoints).toBe(5);
    expect(result.points).toBe(4.5);
    const supplyRows = result.rows.filter((r) => r.group === "Supply Risk");
    expect(supplyRows.map((r) => r.points)).toEqual([0, 0]);
    expect(supplyRows.every((r) => r.status === "PASS")).toBe(true);
  });

  it("does not penalize missing Supply Risk data", () => {
    const result = buildPriorityScoreV8(legacyPriority(), 100, {
      shortSellingVolumeRate20dChangePp: null,
      lendingBalanceQuantity20dChange: null,
    });
    expect(result.maxPoints).toBe(5);
    expect(result.availableMaxPoints).toBe(5);
    expect(result.points).toBe(5);
    expect(result.rows.filter((r) => r.group === "Supply Risk").every((r) => r.status === "NO_DATA")).toBe(true);
  });

  it("keeps missing rotation out of available max", () => {
    const result = buildPriorityScoreV8(legacyPriority(), null);
    expect(result.maxPoints).toBe(5);
    expect(result.availableMaxPoints).toBe(4);
    expect(result.points).toBe(4);
  });
});
