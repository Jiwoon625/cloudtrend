import {
  getKosdaqOperationalExitSignal,
  VF_ENTRY_RAW_SCORE,
  VF_UPSIDE_EXIT_RAW_SCORE,
} from "./vfConfig";

/** Separates executable KOSPI signals from pre-adoption informational snapshots. */
export const OPERATIONAL_SIGNAL_VERSION = "kospi-e8-u95-dx-v1";
export const STRATEGY_CONFIG = {
  KOSPI: {
    pl: "ETF PL 84 우선 / Stock PL 80 fallback",
    summary:
      "KOSPI: ETF PL 84 우선 / Stock PL 80 fallback · 8.0 Onset 진입 · U9.5 상향돌파 청산 · Downside Exit 없음(DX) · H60",
    maxHoldingDays: 60,
    sectorCap: 0.1,
  },
  KOSDAQ: {
    pl: "Stock PL 80",
    summary:
      "KOSDAQ: Stock PL 80 · 8.0 Onset 진입 · U9.0 상향 재돌파 / D3.0 하향 이탈 · H60 (기존 운영 전략 유지)",
    maxHoldingDays: 60,
    sectorCap: 0.2,
  },
} as const;

export function getKospiOperationalExitSignal(
  previous: number | null,
  current: number | null,
  entryOnset = false,
): "UP95" | null {
  if (
    previous === null ||
    current === null ||
    !Number.isFinite(previous) ||
    !Number.isFinite(current) ||
    entryOnset
  )
    return null;
  return previous < VF_UPSIDE_EXIT_RAW_SCORE && current >= VF_UPSIDE_EXIT_RAW_SCORE ? "UP95" : null;
}

export function getOperationalSignals(
  market: string,
  previous: number | null,
  current: number | null,
  eligible: boolean,
) {
  const onset =
    eligible &&
    previous !== null &&
    current !== null &&
    Number.isFinite(previous) &&
    Number.isFinite(current) &&
    previous < VF_ENTRY_RAW_SCORE &&
    current >= VF_ENTRY_RAW_SCORE;
  const kospi80Onset = market === "KOSPI" && onset;
  const kosdaq80Onset = market === "KOSDAQ" && onset;
  const exitSignal =
    market === "KOSPI"
      ? getKospiOperationalExitSignal(previous, current, kospi80Onset)
      : market === "KOSDAQ"
        ? getKosdaqOperationalExitSignal(previous, current, kosdaq80Onset)
        : null;
  return {
    kospi80Onset,
    kosdaq80Onset,
    kospiEightPointEntry: kospi80Onset,
    exitSignal,
    operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
  };
}

interface Signals {
  kospi80Onset?: boolean;
  kosdaq80Onset?: boolean;
  operationalSignalVersion?: string;
  exitSignal?: string | null;
}
export function isOperationalEntry(row: Signals): boolean {
  return (
    row.kosdaq80Onset === true ||
    (row.operationalSignalVersion === OPERATIONAL_SIGNAL_VERSION && row.kospi80Onset === true)
  );
}
export function getStoredOperationalExit(
  row: Signals,
  market: string,
): "UP95" | "UP90" | "DOWN30" | null {
  if (market === "KOSPI")
    return row.operationalSignalVersion === OPERATIONAL_SIGNAL_VERSION && row.exitSignal === "UP95"
      ? "UP95"
      : null;
  if (market === "KOSDAQ" && (row.exitSignal === "UP90" || row.exitSignal === "DOWN30"))
    return row.exitSignal;
  return null;
}
export function getOperationalStatus(row: Signals, market: string): string {
  const exit = getStoredOperationalExit(row, market);
  if (exit === "UP95") return "KOSPI 청산 · 9.5점 상향돌파";
  if (exit === "UP90") return "KOSDAQ 청산 · 9.0점 상향 재돌파";
  if (exit === "DOWN30") return "KOSDAQ 청산 · 3.0점 하향 이탈";
  if (isOperationalEntry(row)) return `${market} 8.0 Onset · 신규 진입`;
  return "관찰";
}
