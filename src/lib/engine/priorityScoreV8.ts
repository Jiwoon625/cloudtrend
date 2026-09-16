import type { RuleRow, ScoreBlock } from "./scoring";

export const PRIORITY_ROTATION_MAX_POINTS = 1 as const;
export const PRIORITY_SUPPLY_RISK_MAX_PENALTY = 1 as const;
const PRIORITY_SUPPLY_RISK_COMPONENT_PENALTY = PRIORITY_SUPPLY_RISK_MAX_PENALTY / 2;

export interface PrioritySupplyRiskV8 {
  shortSellingVolumeRate20dChangePp: number | null;
  lendingBalanceQuantity20dChange: number | null;
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function signed(value: number, digits: number): string {
  const formatted = Math.abs(value).toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}`;
}

/**
 * V8 priority score used by dashboard/screener.
 * Foreign 20D flow and 52-week-high proximity are removed here because
 * they already live in the Vf technical score.
 * Sector Rotation Score (0~100) is mapped continuously to 0~1 point.
 *
 * Supply Risk remains outside the 10-point Vf score/Onset logic.
 * For stocks, rising short-selling volume share or lending balance is treated
 * as an Entry Risk penalty: 0 / -0.5 / -1.0 point.
 */
export function buildPriorityScoreV8(
  legacy: ScoreBlock,
  sectorRotationScore: number | null,
  supplyRisk: PrioritySupplyRiskV8 | null = null,
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

  const supplyRows: RuleRow[] = [];
  if (supplyRisk !== null) {
    const shortChange = finiteOrNull(supplyRisk.shortSellingVolumeRate20dChangePp);
    const lendingChange = finiteOrNull(supplyRisk.lendingBalanceQuantity20dChange);
    const shortRisk = shortChange !== null && shortChange > 0;
    const lendingRisk = lendingChange !== null && lendingChange > 0;

    supplyRows.push({
      group: "Supply Risk",
      rule: "공매도 거래량 비중 20D 증가",
      actual: shortChange === null ? "데이터 없음" : `${signed(shortChange, 2)}%p`,
      threshold: `20거래일 전 대비 증가 시 -${PRIORITY_SUPPLY_RISK_COMPONENT_PENALTY}점`,
      status: shortChange === null ? "NO_DATA" : shortRisk ? "FAIL" : "PASS",
      points: shortRisk ? -PRIORITY_SUPPLY_RISK_COMPONENT_PENALTY : 0,
      maxPoints: 0,
    });
    supplyRows.push({
      group: "Supply Risk",
      rule: "대차잔고 20D 증가",
      actual: lendingChange === null ? "데이터 없음" : `${signed(lendingChange, 0)}주`,
      threshold: `20거래일 전 대비 증가 시 -${PRIORITY_SUPPLY_RISK_COMPONENT_PENALTY}점`,
      status: lendingChange === null ? "NO_DATA" : lendingRisk ? "FAIL" : "PASS",
      points: lendingRisk ? -PRIORITY_SUPPLY_RISK_COMPONENT_PENALTY : 0,
      maxPoints: 0,
    });
  }

  const rows = [...scoredRows, rotationRow, ...supplyRows, ...referenceRows];
  const points = Math.round(rows.reduce((sum, row) => sum + row.points, 0) * 100) / 100;
  const maxPoints = Math.round(rows.reduce((sum, row) => sum + row.maxPoints, 0) * 100) / 100;
  const availableMaxPoints =
    Math.round(
      rows.reduce((sum, row) => sum + (row.status === "NO_DATA" ? 0 : row.maxPoints), 0) * 100,
    ) / 100;
  return { points, maxPoints, availableMaxPoints, rows };
}
