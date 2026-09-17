import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  buildPortfolioSignalContext,
  type PortfolioCandidateTrade,
  type PortfolioSeries,
} from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import type { MarketDataset } from "../src/lib/engine/dataset";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8 Entry Exit Grid Fixed-Signal 3-FOS" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const LIMIT = 613;
const FROZEN_ENGINE_COMMIT = "badeee98e1427ff95c282cf8c07970d732223196";
const INITIAL_CAPITAL = 100_000_000;
const ROUND_TRIP_COST_BPS = 30;
const ENTRY_THRESHOLDS = [6, 6.5, 7, 7.5, 8, 8.5];
const MARKETS = ["KOSDAQ", "KOSPI"] as const;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const SECTOR_SLOT = 0.5;

type FoldYear = (typeof FOLD_YEARS)[number];
type ExitScenarioId = string;

interface ExitScenario {
  market: "KOSDAQ" | "KOSPI";
  entryThreshold: number;
  id: ExitScenarioId;
  label: string;
  upsideExitThreshold: number | null;
  downsideExitThreshold: number | null;
  maxHoldingDays: number;
}

const EXIT_SCENARIOS: ExitScenario[] = [];
for (const market of MARKETS)
  for (const entryThreshold of ENTRY_THRESHOLDS)
    for (const upsideExitThreshold of [8, 8.5, 9, 9.5, null]) {
      if (upsideExitThreshold !== null && upsideExitThreshold <= entryThreshold) continue;
      for (const downsideExitThreshold of [2.5, 3, 4, 5, null])
        for (const maxHoldingDays of [20, 30, 40, 60]) {
          const id = `${market}-E${entryThreshold}-U${upsideExitThreshold ?? "X"}-D${downsideExitThreshold ?? "X"}-H${maxHoldingDays}`;
          EXIT_SCENARIOS.push({
            id,
            label: id,
            market,
            entryThreshold,
            upsideExitThreshold,
            downsideExitThreshold,
            maxHoldingDays,
          });
        }
    }

interface CapacitySpec {
  id: "P10" | "P20" | "P30" | "UNCAPPED";
  label: string;
  maxPositions: number | null;
}

const CAPACITY_SPECS: CapacitySpec[] = [{ id: "P30", label: "30 positions", maxPositions: 30 }];

interface CacheManifestFile {
  id: string;
  fileName: string;
  bytes: number;
  savedAt: string;
  fileHash: string;
  cacheFile: string;
}

interface CacheManifest {
  schemaVersion: 1;
  sourceType: "backtest";
  cacheKey: string;
  fileCount: number;
  totalBytes: number;
  files: CacheManifestFile[];
}

interface Options {
  sourceManifest: string;
  sourceCacheDir: string;
  userId: string | null;
  upload: boolean;
}

interface EntrySignal {
  series: PortfolioSeries;
  signalIndex: number;
  signalDate: string;
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
  annualizedVolatility: number | null;
  sharpe: number | null;
  fold: FoldYear;
  capacity: CapacitySpec["id"];
  capacityLabel: string;
  maxPositions: number | null;
  slotCount: number;
  slotWeightPct: number;
  peakCandidateConcurrency: number;
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
  meanSharpe: number | null;
  worstFoldReturn: number | null;
  meanAnnualizedVolatility: number | null;
  capacity: CapacitySpec["id"];
  capacityLabel: string;
  folds: number;
  foldsPositiveReturn: number;
  foldsPositiveExcess: number;
  avgTotalReturn: number | null;
  medianFoldTotalReturn: number | null;
  avgPortfolioExcessReturn: number | null;
  medianFoldExcessReturn: number | null;
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
      "  npx vite-node scripts/run-v8-kosdaq80-exit-portfolio-fixed-entry-3fos.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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
const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
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

function decodeSourceBytes(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

async function loadCachedTexts(manifestPath: string, cacheDir: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CacheManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.sourceType !== "backtest" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== manifest.fileCount
  )
    throw new Error("지원하지 않거나 손상된 source cache manifest입니다.");
  const texts: string[] = [];
  for (const file of manifest.files) {
    const bytes = new Uint8Array(await readFile(path.join(cacheDir, file.cacheFile)));
    const fileHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== file.bytes || fileHash !== file.fileHash)
      throw new Error(`source cache 무결성 검증 실패: ${file.fileName}`);
    texts.push(decodeSourceBytes(bytes));
  }
  process.stderr.write(
    `V8-11b source cache verified: ${manifest.fileCount} files / ${(manifest.totalBytes / 1_000_000).toFixed(1)} MB\n`,
  );
  return { texts, manifest };
}

