import type { RuleRow, ScoreBlock } from "./scoring";

export const PRIORITY_ROTATION_MAX_POINTS = 1 as const;

/**
 * V8 priority score used by dashboard/screener.
 * Foreign 20D flow and 52-week-high proximity are removed here because
 * they already live in the Vf technical score.
 * Sector Rotation Score (0~100) is mapped continuously to 0~1 point.
 */
export function buildPriorityScoreV8(
  legacy: ScoreBlock,
  sectorRotationScore: number | null,
): ScoreBlock {
  const scoredRows = legacy.rows.filter(
    (row) => row.group !== "외국인 수급" && row.group !== "신고가" && row.group !== "참고지표 (점수 미반영)",
  );
  const referenceRows = legacy.rows.filter((row) => row.group === "참고지표 (점수 미반영)");
  const rotation =
    sectorRotationScore === null || !Number.isFinite(sectorRotationScore)
      ? null
      : Math.min(100, Math.max(0, sectorRotationScore));
  const rotationPoints =
    rotation === null
      ? 0
      : Math.round((rotation / 100) * PRIORITY_ROTATION_MAX_POINTS * 100) / 100;
  const rotationRow: RuleRow = {
    group: "섹터 로테이션",
    rule: "섹터 Rotation Score (0~100 비례 반영)",
    actual: rotation === null ? "데이터 없음" : `${rotation.toFixed(1)}/100`,
    threshold: `Rotation 0~100 → 0~${PRIORITY_ROTATION_MAX_POINTS}점`,
    status: rotation === null ? "NO_DATA" : "PASS",
    points: rotationPoints,
    maxPoints: PRIORITY_ROTATION_MAX_POINTS,
  };
  const rows = [...scoredRows, rotationRow, ...referenceRows];
  const points = Math.round(rows.reduce((sum, row) => sum + row.points, 0) * 100) / 100;
  const maxPoints = Math.round(rows.reduce((sum, row) => sum + row.maxPoints, 0) * 100) / 100;
  const availableMaxPoints =
    Math.round(
      rows.reduce((sum, row) => sum + (row.status === "NO_DATA" ? 0 : row.maxPoints), 0) * 100,
    ) / 100;
  return { points, maxPoints, availableMaxPoints, rows };
}
