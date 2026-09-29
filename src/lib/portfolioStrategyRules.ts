import {
  getHeldOperationalExitSignal,
  getStoredOperationalExit,
  isOperationalEntry,
  STRATEGY_CONFIG,
} from "./engine/operationalStrategy";
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
    byAsOf.set(snapshot.asOfDate, snapshot);
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

export function isEntryOnset(entry: SnapshotEntry, market: Market) {
  if (market === "KOSPI") return isOperationalEntry({ ...entry, kosdaq80Onset: false });
  if (market !== "KOSDAQ") return false;
  if (entry.kosdaq80Onset === true) return true;
  return /KOSDAQ\s*(?:80|8)\s*(?:Onset|ONSET)/i.test(entry.status ?? "");
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
