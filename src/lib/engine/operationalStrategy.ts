import {
  KOSPI_ENTRY_POLICY,
  isKospiEntryReady,
  type KospiEntrySnapshot,
} from "./kospiEntryConfirmation";
import {
  getKosdaqOperationalExitSignal,
  VF_ENTRY_RAW_SCORE,
  VF_UPSIDE_EXIT_RAW_SCORE,
} from "./vfConfig";

/** Separates executable KOSPI signals from pre-adoption informational snapshots. */
export const LEGACY_OPERATIONAL_SIGNAL_VERSION = "kospi-e8-u95-dx-v1";
export const PREVIOUS_KOSPI_ENTRY_POLICY_VERSION = "kospi-e8-confirm1-rsaccel-v2";
export const OPERATIONAL_SIGNAL_VERSION = KOSPI_ENTRY_POLICY.version;
export const STRATEGY_CONFIG = {
  KOSPI: {
    pl: "ETF PL 84 우선 / Stock PL 80 fallback",
    summary:
      "KOSPI: ETF PL 84 우선 / Stock PL 80 fallback · 8.0 Onset → 다음 KOSPI 거래일 종가 8점 이상·U9.5 청산 없음·유한한 RSAccel > 0 확인 → 다음 거래 가능 시가 진입 · Onset일·체결 직전 마지막 완료 거래일 시장국면 non-bear 필수 · 하락장/시장자료 미확인 시 신규 진입 제외 · U9.5 상향돌파 청산 · Downside Exit 없음(DX) · H60",
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

/**
 * Re-evaluates the same score transition from the perspective of an already-held position.
 * Generic screening keeps entry-Onset precedence, but holdings must honor an exit threshold
 * crossed on the same day (for example KOSDAQ 5.5 -> 9.5).
 *
 * scoreDelta1d is stored on the 0-100 display scale, while current is the raw 0-10 score.
 */
export function getHeldOperationalExitSignal(
  market: string,
  current: number | null,
  scoreDelta1d: number | null,
): "UP95" | "UP90" | "DOWN30" | null {
  if (
    current === null ||
    scoreDelta1d === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(scoreDelta1d)
  )
    return null;
  const previous = current - scoreDelta1d / 10;
  if (market === "KOSPI") return getKospiOperationalExitSignal(previous, current, false);
  if (market === "KOSDAQ") return getKosdaqOperationalExitSignal(previous, current, false);
  return null;
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
    kospiEightPointEntry: false,
    exitSignal,
    operationalSignalVersion: OPERATIONAL_SIGNAL_VERSION,
  };
}

interface Signals {
  kospiEntry?: KospiEntrySnapshot | undefined;
  kospi80Onset?: boolean;
  kosdaq80Onset?: boolean;
  operationalSignalVersion?: string;
  exitSignal?: string | null;
}
export function isOperationalEntry(row: Signals, asOfDate?: string): boolean {
  return (
    row.kosdaq80Onset === true ||
    (row.operationalSignalVersion === OPERATIONAL_SIGNAL_VERSION &&
      isKospiEntryReady(row.kospiEntry, asOfDate))
  );
}
export function getStoredOperationalExit(
  row: Signals,
  market: string,
): "UP95" | "UP90" | "DOWN30" | null {
  if (market === "KOSPI")
    return (row.operationalSignalVersion === OPERATIONAL_SIGNAL_VERSION ||
      row.operationalSignalVersion === LEGACY_OPERATIONAL_SIGNAL_VERSION ||
      row.operationalSignalVersion === PREVIOUS_KOSPI_ENTRY_POLICY_VERSION) &&
      row.exitSignal === "UP95"
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
  if (market === "KOSPI" && row.kospiEntry) {
    const s = row.kospiEntry;
    if (isOperationalEntry(row))
      return "KOSPI 하루·RS·시장국면 확인 완료 · 체결 전 시장 재확인 대기";
    if (s.state === "confirmed")
      return s.date < KOSPI_ENTRY_POLICY.effectiveConfirmationDate ||
        s.version !== KOSPI_ENTRY_POLICY.version
        ? "KOSPI 과거 확인 참고 · 운영 진입 제외"
        : `KOSPI 확인 기록 미충족 · 진입 제외${s.issues.length ? ` · ${s.issues.join(" · ")}` : ""}`;
    if (s.state === "pending") return "KOSPI 8.0 Onset · 다음 거래일 확인 대기";
    if (s.state === "rejected") return `KOSPI 확인 실패 · 진입 제외 · ${s.issues.join(" · ")}`;
    if (s.state === "unobservable")
      return `KOSPI 확인 자료 미확인 · 진입 제외${s.issues.length ? ` · ${s.issues.join(" · ")}` : ""}`;
  }
  if (market === "KOSPI" && row.kospi80Onset) return "KOSPI 8.0 Onset · 확인 기록 없음 · 진입 제외";
  if (isOperationalEntry(row)) return `${market} 8.0 Onset · 신규 진입`;
  return "관찰";
}
