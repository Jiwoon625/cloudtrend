import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  parseSharedMarketData as parseManualMarketData,
  loadResearchTexts,
} from "./research-shared-input";
import {
  buildPortfolioCandidates,
  buildPortfolioSignalContext,
  type PortfolioCandidateTrade,
  type PortfolioSeries,
  type PortfolioStrategyDefinition,
} from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import type { MarketDataset } from "../src/lib/engine/dataset";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8-11 KOSDAQ80 Exit Portfolio 3-FOS" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const LIMIT = 613;
const INITIAL_CAPITAL = 100_000_000;
const ROUND_TRIP_COST_BPS = 30;
const SECTOR_OVERHEAT_THRESHOLD = 80;

type FoldYear = (typeof FOLD_YEARS)[number];

type ExitScenarioId = "UP95_H60" | "DOWN25_H40" | "TIME60" | "BOTH95_DOWN25_H60";

interface ExitScenario extends PortfolioStrategyDefinition {
  id: ExitScenarioId;
}

const EXIT_SCENARIOS: ExitScenario[] = [
  {
    id: "UP95_H60",
    group: "A",
    label: "KOSDAQ80 · ↑95 / max 60D",
    priceLeadershipOverheatThreshold: SECTOR_OVERHEAT_THRESHOLD,
    entryThreshold: 80,
    upsideExitThreshold: 95,
    downsideExitThreshold: -1,
    maxHoldingDays: 60,
  },
  {
    id: "DOWN25_H40",
    group: "A",
    label: "KOSDAQ80 · ↓25 / max 40D",
    priceLeadershipOverheatThreshold: SECTOR_OVERHEAT_THRESHOLD,
    entryThreshold: 80,
    upsideExitThreshold: 101,
    downsideExitThreshold: 25,
    maxHoldingDays: 40,
  },
  {
    id: "TIME60",
    group: "A",
    label: "KOSDAQ80 · TIME ONLY / 60D",
    priceLeadershipOverheatThreshold: SECTOR_OVERHEAT_THRESHOLD,
    entryThreshold: 80,
    upsideExitThreshold: 101,
    downsideExitThreshold: -1,
    maxHoldingDays: 60,
  },
  {
    id: "BOTH95_DOWN25_H60",
    group: "A",
    label: "KOSDAQ80 · ↑95 or ↓25 / max 60D",
    priceLeadershipOverheatThreshold: SECTOR_OVERHEAT_THRESHOLD,
    entryThreshold: 80,
    upsideExitThreshold: 95,
    downsideExitThreshold: 25,
    maxHoldingDays: 60,
  },
];

interface CapacitySpec {
  id: "P10" | "P20" | "P30" | "UNCAPPED";
  label: string;
  maxPositions: number | null;
}

const CAPACITY_SPECS: CapacitySpec[] = [
  { id: "P10", label: "10 positions", maxPositions: 10 },
  { id: "P20", label: "20 positions", maxPositions: 20 },
  { id: "P30", label: "30 positions", maxPositions: 30 },
  { id: "UNCAPPED", label: "Uncapped benchmark", maxPositions: null },
];

interface Options {
  sourceManifest: string;
  sourceCacheDir: string;
  userId: string | null;
  upload: boolean;
}

interface Position {
  candidate: PortfolioCandidateTrade;
  shares: number;
  entryNotional: number;
  entryFee: number;
  lastMark: number;
}

interface ClosedTrade extends PortfolioCandidateTrade {
  entryNotional: number;
  entryFee: number;
  exitGross: number;
  exitFee: number;
  netReturn: number;
}

interface EquityPoint {
  date: string;
  equity: number;
  dailyReturn: number;
  cashWeight: number;
  activePositions: number;
  drawdown: number;
}

interface SimulationResult {
  points: EquityPoint[];
  trades: ClosedTrade[];
  candidateSignals: number;
  skippedForCapacity: number;
  skippedAlreadyHeld: number;
  skippedForCash: number;
  totalFees: number;
  peakCandidateConcurrency: number;
  slotCount: number;
}

