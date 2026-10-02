import {
  getHeldOperationalExitSignal,
  getStoredOperationalExit,
  isOperationalEntry,
  LEGACY_OPERATIONAL_SIGNAL_VERSION,
  STRATEGY_CONFIG,
} from "./engine/operationalStrategy";
import { type KospiMarketGateEvidence } from "./engine/kospiMarketGate";
import { KOSPI_ENTRY_POLICY, type KospiEntrySnapshot } from "./engine/kospiEntryConfirmation";
import type { ScreeningSnapshot, SnapshotEntry } from "./screeningSnapshot";
import type { DailyPrice, Market } from "./engine/types";
import type { MarketDataset } from "./engine/dataset";
import type { PortfolioTrade } from "./portfolioStoreCore";
export interface ExitPlan {
  signalDate: string | null;
  exitDate: string;
  exitPrice: number;
  reason: string;
  timing: "OPEN" | "CLOSE";
}
export function normalizeSnapshots(input: ScreeningSnapshot[]): ScreeningSnapshot[] {
  const byAsOf = new Map<string, ScreeningSnapshot>();
  for (const snapshot of [...input].sort((a, b) => a.savedAt.localeCompare(b.savedAt))) {
    if (!snapshot.asOfDate) continue;
    const previous = byAsOf.get(snapshot.asOfDate);
    // A historical re-screen under the new policy cannot rewrite genuine old operational signals.
    // This only retains signals that were actually stored; it never upgrades informational history.
    if (previous && snapshot.asOfDate < KOSPI_ENTRY_POLICY.effectiveConfirmationDate) {
      const legacy = new Map(
        previous.entries
          .filter((entry) => entry.operationalSignalVersion === LEGACY_OPERATIONAL_SIGNAL_VERSION)
          .map((entry) => [entry.symbol, entry]),
      );
      const entries = snapshot.entries.map((entry) => {
        const original = legacy.get(entry.symbol);
        legacy.delete(entry.symbol);
        return original && entry.operationalSignalVersion !== LEGACY_OPERATIONAL_SIGNAL_VERSION
          ? original
          : entry;
      });
      byAsOf.set(snapshot.asOfDate, { ...snapshot, entries: [...entries, ...legacy.values()] });
    } else byAsOf.set(snapshot.asOfDate, snapshot);
  }
  return [...byAsOf.values()].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
}

export function datasetLatestDate(dataset: MarketDataset): string | null {
  let latest: string | null = null;
  for (const bars of Object.values(dataset.bars)) {
    const date = bars.at(-1)?.tradeDate ?? null;
    if (date && (latest === null || date > latest)) latest = date;
  }
  for (const series of dataset.indexSeries) {
    const date = series.bars.at(-1)?.tradeDate ?? null;
    if (date && (latest === null || date > latest)) latest = date;
  }
  return latest;
}

export function isEntryOnset(entry: SnapshotEntry, market: Market, asOfDate?: string) {
  if (market === "KOSPI") return isOperationalEntry({ ...entry, kosdaq80Onset: false }, asOfDate);
  if (market !== "KOSDAQ") return false;
  if (entry.kosdaq80Onset === true) return true;
  return /KOSDAQ\s*(?:80|8)\s*(?:Onset|ONSET)/i.test(entry.status ?? "");
}

/** Explicit historical replay exception. Never use this as a live action gate. */
export function isLegacyReplayEntry(entry: SnapshotEntry, market: Market, asOfDate: string) {
  return (
    market === "KOSPI" &&
    asOfDate < KOSPI_ENTRY_POLICY.effectiveConfirmationDate &&
    entry.operationalSignalVersion === LEGACY_OPERATIONAL_SIGNAL_VERSION &&
    entry.kospi80Onset === true
  );
}

export interface EntryExecution {
  bar: DailyPrice | null;
  state: "ready" | "waiting" | "unobservable" | "blocked";
  reason: string;
}