function adjustedScoreAt(series: PortfolioSeries, index: number) {
  const base = series.baseScores[index];
  if (!finite(base)) return null;
  const sectorPl = series.sectorPriceLeadership[index] ?? null;
  const sectorContribution =
    finite(sectorPl) && sectorPl < SECTOR_OVERHEAT_THRESHOLD ? SECTOR_SLOT : 0;
  return Math.min(10, Math.max(0, Math.round((base + sectorContribution) * 100) / 100));
}

function crossedUp(previous: number | null, current: number | null, threshold: number) {
  return finite(previous) && finite(current) && previous < threshold && current >= threshold;
}

function crossedDown(previous: number | null, current: number | null, threshold: number) {
  return finite(previous) && finite(current) && previous >= threshold && current < threshold;
}

function buildFixedEntrySignals(series: PortfolioSeries[], market: string, entryThreshold: number) {
  const out: EntrySignal[] = [];
  for (const item of series) {
    if (item.market !== market) continue;
    for (let i = 120; i + 1 < item.bars.length; i++) {
      if (!crossedUp(adjustedScoreAt(item, i - 1), adjustedScoreAt(item, i), entryThreshold))
        continue;
      const entry = item.bars[i + 1];
      if (!entry || !finite(entry.open) || entry.open <= 0) continue;
      out.push({ series: item, signalIndex: i, signalDate: item.bars[i]!.tradeDate });
    }
  }
  return out;
}

function scoreRise(series: PortfolioSeries, index: number, lag = 5) {
  const current = adjustedScoreAt(series, index);
  const previous = adjustedScoreAt(series, index - lag);
  return finite(current) && finite(previous) ? (current - previous) * 10 : null;
}