interface FoldRow {
  scenario: ExitScenarioId;
  scenarioLabel: string;
  fold: FoldYear;
  capacity: CapacitySpec["id"];
  capacityLabel: string;
  maxPositions: number | null;
  slotCount: number;
  slotWeightPct: number;
  peakCandidateConcurrency: number;
  roundTripCostBps: number;
  candidateSignals: number;
  trades: number;
  skippedForCapacity: number;
  skippedAlreadyHeld: number;
  skippedForCash: number;
  totalReturn: number | null;
  zeroCostTotalReturn: number | null;
  costDragPctPoint: number | null;
  benchmarkReturn: number | null;
  portfolioExcessReturn: number | null;
  cagr: number | null;
  mdd: number | null;
  medianTradeReturn: number | null;
  avgTradeReturn: number | null;
  winRate: number | null;
  profitFactor: number | null;
  averageHoldingDays: number | null;
  avgCapitalOccupancy: number | null;
  avgActivePositions: number | null;
  peakActivePositions: number;
  activeDayRate: number | null;
  totalFees: number;
}

interface AggregateRow {
  scenario: ExitScenarioId;
  scenarioLabel: string;
  capacity: CapacitySpec["id"];
  capacityLabel: string;
  folds: number;
  foldsPositiveReturn: number;
  foldsPositiveExcess: number;
  avgTotalReturn: number | null;
  avgPortfolioExcessReturn: number | null;
  avgCagr: number | null;
  avgMdd: number | null;
  worstFoldMdd: number | null;
  avgMedianTradeReturn: number | null;
  avgTradeReturn: number | null;
  avgProfitFactor: number | null;
  avgCapitalOccupancy: number | null;
  avgActivePositions: number | null;
  maxPeakActivePositions: number;
  avgTrades: number | null;
  totalCapacitySkips: number;
  avgCostDragPctPoint: number | null;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node scripts/run-v8-kosdaq80-exit-portfolio-3fos.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    sourceManifest: "",
    sourceCacheDir: "",
    userId: process.env["SUPABASE_USER_ID"] ?? null,
    upload: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source-manifest")
      options.sourceManifest = argv[++i] ?? usage("--source-manifest 값이 없습니다.");
    else if (arg === "--source-cache-dir")
      options.sourceCacheDir = argv[++i] ?? usage("--source-cache-dir 값이 없습니다.");
    else if (arg === "--supabase-user-id")
      options.userId = argv[++i] ?? usage("--supabase-user-id 값이 없습니다.");
    else if (arg === "--upload") options.upload = true;
    else usage(`지원하지 않는 인자입니다: ${arg}`);
  }
  if (!options.sourceManifest || !options.sourceCacheDir)
    usage("source manifest와 cache dir가 필요합니다.");
  if (options.upload && !/^[0-9a-f-]{36}$/i.test(options.userId ?? ""))
    usage("업로드에는 유효한 Supabase user id가 필요합니다.");
  return options;
}

const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)]! + sorted[Math.ceil(mid)]!) / 2;
}