/** A zero-volume observed bar is a suspension; an absent bar is an unknown gap, never a late fill. */
export function nextConfirmedEntry(
  bars: DailyPrice[],
  confirmationDate: string,
  marketDates: string[],
): EntryExecution {
  const byDate = new Map(bars.map((bar) => [bar.tradeDate, bar]));
  const dates = [...new Set([...marketDates, ...byDate.keys()])]
    .filter((date) => date > confirmationDate)
    .sort();
  for (const date of dates) {
    const bar = byDate.get(date);
    if (!bar)
      return { bar: null, state: "unobservable", reason: `가격 관측 불가 · ${date} 자료 누락` };
    if (
      !Number.isFinite(bar.volume) ||
      bar.volume < 0 ||
      !Number.isFinite(bar.open) ||
      bar.open < 0
    )
      return {
        bar: null,
        state: "unobservable",
        reason: `가격 관측 불가 · ${date} 시가/거래량 오류`,
      };
    if (bar.volume === 0) continue;
    if (bar.open <= 0)
      return { bar: null, state: "unobservable", reason: `가격 관측 불가 · ${date} 시가 오류` };
    return { bar, state: "ready", reason: "다음 거래가능일 대기" };
  }
  return { bar: null, state: "waiting", reason: "다음 거래가능일 대기" };
}

/** Check the original Onset and the last completed session before the first tradable fill.
 * Never substitute a current gate for a historical session, or search for a later bull fill.
 * The underlying executor retains observed suspension versus missing-bar semantics.
 */
export function nextKospiConfirmedEntry(
  bars: DailyPrice[],
  entry: KospiEntrySnapshot,
  marketDates: string[],
  gates: Record<string, KospiMarketGateEvidence> = {},
): EntryExecution {
  const execution = nextConfirmedEntry(bars, entry.confirmationDate ?? entry.date, marketDates);
  if (execution.state === "unobservable") return execution;
  const dates = [...new Set(marketDates)].sort();
  const priorDate = execution.bar
    ? dates.filter((date) => date < execution.bar!.tradeDate).at(-1)
    : (dates
        .filter((date) => date >= entry.date && date <= (bars.at(-1)?.tradeDate ?? entry.date))
        .at(-1) ?? entry.date);
  const origin = entry.marketGate?.origin;
  const prior = priorDate
    ? (gates[priorDate] ??
      (entry.marketGate?.confirmation?.date === priorDate
        ? entry.marketGate.confirmation
        : undefined))
    : undefined;
  for (const [label, date, gate] of [
    ["발생일", entry.originDate, origin],
    ...(execution.bar ? [["체결 전 완료일", priorDate, prior] as const] : []),
  ] as const) {
    if (
      !date ||
      !gate ||
      gate.date !== date ||
      gate.incomplete ||
      gate.evaluatedCount !== 4 ||
      gate.issues.length > 0 ||
      gate.status === "UNKNOWN"
    )
      return {
        bar: null,
        state: "unobservable",
        reason: `${label} 시장국면 미확인 · 신규매수 제한${date ? ` (${date})` : ""}`,
      };
    if (gate.status === "RISK_OFF")
      return {
        bar: null,
        state: "blocked",
        reason: `${label} 불황(RISK_OFF) · 신규매수 제한 · 새 Onset 필요 (${date})`,
      };
  }
  return execution.state === "waiting"
    ? { ...execution, reason: `${execution.reason} · 체결 전 완료일 시장국면 재확인 필요` }
    : execution;
}

/** Any holding during the origin-to-execution window (including a same-day sale) blocks re-entry. */
export function heldDuringEntryWindow(
  trade: PortfolioTrade,
  symbol: string,
  originDate: string,
  entryDate: string,
) {
  return (
    trade.symbol === symbol &&
    trade.entryDate <= entryDate &&
    (!trade.exitDate || trade.exitDate >= originDate)
  );
}

