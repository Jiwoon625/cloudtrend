// V6 portfolio-accounting fix wrapper.
// Original V6 trade simulation stays frozen in strategyValidationLegacy.ts.

import * as legacy from "./strategyValidationLegacy";
import type {
  ExitOverlay,
  PositionCapComparisonRow,
  SimulatedTrade,
  StrategyScenario,
  StrategySeries,
  StrategyValidation,
} from "./strategyValidationLegacy";
import { portfolioMetric, type PortfolioMetric } from "./strategyValidationPortfolio";
import { simulateWithPositionCap, type CapacitySimulation } from "./strategyValidationCap";

export * from "./strategyValidationLegacy";

function filterSplit(trades: SimulatedTrade[], split: "ALL" | "OOS", oosStart: string | null) {
  return split === "ALL"
    ? trades
    : trades.filter((trade) => oosStart !== null && trade.signalDate >= oosStart);
}

function findScenario(id: string) {
  return legacy.STRATEGY_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}

function overlayById(id: string): ExitOverlay | null {
  if (id === legacy.NO_EXIT_OVERLAY.id) return legacy.NO_EXIT_OVERLAY;
  return [...legacy.FIXED_STOP_OVERLAYS, ...legacy.ATR_STOP_OVERLAYS].find(
    (overlay) => overlay.id === id,
  ) ?? null;
}

function overlayTrades(
  series: StrategySeries[], scenario: StrategyScenario, overlay: ExitOverlay,
  costBps: number, baseTrades: Map<string, SimulatedTrade[]>,
) {
  if (overlay.kind === "NONE") return baseTrades.get(scenario.id) ?? [];
  return series.flatMap((s) => legacy.simulateScenario(s, scenario, costBps, overlay));
}

function gateTrades(
  series: StrategySeries[], scenario: StrategyScenario, gate: "ALL" | "NO_RISK_OFF",
  costBps: number, baseTrades: Map<string, SimulatedTrade[]>,
) {
  if (gate === "ALL") return baseTrades.get(scenario.id) ?? [];
  return series.flatMap((s) => legacy.simulateScenario(
    s, scenario, costBps, legacy.NO_EXIT_OVERLAY,
    (candidate, i) => candidate.regimes[i] !== "RISK_OFF",
  ));
}