function round(value: number | null, digits = 6) {
  if (!finite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function loadCachedTexts(manifestPath: string, cacheDir: string) {
  return loadResearchTexts(manifestPath, cacheDir);
}

function key(market: string, symbol: string) {
  return `${market}:${symbol}`;
}

function lookupSeries(series: PortfolioSeries[]) {
  return new Map(series.map((item) => [key(item.market, item.symbol), item]));
}

function markPrice(
  position: Position,
  date: string,
  timing: "OPEN" | "CLOSE",
  seriesMap: Map<string, PortfolioSeries>,
) {
  const series = seriesMap.get(key(position.candidate.market, position.candidate.symbol));
  const index = series?.dateIndex.get(date);
  const bar = index === undefined ? undefined : series?.bars[index];
  const price = timing === "OPEN" ? bar?.open : bar?.close;
  return finite(price) && price > 0 ? price : position.lastMark;
}

function candidatePriority(a: PortfolioCandidateTrade, b: PortfolioCandidateTrade) {
  if (b.adjustedScore10 !== a.adjustedScore10) return b.adjustedScore10 - a.adjustedScore10;
  const aRise = a.scoreRise5d ?? -Infinity;
  const bRise = b.scoreRise5d ?? -Infinity;
  if (bRise !== aRise) return bRise - aRise;
  if (b.signalTradingValue !== a.signalTradingValue)
    return b.signalTradingValue - a.signalTradingValue;
  return a.symbol.localeCompare(b.symbol);
}

function datesForCandidates(allDates: string[], candidates: PortfolioCandidateTrade[]) {
  if (!candidates.length) return [];
  const start = candidates.reduce(
    (min, item) => (item.entryDate < min ? item.entryDate : min),
    candidates[0]!.entryDate,
  );
  const end = candidates.reduce(
    (max, item) => (item.exitDate > max ? item.exitDate : max),
    candidates[0]!.exitDate,
  );
  return allDates.filter((date) => date >= start && date <= end);
}

function peakCandidateConcurrency(candidates: PortfolioCandidateTrade[], dates: string[]) {
  const byEntry = new Map<string, PortfolioCandidateTrade[]>();
  for (const candidate of candidates) {
    const list = byEntry.get(candidate.entryDate) ?? [];
    list.push(candidate);
    byEntry.set(candidate.entryDate, list);
  }
  for (const list of byEntry.values()) list.sort(candidatePriority);

  const active = new Map<string, PortfolioCandidateTrade>();
  let peak = 0;
  for (const date of dates) {
    for (const [positionKey, candidate] of [...active]) {
      if (candidate.exitDate === date && candidate.exitTiming === "OPEN")
        active.delete(positionKey);
    }
    for (const candidate of byEntry.get(date) ?? []) {
      const positionKey = key(candidate.market, candidate.symbol);
      if (!active.has(positionKey)) active.set(positionKey, candidate);
    }
    peak = Math.max(peak, active.size);
    for (const [positionKey, candidate] of [...active]) {
      if (candidate.exitDate === date && candidate.exitTiming === "CLOSE")
        active.delete(positionKey);
    }
  }
  return Math.max(1, peak);
}

function simulatePortfolio(
  candidates: PortfolioCandidateTrade[],
  series: PortfolioSeries[],
  dates: string[],
  capacity: CapacitySpec,
  roundTripCostBps: number,
): SimulationResult {
  const seriesMap = lookupSeries(series);
  const halfCost = Math.max(0, roundTripCostBps) / 20_000;
  const peakConcurrency = peakCandidateConcurrency(candidates, dates);
  const slotCount = capacity.maxPositions ?? peakConcurrency;
  const targetWeight = 1 / Math.max(1, slotCount);

  const byEntry = new Map<string, PortfolioCandidateTrade[]>();
  for (const candidate of candidates) {
    const list = byEntry.get(candidate.entryDate) ?? [];
    list.push(candidate);
    byEntry.set(candidate.entryDate, list);
  }
  for (const list of byEntry.values()) list.sort(candidatePriority);

  const positions = new Map<string, Position>();
  const trades: ClosedTrade[] = [];
  const points: EquityPoint[] = [];
  let cash = INITIAL_CAPITAL;
  let previousEquity = INITIAL_CAPITAL;
  let peakEquity = INITIAL_CAPITAL;
  let totalFees = 0;
  let skippedForCapacity = 0;
  let skippedAlreadyHeld = 0;
  let skippedForCash = 0;

  const closePosition = (positionKey: string, position: Position, price: number) => {
    const exitGross = position.shares * price;
    const exitFee = exitGross * halfCost;
    cash += exitGross - exitFee;
    totalFees += exitFee;
    const costBasis = position.entryNotional + position.entryFee;
    const netReturn = costBasis > 0 ? ((exitGross - exitFee) / costBasis - 1) * 100 : 0;
    trades.push({
      ...position.candidate,
      entryNotional: position.entryNotional,
      entryFee: position.entryFee,
      exitGross,
      exitFee,
      netReturn,
    });
    positions.delete(positionKey);
  };

  for (const date of dates) {
    for (const position of positions.values())
      position.lastMark = markPrice(position, date, "OPEN", seriesMap);

    for (const [positionKey, position] of [...positions]) {
      if (position.candidate.exitDate === date && position.candidate.exitTiming === "OPEN")
        closePosition(positionKey, position, position.candidate.exitPrice);
    }

    const openMarked = [...positions.values()].reduce(
      (sum, position) => sum + position.shares * position.lastMark,
      0,
    );
    const openEquity = cash + openMarked;

    for (const candidate of byEntry.get(date) ?? []) {
      const positionKey = key(candidate.market, candidate.symbol);
      if (positions.has(positionKey)) {
        skippedAlreadyHeld += 1;
        continue;
      }
      if (capacity.maxPositions !== null && positions.size >= capacity.maxPositions) {
        skippedForCapacity += 1;
        continue;
      }
      const targetNotional = openEquity * targetWeight;
      const maxAffordable = cash / (1 + halfCost);
      const entryNotional = Math.min(targetNotional, maxAffordable);
      if (!(entryNotional > 1)) {
        skippedForCash += 1;
        continue;
      }
      const shares = entryNotional / candidate.entryPrice;
      const entryFee = entryNotional * halfCost;
      cash -= entryNotional + entryFee;
      totalFees += entryFee;
      positions.set(positionKey, {
        candidate,
        shares,
        entryNotional,
        entryFee,
        lastMark: candidate.entryPrice,
      });
    }

    for (const position of positions.values())
      position.lastMark = markPrice(position, date, "CLOSE", seriesMap);

    for (const [positionKey, position] of [...positions]) {
      if (position.candidate.exitDate === date && position.candidate.exitTiming === "CLOSE")
        closePosition(positionKey, position, position.candidate.exitPrice);
    }

    const marked = [...positions.values()].reduce(
      (sum, position) => sum + position.shares * position.lastMark,
      0,
    );
    const equity = cash + marked;
    peakEquity = Math.max(peakEquity, equity);
    const dailyReturn = previousEquity > 0 ? (equity / previousEquity - 1) * 100 : 0;
    const drawdown = peakEquity > 0 ? (equity / peakEquity - 1) * 100 : 0;
    points.push({
      date,
      equity,
      dailyReturn,
      cashWeight: equity > 0 ? (cash / equity) * 100 : 100,
      activePositions: positions.size,
      drawdown,
    });
    previousEquity = equity;
  }

  return {
    points,
    trades,
    candidateSignals: candidates.length,
    skippedForCapacity,
    skippedAlreadyHeld,
    skippedForCash,
    totalFees,
    peakCandidateConcurrency: peakConcurrency,
    slotCount,
  };
}

function benchmarkReturn(dataset: MarketDataset, startDate: string, endDate: string) {
  const bars = dataset.indexSeries.find((item) => item.indexCode === "KOSDAQ")?.bars ?? [];
  const map = new Map(bars.map((bar) => [bar.tradeDate, bar]));
  const start = map.get(startDate);
  const end = map.get(endDate);
  if (
    !start ||
    !end ||
    !finite(start.open) ||
    start.open <= 0 ||
    !finite(end.close) ||
    end.close <= 0
  )
    return null;
  return (end.close / start.open - 1) * 100;
}

function profitFactor(returns: number[]) {
  const wins = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(
    returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
  );
  return losses > 0 ? wins / losses : null;
}

function makeFoldRow(
  scenario: ExitScenario,
  fold: FoldYear,
  capacity: CapacitySpec,
  simulation: SimulationResult,
  zeroCost: SimulationResult,
  dataset: MarketDataset,
): FoldRow {
  const points = simulation.points;
  const finalEquity = points.at(-1)?.equity ?? INITIAL_CAPITAL;
  const zeroFinalEquity = zeroCost.points.at(-1)?.equity ?? INITIAL_CAPITAL;
  const totalReturn = points.length ? (finalEquity / INITIAL_CAPITAL - 1) * 100 : null;
  const zeroCostTotalReturn = zeroCost.points.length
    ? (zeroFinalEquity / INITIAL_CAPITAL - 1) * 100
    : null;
  const years = points.length / 252;
  const cagr =
    years > 0 && finalEquity > 0
      ? ((finalEquity / INITIAL_CAPITAL) ** (1 / years) - 1) * 100
      : null;
  const netReturns = simulation.trades.map((trade) => trade.netReturn);
  const startDate = points[0]?.date;
  const endDate = points.at(-1)?.date;
  const benchmark = startDate && endDate ? benchmarkReturn(dataset, startDate, endDate) : null;
  const avgCashWeight = average(points.map((point) => point.cashWeight));
  const activeDays = points.filter((point) => point.activePositions > 0).length;
  const mdd = points.length ? Math.min(...points.map((point) => point.drawdown)) : null;

  return {
    scenario: scenario.id,
    scenarioLabel: scenario.label,
    fold,
    capacity: capacity.id,
    capacityLabel: capacity.label,
    maxPositions: capacity.maxPositions,
    slotCount: simulation.slotCount,
    slotWeightPct: round(100 / simulation.slotCount) ?? 0,
    peakCandidateConcurrency: simulation.peakCandidateConcurrency,
    roundTripCostBps: ROUND_TRIP_COST_BPS,
    candidateSignals: simulation.candidateSignals,
    trades: simulation.trades.length,
    skippedForCapacity: simulation.skippedForCapacity,
    skippedAlreadyHeld: simulation.skippedAlreadyHeld,
    skippedForCash: simulation.skippedForCash,
    totalReturn: round(totalReturn),
    zeroCostTotalReturn: round(zeroCostTotalReturn),
    costDragPctPoint:
      finite(totalReturn) && finite(zeroCostTotalReturn)
        ? round(totalReturn - zeroCostTotalReturn)
        : null,
    benchmarkReturn: round(benchmark),
    portfolioExcessReturn:
      finite(totalReturn) && finite(benchmark) ? round(totalReturn - benchmark) : null,
    cagr: round(cagr),
    mdd: round(mdd),
    medianTradeReturn: round(median(netReturns)),
    avgTradeReturn: round(average(netReturns)),
    winRate: netReturns.length
      ? round((netReturns.filter((value) => value > 0).length / netReturns.length) * 100)
      : null,
    profitFactor: round(profitFactor(netReturns)),
    averageHoldingDays: round(average(simulation.trades.map((trade) => trade.holdingDays))),
    avgCapitalOccupancy: finite(avgCashWeight) ? round(100 - avgCashWeight) : null,
    avgActivePositions: round(average(points.map((point) => point.activePositions))),
    peakActivePositions: points.length
      ? Math.max(...points.map((point) => point.activePositions))
      : 0,
    activeDayRate: points.length ? round((activeDays / points.length) * 100) : null,
    totalFees: round(simulation.totalFees, 2) ?? 0,
  };
}

function aggregateRows(rows: FoldRow[]): AggregateRow[] {
  const out: AggregateRow[] = [];
  for (const scenario of EXIT_SCENARIOS) {
    for (const capacity of CAPACITY_SPECS) {
      const selected = rows.filter(
        (row) => row.scenario === scenario.id && row.capacity === capacity.id,
      );
      out.push({
        scenario: scenario.id,
        scenarioLabel: scenario.label,
        capacity: capacity.id,
        capacityLabel: capacity.label,
        folds: selected.length,
        foldsPositiveReturn: selected.filter(
          (row) => finite(row.totalReturn) && row.totalReturn > 0,
        ).length,
        foldsPositiveExcess: selected.filter(
          (row) => finite(row.portfolioExcessReturn) && row.portfolioExcessReturn > 0,
        ).length,
        avgTotalReturn: round(average(selected.map((row) => row.totalReturn).filter(finite))),
        avgPortfolioExcessReturn: round(
          average(selected.map((row) => row.portfolioExcessReturn).filter(finite)),
        ),
        avgCagr: round(average(selected.map((row) => row.cagr).filter(finite))),
        avgMdd: round(average(selected.map((row) => row.mdd).filter(finite))),
        worstFoldMdd: selected.length
          ? round(Math.min(...selected.map((row) => row.mdd).filter(finite)))
          : null,
        avgMedianTradeReturn: round(
          average(selected.map((row) => row.medianTradeReturn).filter(finite)),
        ),
        avgTradeReturn: round(average(selected.map((row) => row.avgTradeReturn).filter(finite))),
        avgProfitFactor: round(average(selected.map((row) => row.profitFactor).filter(finite))),
        avgCapitalOccupancy: round(
          average(selected.map((row) => row.avgCapitalOccupancy).filter(finite)),
        ),
        avgActivePositions: round(
          average(selected.map((row) => row.avgActivePositions).filter(finite)),
        ),
        maxPeakActivePositions: selected.length
          ? Math.max(...selected.map((row) => row.peakActivePositions))
          : 0,
        avgTrades: round(average(selected.map((row) => row.trades))),
        totalCapacitySkips: selected.reduce((sum, row) => sum + row.skippedForCapacity, 0),
        avgCostDragPctPoint: round(
          average(selected.map((row) => row.costDragPctPoint).filter(finite)),
        ),
      });
    }
  }
  return out;
}

export async function runStudy() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const parsed = parseManualMarketData(texts);
  const dataset = parsed.dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);

  const foldRows: FoldRow[] = [];
  const candidateCounts: Array<{
    scenario: ExitScenarioId;
    fold: FoldYear;
    signals: number;
    peakConcurrency: number;
  }> = [];

  for (const scenario of EXIT_SCENARIOS) {
    const allCandidates = buildPortfolioCandidates(context.series, scenario).filter(
      (candidate) => candidate.market === "KOSDAQ",
    );

    for (const fold of FOLD_YEARS) {
      const candidates = allCandidates.filter(
        (candidate) => Number(candidate.signalDate.slice(0, 4)) === fold,
      );
      const dates = datesForCandidates(context.allDates, candidates);
      const peakConcurrency = peakCandidateConcurrency(candidates, dates);
      candidateCounts.push({
        scenario: scenario.id,
        fold,
        signals: candidates.length,
        peakConcurrency,
      });

      for (const capacity of CAPACITY_SPECS) {
        const simulation = simulatePortfolio(
          candidates,
          context.series,
          dates,
          capacity,
          ROUND_TRIP_COST_BPS,
        );
        const zeroCost = simulatePortfolio(candidates, context.series, dates, capacity, 0);
        foldRows.push(makeFoldRow(scenario, fold, capacity, simulation, zeroCost, dataset));
      }
    }
  }

  const aggregate = aggregateRows(foldRows);
  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const result = {
    version: STUDY_VERSION,
    createdAt,
    runId,
    data: {
      datasetVersion: dataset.version,
      asOfDate: dataset.asOfDate,
      sourceCacheKey: manifest.cacheKey,
      sourceFiles: manifest.fileCount,
      sourceBytes: manifest.totalBytes,
      symbolCount: context.symbolCount,
    },
    design: {
      folds: [...FOLD_YEARS],
      market: "KOSDAQ",
      onsetThresholdPercent: 80,
      scoreModel: "Frozen V8 10-point score; sector PL>=80 receives no 0.5-point sector slot.",
      entryExecution: "NEXT_OPEN",
      scoreExitExecution: "NEXT_OPEN after threshold crossing on prior close",
      timeExitExecution: "SAME_DAY_CLOSE at max holding",
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      initialCapital: INITIAL_CAPITAL,
      positionSizing:
        "Fixed slot weights: 10=10%, 20=5%, 30=3.333%. UNCAPPED uses 1 / ex-post peak candidate concurrency within each fold/scenario as a research benchmark only.",
      fractionalShares: true,
      duplicateEntryAllowed: false,
      priority: [
        "adjustedScore10 desc",
        "scoreRise5d desc",
        "signalTradingValue desc",
        "symbol asc",
      ],
    },
    scenarios: EXIT_SCENARIOS,
    capacities: CAPACITY_SPECS,
    candidateCounts,
    aggregateRows: aggregate,
    foldRows,
    notes: [
      "This study does not re-test KOSDAQ80 entry. It freezes the final V8 10-point score and compares exit/capacity rules only.",
      "30 bps is treated as round-trip trading cost: 15 bps at entry and 15 bps at exit, proportional to traded notional.",
      "The uncapped case is a diagnostic no-capacity benchmark, not an implementable sizing rule, because its fixed slot size uses the realized peak candidate concurrency of that fold/scenario.",
      "Portfolio MDD, capital occupancy and concurrent holdings require path simulation and therefore cannot be inferred from the prior V8-4 per-signal aggregate table alone.",
      "Late-year signals are included based on signal year; their exits may occur after calendar year-end, matching the signal-anchored 3-FOS convention used in prior horizon tests.",
    ],
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `v8-11-kosdaq80-exit-portfolio-3fos-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-11-kosdaq80-exit-portfolio-3fos/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(
      client,
      `${options.userId}/results/v8-11-kosdaq80-exit-portfolio-3fos/latest.json`,
      {
        version: STUDY_VERSION,
        createdAt,
        runId,
        resultPath: remotePath,
        aggregateRows: aggregate,
      },
    );
  }

  process.stdout.write(
    JSON.stringify({ outputPath, remotePath, aggregateRows: aggregate, candidateCounts }, null, 2),
  );
  process.stdout.write("\n");
}

if (process.argv[1]?.endsWith("run-v8-kosdaq80-exit-portfolio-3fos.ts"))
  runStudy().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