export function operationalExit(
  entry: SnapshotEntry,
  market: Market,
  held = false,
): "UP95" | "UP90" | "DOWN30" | null {
  const stored = getStoredOperationalExit(entry, market);
  if (stored) return stored;
  if (market === "KOSDAQ" && (entry.exitSignal === "UP90" || entry.exitSignal === "DOWN30"))
    return entry.exitSignal;
  if (held) {
    const heldSignal = getHeldOperationalExitSignal(
      market,
      entry.technicalPoints ?? null,
      entry.scoreDelta1d ?? null,
    );
    if (heldSignal) return heldSignal;
  }
  if (market !== "KOSDAQ") return null;
  const status = entry.status ?? "";
  if (/9\.0점.*상향/i.test(status)) return "UP90";
  if (/3\.0점.*하향/i.test(status)) return "DOWN30";
  return null;
}

export function firstBarAfter(bars: DailyPrice[], date: string): DailyPrice | null {
  for (const bar of bars) if (bar.tradeDate > date) return bar;
  return null;
}

export function barOnOrBefore(bars: DailyPrice[], date: string): DailyPrice | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i]!;
    if (bar.tradeDate <= date) return bar;
  }
  return null;
}

export function holdingDays(bars: DailyPrice[], entryDate: string, endDate: string) {
  return bars.filter((bar) => bar.tradeDate >= entryDate && bar.tradeDate <= endDate).length;
}

export function latestSnapshotEntry(
  snapshots: ScreeningSnapshot[],
  symbol: string,
): SnapshotEntry | null {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const found = snapshots[i]!.entries.find((entry) => entry.symbol === symbol);
    if (found) return found;
  }
  return null;
}

export function deriveExitPlan(
  trade: PortfolioTrade,
  snapshots: ScreeningSnapshot[],
  bars: DailyPrice[],
  latestDate: string,
): ExitPlan | null {
  let scorePlan: ExitPlan | null = null;
  for (const snapshot of snapshots) {
    if (snapshot.asOfDate < trade.entryDate || snapshot.asOfDate > latestDate) continue;
    const entry = snapshot.entries.find((item) => item.symbol === trade.symbol);
    if (!entry) continue;
    const signal = operationalExit(entry, trade.market, true);
    if (!signal) continue;
    const execution = firstBarAfter(bars, snapshot.asOfDate);
    if (!execution || execution.tradeDate > latestDate || execution.open <= 0) continue;
    scorePlan = {
      signalDate: snapshot.asOfDate,
      exitDate: execution.tradeDate,
      exitPrice: execution.open,
      reason:
        signal === "UP95"
          ? "9.5점 상향돌파"
          : signal === "UP90"
            ? "9.0점 상향 재돌파"
            : "3.0점 하향 이탈",
      timing: "OPEN",
    };
    break;
  }

  const entryIndex = bars.findIndex((bar) => bar.tradeDate === trade.entryDate);
  const timeBar =
    entryIndex >= 0
      ? bars[
          entryIndex +
            STRATEGY_CONFIG[trade.market === "KOSDAQ" ? "KOSDAQ" : "KOSPI"].maxHoldingDays -
            1
        ]
      : undefined;
  const timePlan: ExitPlan | null =
    timeBar && timeBar.tradeDate <= latestDate && timeBar.close > 0
      ? {
          signalDate: null,
          exitDate: timeBar.tradeDate,
          exitPrice: timeBar.close,
          reason: "60거래일 만기",
          timing: "CLOSE",
        }
      : null;

  if (!scorePlan) return timePlan;
  if (!timePlan) return scorePlan;
  if (scorePlan.exitDate < timePlan.exitDate) return scorePlan;
  if (scorePlan.exitDate > timePlan.exitDate) return timePlan;
  return scorePlan.timing === "OPEN" ? scorePlan : timePlan;
}
