import type { ScreeningRow } from "@/lib/engine/pipeline";
import { WARNING_LABELS } from "@/lib/engine/scoring";
import { VF_SECTOR_PL_OVERHEAT_THRESHOLD } from "@/lib/engine/vfConfig";

const SUPPRESSED_RAW_WARNINGS = new Set([
  "EXIT_TRIGGER",
  "ICHIMOKU_FAIL",
  "VKOSPI_HIGH",
  "NEAR_52W_HIGH",
  "MARKET_RISK_OFF",
  "LOW_LIQUIDITY",
  "STALE_DATA",
  "LOW_VOLUME_BREAKOUT",
]);

const SECONDARY_WARNING_ORDER = [
  "DATA_INCOMPLETE",
  "PRICE_BELOW_CLOUD",
  "PRICE_INSIDE_CLOUD",
  "FOREIGN_FLOW_NEGATIVE",
  "OVEREXTENDED_FROM_MA20",
  "MA20_TURNING_DOWN",
  "ETF_PREMIUM_DISCOUNT_HIGH",
  "LEVERAGED_ETF",
] as const;

type SnapshotWithOptionalBreakout = ScreeningRow["snapshot"] & {
  closeLocationValue?: number | null;
  bollinger?: {
    bbBreakout?: boolean | null;
    headFakeWarning?: boolean | null;
  };
};

/**
 * V8 Final 화면용 경고 정책.
 * 원시 경고는 진단 로그에 남기되, UI에서는 실제 매매 의사결정에 필요한 경고만 선별하고
 * Exit → Sector PL 과열 → Head Fake 순으로 먼저 노출한다.
 */
export function getDisplayWarnings(row: ScreeningRow): string[] {
  const out: string[] = [];

  if (row.exitSignal === "UP95") out.push("상단 Exit · 9.5점 이상");
  if (row.exitSignal === "DOWN25") out.push("하단 Exit · 2.5점 이하");
  if (
    row.sectorPriceLeadership !== null &&
    row.sectorPriceLeadership >= VF_SECTOR_PL_OVERHEAT_THRESHOLD
  )
    out.push(`Sector PL 과열 · ${row.sectorPriceLeadership.toFixed(1)}`);
  if (row.warnings.includes("HEAD_FAKE")) out.push(WARNING_LABELS.HEAD_FAKE ?? "Head Fake 의심");

  const snapshot = row.snapshot as SnapshotWithOptionalBreakout;
  const hasDetailedBreakout =
    snapshot.bollinger?.bbBreakout !== undefined &&
    snapshot.closeLocationValue !== undefined;
  const volumeConfirmationFailed =
    snapshot.bollinger?.bbBreakout === true &&
    snapshot.bollinger?.headFakeWarning !== true &&
    (snapshot.volumeRatio20 === null ||
      snapshot.closeLocationValue === null ||
      snapshot.volumeRatio20 < 150 ||
      snapshot.closeLocationValue < 0.7);
  if (
    volumeConfirmationFailed ||
    (!hasDetailedBreakout && row.warnings.includes("LOW_VOLUME_BREAKOUT"))
  )
    out.push("돌파 거래량 미확인");

  for (const code of SECONDARY_WARNING_ORDER) {
    if (!row.warnings.includes(code)) continue;
    out.push(WARNING_LABELS[code] ?? code);
  }

  for (const code of row.warnings) {
    if (SUPPRESSED_RAW_WARNINGS.has(code)) continue;
    if ((SECONDARY_WARNING_ORDER as readonly string[]).includes(code)) continue;
    if (code === "HEAD_FAKE") continue;
    out.push(WARNING_LABELS[code] ?? code);
  }

  return [...new Set(out)];
}
