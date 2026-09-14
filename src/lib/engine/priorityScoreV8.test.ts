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
  it("removes duplicated foreign/high factors and adds continuous rotation for a 5-point score", () => {
    const result = buildPriorityScoreV8(legacyPriority(), 82);
    expect(result.maxPoints).toBe(5);
    expect(result.availableMaxPoints).toBe(5);
    expect(result.points).toBe(4.82);
    expect(result.rows.some((r) => r.group === "외국인 수급")).toBe(false);
    expect(result.rows.some((r) => r.group === "신고가")).toBe(false);
    expect(result.rows.find((r) => r.group === "섹터 로테이션")?.points).toBe(0.82);
  });

  it("keeps the 5-point headline max while excluding missing rotation from available max", () => {
    const result = buildPriorityScoreV8(legacyPriority(), null);
    expect(result.maxPoints).toBe(5);
    expect(result.availableMaxPoints).toBe(4);
    expect(result.points).toBe(4);
    expect(result.rows.find((r) => r.group === "섹터 로테이션")?.status).toBe("NO_DATA");
  });

  it("clamps rotation score to the supported 0~100 range", () => {
    expect(buildPriorityScoreV8(legacyPriority(), 120).points).toBe(5);
    expect(buildPriorityScoreV8(legacyPriority(), -20).points).toBe(4);
  });
});
