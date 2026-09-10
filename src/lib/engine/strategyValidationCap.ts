import * as legacy from "./strategyValidationLegacy";
import type { SimulatedTrade, StrategyScenario, StrategySeries } from "./strategyValidationLegacy";

export interface CapacitySimulation {
  trades: SimulatedTrade[];
  skippedForCapacity: number;
  skippedSignalDates: string[];
}

function key(market: string | undefined, symbol: string) {
  return `${market === "KOSDAQ" ? "KOSDAQ" : "KOSPI"}:${symbol}`;
}

function occupiesSlotAtOpen(trade: SimulatedTrade, date: string) {
  if (trade.exitDate > date) return true;
  if (trade.exitDate < date) return false;
  return trade.exitTiming !== "OPEN";
}

/** 같은 날 후보는 점수 → 5D 상승 → 10D 상승 → 종목코드 순으로 선택한다. */
export function simulateWithPositionCap(
  series: StrategySeries[],
  scenario: StrategyScenario,
  costBps: number,
  cap: number,
): CapacitySimulation {
  const rise = (s: StrategySeries, i: number, lag: number) => {
    const now = legacy.scorePercent(s.scores[i]);
    const before = legacy.scorePercent(s.scores[i - lag]);
    return now !== null && before !== null ? now - before : -Infinity;
  };
  const candidates: Array<{
    s: StrategySeries; signalIndex: number; signalDate: string; entryDate: string;
    score: number; rise5: number; rise10: number;
  }> = [];

  for (const s of series) {
    for (let i = 1; i + 1 < s.bars.length; i++) {
      if (!legacy.passesEntry(s, i, scenario)) continue;
      const signalDate = s.bars[i]?.tradeDate;
      const entryDate = s.bars[i + 1]?.tradeDate;
      const score = legacy.scorePercent(s.scores[i]);
      if (!signalDate || !entryDate || score === null) continue;
      candidates.push({ s, signalIndex: i, signalDate, entryDate, score,
        rise5: rise(s, i, 5), rise10: rise(s, i, 10) });
    }
  }

  candidates.sort((a, b) =>
    a.entryDate.localeCompare(b.entryDate) || b.score - a.score ||
    b.rise5 - a.rise5 || b.rise10 - a.rise10 || a.s.symbol.localeCompare(b.s.symbol));

  const selected: SimulatedTrade[] = [];
  const skippedSignalDates: string[] = [];
  let cursor = 0;
  while (cursor < candidates.length) {
    const entryDate = candidates[cursor]!.entryDate;
    const day: typeof candidates = [];
    while (cursor < candidates.length && candidates[cursor]!.entryDate === entryDate) {
      day.push(candidates[cursor]!);
      cursor++;
    }
    const active = selected.filter((t) => occupiesSlotAtOpen(t, entryDate));
    const activeSymbols = new Set(active.map((t) => key(t.market, t.symbol)));
    let slots = Math.max(0, cap - active.length);

    for (const candidate of day) {
      const symbolKey = key(candidate.s.market, candidate.s.symbol);
      if (activeSymbols.has(symbolKey)) continue;
      if (slots <= 0) {
        skippedSignalDates.push(candidate.signalDate);
        continue;
      }
      const trade = legacy.simulateTrade(candidate.s, candidate.signalIndex, scenario, costBps);
      if (!trade) continue;
      selected.push(trade);
      activeSymbols.add(symbolKey);
      slots--;
    }
  }
  return { trades: selected, skippedForCapacity: skippedSignalDates.length, skippedSignalDates };
}
