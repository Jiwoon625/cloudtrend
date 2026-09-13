export const SECTOR_SLOT_POINTS = 0.5;
export const SECTOR_PENALTY_POINTS = 0.5;

export interface SectorScoreAdjustment {
  score: number;
  sectorScoreAvailable: boolean;
  overheated: boolean | null;
  penaltyApplied: boolean;
}

export function adjustSectorPenaltyScore(
  baseScore9p5: number,
  sectorPriceLeadership: number | null,
  overheatThreshold: number | null,
): SectorScoreAdjustment {
  const sectorScoreAvailable =
    sectorPriceLeadership !== null && Number.isFinite(sectorPriceLeadership);
  if (!sectorScoreAvailable) {
    return {
      score: Math.min(10, Math.max(0, Math.round(baseScore9p5 * 100) / 100)),
      sectorScoreAvailable: false,
      overheated: null,
      penaltyApplied: false,
    };
  }

  const overheated =
    overheatThreshold !== null && sectorPriceLeadership! >= overheatThreshold;
  const score =
    baseScore9p5 + SECTOR_SLOT_POINTS - (overheated ? SECTOR_PENALTY_POINTS : 0);
  return {
    score: Math.min(10, Math.max(0, Math.round(score * 100) / 100)),
    sectorScoreAvailable: true,
    overheated,
    penaltyApplied: overheated,
  };
}