export function buildStrategyValidation(
  series: StrategySeries[], horizons: number[], oosStart: string | null, costBps = 0,
): StrategyValidation {
  const normalizedCost = Math.max(0, costBps);
  const original = legacy.buildStrategyValidation(series, horizons, oosStart, normalizedCost);
  const allDates = [...new Set(series.flatMap((s) => s.bars.map((bar) => bar.tradeDate)))].sort();
  const baseTrades = new Map<string, SimulatedTrade[]>(legacy.STRATEGY_SCENARIOS.map((scenario) => [
    scenario.id,
    series.flatMap((s) => legacy.simulateScenario(s, scenario, normalizedCost)),
  ]));
  const commonStart = [...baseTrades.values()].flat().map((t) => t.entryDate).sort()[0] ?? null;
  const metric = (trades: SimulatedTrade[], split: "ALL" | "OOS") => portfolioMetric(
    filterSplit(trades, split, oosStart), series, allDates,
    split === "OOS" ? oosStart : commonStart, normalizedCost,
  );

  // 모든 포트폴리오 기반 수치를 동일한 수정 회계로 재계산한다.
  const portfolioRows = original.portfolioRows.map((row) => {
    const scenario = findScenario(row.strategy);
    if (!scenario) return row;
    const p = metric(baseTrades.get(scenario.id) ?? [], row.split);
    return { ...row, trades: p.trades, totalReturn: p.totalReturn, cagr: p.cagr, mdd: p.mdd,
      sharpe: p.sharpe, activeDayRate: p.activeDayRate, avgActivePositions: p.avgActivePositions,
      peakActivePositions: p.peakActivePositions, averageHoldingDays: p.averageHoldingDays };
  });

  const coreMetrics = new Map<string, PortfolioMetric>();
  for (const strategy of legacy.CORE_STRATEGIES) {
    for (const split of ["ALL", "OOS"] as const) {
      coreMetrics.set(`${strategy.id}|${split}`, metric(baseTrades.get(strategy.id) ?? [], split));
    }
  }
  const riskRows = original.riskRows.map((row) => ({ ...row,
    portfolioMdd: coreMetrics.get(`${row.strategy}|${row.split}`)?.mdd ?? row.portfolioMdd }));
  const yearlyRows = original.yearlyRows.map((row) => {
    const p = coreMetrics.get(`${row.strategy}|${row.split}`);
    if (!p) return row;
    const days = p.daily.filter((d) => d.date.startsWith(row.segment));
    const portfolioReturn = days.length
      ? (days.reduce((eq, d) => eq * (1 + d.ret), 1) - 1) * 100 : null;
    return { ...row, portfolioReturn };
  });

  const recalcOverlay = <T extends { scenario: string; overlayId: string; split: "ALL" | "OOS" }>(row: T) => {
    const scenario = findScenario(row.scenario);
    const overlay = overlayById(row.overlayId);
    if (!scenario || !overlay) return null;
    return metric(overlayTrades(series, scenario, overlay, normalizedCost, baseTrades), row.split);
  };
  const fixedStopRows = original.fixedStopRows.map((row) => {
    const p = recalcOverlay(row); return p ? { ...row, portfolioCagr: p.cagr,
      portfolioMdd: p.mdd, portfolioSharpe: p.sharpe } : row;
  });
  const atrStopRows = original.atrStopRows.map((row) => {
    const p = recalcOverlay(row); return p ? { ...row, portfolioCagr: p.cagr,
      portfolioMdd: p.mdd, portfolioSharpe: p.sharpe } : row;
  });

  const gateCache = new Map<string, SimulatedTrade[]>();
  const regimeGateRows = original.regimeGateRows.map((row) => {
    const scenario = findScenario(row.strategy);
    if (!scenario) return row;
    const key = `${scenario.id}|${row.gate}`;
    if (!gateCache.has(key)) gateCache.set(key,
      gateTrades(series, scenario, row.gate, normalizedCost, baseTrades));
    const p = metric(gateCache.get(key) ?? [], row.split);
    return { ...row, cagr: p.cagr, mdd: p.mdd, sharpe: p.sharpe,
      avgActivePositions: p.avgActivePositions };
  });

  // 동시보유 제한은 수정된 active 정의와 함께 다시 시뮬레이션한다.
  const positionCapRows: PositionCapComparisonRow[] = [];
  for (const strategy of legacy.CORE_STRATEGIES) {
    const unlimited = baseTrades.get(strategy.id) ?? [];
    const simulations = new Map<number, CapacitySimulation>(legacy.V6_POSITION_CAPS.map((cap) => [
      cap, simulateWithPositionCap(series, strategy, normalizedCost, cap),
    ]));
    for (const split of ["ALL", "OOS"] as const) {
      const u = metric(unlimited, split);
      positionCapRows.push({ strategy: strategy.id, strategyLabel: strategy.label, split,
        cap: null, capLabel: "제한 없음", trades: filterSplit(unlimited, split, oosStart).length,
        skippedForCapacity: 0, cagr: u.cagr, mdd: u.mdd, sharpe: u.sharpe,
        totalReturn: u.totalReturn, activeDayRate: u.activeDayRate,
        avgActivePositions: u.avgActivePositions, peakActivePositions: u.peakActivePositions });

      for (const cap of legacy.V6_POSITION_CAPS) {
        const sim = simulations.get(cap)!;
        const p = metric(sim.trades, split);
        if (p.peakActivePositions > cap) throw new Error(
          `Position-cap accounting regression: ${strategy.id} cap=${cap}, peak=${p.peakActivePositions}`,
        );
        const skipped = split === "ALL" ? sim.skippedForCapacity
          : oosStart === null ? 0 : sim.skippedSignalDates.filter((d) => d >= oosStart).length;
        positionCapRows.push({ strategy: strategy.id, strategyLabel: strategy.label, split,
          cap, capLabel: `최대 ${cap}종목`, trades: filterSplit(sim.trades, split, oosStart).length,
          skippedForCapacity: skipped, cagr: p.cagr, mdd: p.mdd, sharpe: p.sharpe,
          totalReturn: p.totalReturn, activeDayRate: p.activeDayRate,
          avgActivePositions: p.avgActivePositions, peakActivePositions: p.peakActivePositions });
      }
    }
  }

  const assumptions = original.assumptions.filter((t) => !t.startsWith("포트폴리오:")).concat([
    "포트폴리오 일수익률: 전일 종가→당일 시가 overnight leg와 시가 청산/신규진입 후 intraday leg를 순차 복리해 같은 자금의 시가 교체매매 중복계상을 제거",
    "포트폴리오 보유종목 수: overnight 보유수와 시가 후 보유수를 합산하지 않고 둘 중 큰 값으로 집계하여 동시보유 cap과 일치",
    "종목별 해당 거래일 봉이 없는 경우(거래정지 등) 해당 구간 수익률은 0%로 두되 보유 슬롯은 유지",
    "동시보유 cap 결과는 최대 보유종목이 cap을 넘으면 계산 오류로 즉시 중단하는 무결성 검사를 적용",
    "신호가 없는 날은 현금(수익률 0), 무위험수익률 0 가정",
  ]);

  return { ...original, portfolioRows, riskRows, yearlyRows, fixedStopRows, atrStopRows,
    regimeGateRows, positionCapRows, assumptions };
}
