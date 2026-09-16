import type { ScreeningRow } from "@/lib/engine/pipeline";

type RelativeQualityRow = Pick<ScreeningRow, "instrument" | "rs20" | "rs60">;

/**
 * KOSPI Relative Quality (V8 research final):
 * RSAccel = RS20 - RS60.
 *
 * This is intentionally a separate information axis. It must not be added to
 * the V8 10-point technical score or the V8 priority score.
 */
export function getKospiRsAccel(row: RelativeQualityRow): number | null {
  if (row.instrument.instrumentType !== "STOCK" || row.instrument.market !== "KOSPI") return null;
  if (row.rs20 === null || row.rs60 === null) return null;
  if (!Number.isFinite(row.rs20) || !Number.isFinite(row.rs60)) return null;
  return row.rs20 - row.rs60;
}

export function isKospiRelativeMomentumConfirmed(row: RelativeQualityRow): boolean {
  const rsAccel = getKospiRsAccel(row);
  return rsAccel !== null && rsAccel > 0;
}

/**
 * Ordering for KOSPI 8-point onset candidates:
 * 1) Relative momentum confirmed (RSAccel > 0)
 * 2) Higher raw RSAccel
 * 3) Existing priority score / sector rotation / V8 score tie-breakers
 */
export function compareKospiRelativeQuality(a: ScreeningRow, b: ScreeningRow): number {
  const aConfirmed = isKospiRelativeMomentumConfirmed(a);
  const bConfirmed = isKospiRelativeMomentumConfirmed(b);
  if (aConfirmed !== bConfirmed) return aConfirmed ? -1 : 1;

  const aAccel = getKospiRsAccel(a);
  const bAccel = getKospiRsAccel(b);
  if (aAccel !== null || bAccel !== null) {
    if (aAccel === null) return 1;
    if (bAccel === null) return -1;
    if (aAccel !== bAccel) return bAccel - aAccel;
  }

  const priority = b.priority.points - a.priority.points;
  if (priority !== 0) return priority;
  const rotation = (b.sectorRotationScore ?? -Infinity) - (a.sectorRotationScore ?? -Infinity);
  if (rotation !== 0) return rotation;
  const technical = (b.operatingScore10 ?? -Infinity) - (a.operatingScore10 ?? -Infinity);
  if (technical !== 0) return technical;
  return a.instrument.symbol.localeCompare(b.instrument.symbol);
}