function buildCandidate(
  signal: EntrySignal,
  scenario: ExitScenario,
): PortfolioCandidateTrade | null {
  const series = signal.series;
  const signalIndex = signal.signalIndex;
  const entryIndex = signalIndex + 1;
  const plannedExit = signalIndex + scenario.maxHoldingDays;
  const entry = series.bars[entryIndex];
  if (!entry || !finite(entry.open) || entry.open <= 0) return null;

  let exitIndex = -1;
  let exitPrice = 0;
  let exitReason: PortfolioCandidateTrade["exitReason"] = "TIME";
  let exitTiming: PortfolioCandidateTrade["exitTiming"] = "CLOSE";

  for (let j = entryIndex; j <= Math.min(plannedExit, series.bars.length - 1); j++) {
    const bar = series.bars[j]!;
    if (![bar.open, bar.close, bar.low, bar.high].every((value) => finite(value) && value > 0))
      return null;
    if (j > entryIndex) {
      const scoreIndex = j - 1;
      const previous = adjustedScoreAt(series, scoreIndex - 1);
      const current = adjustedScoreAt(series, scoreIndex);
      if (
        scenario.downsideExitThreshold !== null &&
        crossedDown(previous, current, scenario.downsideExitThreshold)
      ) {
        exitIndex = j;
        exitPrice = bar.open;
        exitReason = "DOWNSIDE_SCORE";
        exitTiming = "OPEN";
        break;
      }
      if (
        scenario.upsideExitThreshold !== null &&
        crossedUp(previous, current, scenario.upsideExitThreshold)
      ) {
        exitIndex = j;
        exitPrice = bar.open;
        exitReason = "UPSIDE_SCORE";
        exitTiming = "OPEN";
        break;
      }
    }
    if (j === plannedExit) {
      exitIndex = j;
      exitPrice = bar.close;
      break;
    }
  }

  if (exitIndex < 0 || exitPrice <= 0) return null;
  const adjustedScore10 = adjustedScoreAt(series, signalIndex);
  if (!finite(adjustedScore10)) return null;
  const sectorPl = series.sectorPriceLeadership[signalIndex] ?? null;
  return {
    scenarioId: scenario.id,
    symbol: series.symbol,
    name: series.name,
    market: series.market,
    sectorCode: series.sectorCode,
    sectorName: series.sectorName,
    signalDate: series.bars[signalIndex]!.tradeDate,
    entryDate: entry.tradeDate,
    exitDate: series.bars[exitIndex]!.tradeDate,
    signalIndex,
    entryIndex,
    exitIndex,
    entryPrice: entry.open,
    exitPrice,
    exitReason,
    exitTiming,
    holdingDays: exitIndex - entryIndex + 1,
    adjustedScore10,
    baseScore9p5: series.baseScores[signalIndex] ?? null,
    scoreRise5d: scoreRise(series, signalIndex),
    sectorPriceLeadership: sectorPl,
    sectorOverheated: finite(sectorPl) ? sectorPl >= SECTOR_OVERHEAT_THRESHOLD : null,
    signalTradingValue: series.bars[signalIndex]?.tradingValue ?? 0,
    grossReturn: (exitPrice / entry.open - 1) * 100,
    mae: null,
    mfe: null,
  };
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
  const aRise = a.scoreRise5d ?? -Infinity,
    bRise = b.scoreRise5d ?? -Infinity;
  if (bRise !== aRise) return bRise - aRise;
  if (b.signalTradingValue !== a.signalTradingValue)
    return b.signalTradingValue - a.signalTradingValue;
  return a.symbol.localeCompare(b.symbol);
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
    for (const [positionKey, candidate] of [...active])
      if (candidate.exitDate === date && candidate.exitTiming === "OPEN")
        active.delete(positionKey);
    for (const candidate of byEntry.get(date) ?? []) {
      const positionKey = key(candidate.market, candidate.symbol);
      if (!active.has(positionKey)) active.set(positionKey, candidate);
    }
    peak = Math.max(peak, active.size);
    for (const [positionKey, candidate] of [...active])
      if (candidate.exitDate === date && candidate.exitTiming === "CLOSE")
        active.delete(positionKey);
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
  let cash = INITIAL_CAPITAL,
    previousEquity = INITIAL_CAPITAL,
    peakEquity = INITIAL_CAPITAL,
    totalFees = 0;
  let skippedForCapacity = 0,
    skippedAlreadyHeld = 0,
    skippedForCash = 0;

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
    for (const [positionKey, position] of [...positions])
      if (position.candidate.exitDate === date && position.candidate.exitTiming === "OPEN")
        closePosition(positionKey, position, position.candidate.exitPrice);
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
    for (const [positionKey, position] of [...positions])
      if (position.candidate.exitDate === date && position.candidate.exitTiming === "CLOSE")
        closePosition(positionKey, position, position.candidate.exitPrice);
    const marked = [...positions.values()].reduce(
      (sum, position) => sum + position.shares * position.lastMark,
      0,
    );
    const equity = cash + marked;
    peakEquity = Math.max(peakEquity, equity);
    const drawdown = peakEquity > 0 ? (equity / peakEquity - 1) * 100 : 0;
    points.push({
      date,
      equity,
      cashWeight: equity > 0 ? (cash / equity) * 100 : 100,
      activePositions: positions.size,
      drawdown,
    });
    previousEquity = equity;
    void previousEquity;
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

function benchmarkReturn(
  dataset: MarketDataset,
  startDate: string,
  endDate: string,
  market: string,
) {
  const bars = dataset.indexSeries.find((item) => item.indexCode === market)?.bars ?? [];
  const map = new Map(bars.map((bar) => [bar.tradeDate, bar]));
  const start = map.get(startDate),
    end = map.get(endDate);
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
  const startDate = points[0]?.date,
    endDate = points.at(-1)?.date;
  const benchmark =
    startDate && endDate ? benchmarkReturn(dataset, startDate, endDate, scenario.market) : null;
  const avgCashWeight = average(points.map((point) => point.cashWeight));
  const activeDays = points.filter((point) => point.activePositions > 0).length;
  const dailyReturns = points.map(
    (point, index) => point.equity / (index ? points[index - 1]!.equity : INITIAL_CAPITAL) - 1,
  );
  const meanDaily = average(dailyReturns);
  const variance =
    meanDaily !== null && dailyReturns.length > 1
      ? dailyReturns.reduce((sum, value) => sum + (value - meanDaily) ** 2, 0) /
        (dailyReturns.length - 1)
      : null;
  const sd = variance !== null ? Math.sqrt(variance) : null;
  const mdd = points.length ? Math.min(...points.map((point) => point.drawdown)) : null;
  return {
    scenario: scenario.id,
    scenarioLabel: scenario.label,
    annualizedVolatility: sd !== null ? round(sd * Math.sqrt(252) * 100) : null,
    sharpe: sd && meanDaily !== null ? round((meanDaily / sd) * Math.sqrt(252)) : null,
    fold,
    capacity: capacity.id,
    capacityLabel: capacity.label,
    maxPositions: capacity.maxPositions,
    slotCount: simulation.slotCount,
    slotWeightPct: round(100 / simulation.slotCount) ?? 0,
    peakCandidateConcurrency: simulation.peakCandidateConcurrency,
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
  for (const scenario of EXIT_SCENARIOS)
    for (const capacity of CAPACITY_SPECS) {
      const selected = rows.filter(
        (row) => row.scenario === scenario.id && row.capacity === capacity.id,
      );
      const totalReturns = selected.map((row) => row.totalReturn).filter(finite);
      const excessReturns = selected.map((row) => row.portfolioExcessReturn).filter(finite);
      out.push({
        scenario: scenario.id,
        scenarioLabel: scenario.label,
        meanSharpe: round(average(selected.map((row) => row.sharpe).filter(finite))),
        worstFoldReturn: totalReturns.length ? Math.min(...totalReturns) : null,
        meanAnnualizedVolatility: round(
          average(selected.map((row) => row.annualizedVolatility).filter(finite)),
        ),
        capacity: capacity.id,
        capacityLabel: capacity.label,
        folds: selected.length,
        foldsPositiveReturn: selected.filter(
          (row) => finite(row.totalReturn) && row.totalReturn > 0,
        ).length,
        foldsPositiveExcess: selected.filter(
          (row) => finite(row.portfolioExcessReturn) && row.portfolioExcessReturn > 0,
        ).length,
        avgTotalReturn: round(average(totalReturns)),
        medianFoldTotalReturn: round(median(totalReturns)),
        avgPortfolioExcessReturn: round(average(excessReturns)),
        medianFoldExcessReturn: round(median(excessReturns)),
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
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const parsed = parseManualMarketData(texts);
  const dataset = parsed.dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const signalSets = new Map<string, EntrySignal[]>();
  for (const market of MARKETS)
    for (const entry of ENTRY_THRESHOLDS)
      signalSets.set(`${market}:${entry}`, buildFixedEntrySignals(context.series, market, entry));
  const foldSignalCounts = [...signalSets].flatMap(([key, signals]) =>
    FOLD_YEARS.map((fold) => ({
      key,
      fold,
      signals: signals.filter((signal) => Number(signal.signalDate.slice(0, 4)) === fold).length,
    })),
  );
  const foldRows: FoldRow[] = [];
  const candidateCounts: Array<{
    scenario: string;
    fold: number;
    signals: number;
    candidates: number;
    signalAlreadyAtUpside: number;
  }> = [];
  // One identical evaluation window for every exit/entry combination: fold year plus 60 trading days of runoff.
  const foldDates = new Map(
    FOLD_YEARS.map((fold) => {
      const yearDates = context.allDates.filter((date) => Number(date.slice(0, 4)) === fold);
      const start = yearDates[0]!;
      let end = yearDates.at(-1)!;
      for (const signals of signalSets.values())
        for (const signal of signals) {
          if (Number(signal.signalDate.slice(0, 4)) !== fold) continue;
          const planned = signal.series.bars[signal.signalIndex + 60]?.tradeDate;
          if (planned && planned > end) end = planned;
        }
      return [fold, context.allDates.filter((date) => date >= start && date <= end)] as const;
    }),
  );
  for (const [scenarioIndex, scenario] of EXIT_SCENARIOS.entries()) {
    const fixedSignals = signalSets.get(`${scenario.market}:${scenario.entryThreshold}`)!;
    for (const fold of FOLD_YEARS) {
      const foldSignals = fixedSignals.filter(
        (signal) => Number(signal.signalDate.slice(0, 4)) === fold,
      );
      const candidates = foldSignals
        .map((signal) => buildCandidate(signal, scenario))
        .filter((candidate): candidate is PortfolioCandidateTrade => candidate !== null);
      candidateCounts.push({
        scenario: scenario.id,
        fold,
        signals: foldSignals.length,
        candidates: candidates.length,
        signalAlreadyAtUpside:
          scenario.upsideExitThreshold === null
            ? 0
            : foldSignals.filter(
                (signal) =>
                  (adjustedScoreAt(signal.series, signal.signalIndex) ?? -1) >=
                  scenario.upsideExitThreshold!,
              ).length,
      });
      const dates = foldDates.get(fold)!;
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
    if (scenarioIndex % 30 === 0)
      process.stderr.write(`Grid ${scenarioIndex + 1}/${EXIT_SCENARIOS.length} complete\n`);
  }

  const aggregate = aggregateRows(foldRows);
  const baselineReplay = { checked: false, passed: false, comparisons: 0 };
  if (manifest.cacheKey === "f408e1c09c661e14e9ad8a5d8a96db944a2f57a23692ddb024b47d2858dd3855") {
    const expected: Array<[string, number[]]> = [
      ["KOSDAQ-E8-U9.5-D2.5-H60", [-0.310969, -10.792502, 129.548734]],
      ["KOSDAQ-E8-UX-D2.5-H40", [-8.587604, -18.832994, 188.084978]],
      ["KOSDAQ-E8-U9.5-DX-H60", [-9.803876, -16.631361, 114.485134]],
      ["KOSDAQ-E8-UX-DX-H60", [-21.990623, -23.354485, 158.844814]],
    ];
    baselineReplay.checked = true;
    for (const [scenario, returns] of expected)
      FOLD_YEARS.forEach((fold, index) => {
        const actual = foldRows.find(
          (row) => row.scenario === scenario && row.fold === fold,
        )?.totalReturn;
        if (!finite(actual) || Math.abs(actual - returns[index]!) > 0.0001)
          throw new Error(
            `Frozen V8-11b replay failed: ${scenario} ${fold} expected ${returns[index]} actual ${actual}`,
          );
        baselineReplay.comparisons += 1;
      });
    baselineReplay.passed = true;
  }

  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const result = {
    frozenEngineCommit: FROZEN_ENGINE_COMMIT,
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
      markets: MARKETS,
      entryThresholds: ENTRY_THRESHOLDS,
      evaluationWindows: [...foldDates].map(([fold, dates]) => ({
        fold,
        start: dates[0],
        end: dates.at(-1),
        tradingDays: dates.length,
      })),
      entryUniverse:
        "One fixed onset signal set per market and entry threshold, shared by every exit scenario. No entry is excluded because its signal-day score already exceeds an exit threshold.",
      scoreModel:
        "Frozen V8 10-point score. Sector PL missing contributes 0; PL<80 contributes +0.5; PL>=80 contributes +0.",
      entryExecution: "NEXT_OPEN",
      scoreExitExecution: "NEXT_OPEN after threshold crossing on prior close",
      timeExitExecution: "SAME_DAY_CLOSE at max holding",
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      initialCapital: INITIAL_CAPITAL,
      positionSizing:
        "Fixed slot weights: 10=10%, 20=5%, 30=3.333%. UNCAPPED uses 1 / ex-post peak candidate concurrency within each fold/scenario as a diagnostic benchmark only.",
      fractionalShares: true,
      duplicateEntryAllowed: false,
      priority: [
        "adjustedScore10 desc",
        "scoreRise5d desc",
        "signalTradingValue desc",
        "symbol asc",
      ],
    },
    baselineReplay,
    foldSignalCounts,
    scenarios: EXIT_SCENARIOS,
    capacities: CAPACITY_SPECS,
    candidateCounts,
    aggregateRows: aggregate,
    foldRows,
    notes: [
      "V8-11b supersedes the first V8-11 run for exit-rule comparison because V8-11 used a shared builder that mechanically removed signal-day scores already at or above the upside exit threshold.",
      "Entry signals are fixed for each market and entry threshold across all exits; V8-11b crossing engine is unchanged, including overshoot handling (must recross after entry).",
      "Every scenario uses identical fold-year-plus-all-60-bar-candidate runoff evaluation dates; idle cash earns zero. Fold outcomes are not a continuous 3-year investment.",
      "Exploratory re-analysis of already reviewed 2018/2022/2025 folds; ranking is NOT a new untouched OOS test or proof of a universal optimum.",
      "Current 613-stock universe has survivorship/selection bias; price gaps and historical execution limits remain as in the frozen engine.",
      "30 bps is round-trip cost, split 15 bps on entry and 15 bps on exit.",
      "UNCAPPED is diagnostic only because its slot size uses realized peak concurrency; operational selection should be based on P10/P20/P30.",
    ],
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `v8-entry-exit-grid-fixed-signal-3fos-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-entry-exit-grid-fixed-signal-3fos/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(
      client,
      `${options.userId}/results/v8-entry-exit-grid-fixed-signal-3fos/latest.json`,
      {
        frozenEngineCommit: FROZEN_ENGINE_COMMIT,
        version: STUDY_VERSION,
        createdAt,
        runId,
        resultPath: remotePath,
        foldSignalCounts,
        aggregateRows: aggregate,
      },
    );
  }
  process.stdout.write(
    `${JSON.stringify({ outputPath, remotePath, scenarios: EXIT_SCENARIOS.length, foldRows: foldRows.length }, null, 2)}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
