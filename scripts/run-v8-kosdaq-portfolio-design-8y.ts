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
import { getKosdaqOperationalExitSignal } from "../src/lib/engine/vfConfig";
import { downloadJson, trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8 KOSDAQ Portfolio Design 8Y" as const;
const FOLD_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] as const;
const ORIGINAL_3FOS = [2018, 2022, 2025] as const;
const PRIOR_HOLDOUT_5 = [2019, 2020, 2021, 2023, 2024] as const;
const LIMIT = 613;
const INITIAL_CAPITAL = 10_000_000;
const ROUND_TRIP_COST_BPS = 30;
const ENTRY_THRESHOLD = 8;
const UPSIDE_EXIT_THRESHOLD = 9;
const DOWNSIDE_EXIT_THRESHOLD = 3;
const MAX_HOLDING_DAYS = 60;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const SECTOR_SLOT = 0.5;

type FoldYear = (typeof FOLD_YEARS)[number];
type CapacityId = "P5" | "P10" | "P20" | "P30";
type WeightMode = "EQUAL" | "SCORE_PRIORITY";
type PanelId = "ORIGINAL_3FOS" | "PRIOR_HOLDOUT_5" | "ALL_8Y";

interface CapacitySpec {
  id: CapacityId;
  maxPositions: number;
}

const CAPACITIES: CapacitySpec[] = [
  { id: "P5", maxPositions: 5 },
  { id: "P10", maxPositions: 10 },
  { id: "P20", maxPositions: 20 },
  { id: "P30", maxPositions: 30 },
];

const WEIGHT_MODES: WeightMode[] = ["EQUAL", "SCORE_PRIORITY"];
const SECTOR_CAPS: Array<number | null> = [null, 0.2, 0.3, 0.4];

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
  maxSectorWeightPct: number;
  activeSectorCount: number;
}

interface PortfolioPolicy {
  id: string;
  capacity: CapacitySpec;
  weightMode: WeightMode;
  sectorCap: number | null;
  sectorCapLabel: string;
}

interface SimulationResult {
  points: EquityPoint[];
  trades: ClosedTrade[];
  candidateSignals: number;
  skippedForCapacity: number;
  skippedAlreadyHeld: number;
  skippedForCash: number;
  skippedForSectorCap: number;
  skippedForWholeShare: number;
  totalFees: number;
}

interface FoldRow {
  fold: FoldYear;
  policyId: string;
  capacity: CapacityId;
  maxPositions: number;
  weightMode: WeightMode;
  sectorCapPct: number | null;
  trades: number;
  candidateSignals: number;
  skippedForCapacity: number;
  skippedAlreadyHeld: number;
  skippedForCash: number;
  skippedForSectorCap: number;
  skippedForWholeShare: number;
  totalReturn: number | null;
  zeroCostTotalReturn: number | null;
  costDragPctPoint: number | null;
  benchmarkReturn: number | null;
  portfolioExcessReturn: number | null;
  cagr: number | null;
  mdd: number | null;
  sharpe: number | null;
  annualizedVolatility: number | null;
  medianTradeReturn: number | null;
  avgTradeReturn: number | null;
  winRate: number | null;
  profitFactor: number | null;
  averageHoldingDays: number | null;
  avgCapitalOccupancy: number | null;
  avgActivePositions: number | null;
  peakActivePositions: number;
  avgMaxSectorWeightPct: number | null;
  peakMaxSectorWeightPct: number | null;
  avgActiveSectorCount: number | null;
  totalFees: number;
  finalCapital: number | null;
}

interface AggregateRow {
  panel: PanelId;
  policyId: string;
  capacity: CapacityId;
  maxPositions: number;
  weightMode: WeightMode;
  sectorCapPct: number | null;
  folds: number;
  foldsPositiveReturn: number;
  foldsPositiveExcess: number;
  avgTotalReturn: number | null;
  medianFoldTotalReturn: number | null;
  worstFoldReturn: number | null;
  avgPortfolioExcessReturn: number | null;
  medianFoldExcessReturn: number | null;
  worstFoldExcessReturn: number | null;
  avgCagr: number | null;
  avgMdd: number | null;
  worstFoldMdd: number | null;
  meanSharpe: number | null;
  meanAnnualizedVolatility: number | null;
  avgMedianTradeReturn: number | null;
  avgTradeReturn: number | null;
  avgProfitFactor: number | null;
  avgCapitalOccupancy: number | null;
  avgActivePositions: number | null;
  maxPeakActivePositions: number;
  avgTrades: number | null;
  totalCapacitySkips: number;
  totalSectorCapSkips: number;
  totalWholeShareSkips: number;
  avgCostDragPctPoint: number | null;
  avgMaxSectorWeightPct: number | null;
  worstPeakSectorWeightPct: number | null;
  avgActiveSectorCount: number | null;
  avgFinalCapital: number | null;
}

interface LegacyAggregateRow {
  scenario?: string;
  capacity?: string;
  avgTotalReturn?: number | null;
  avgPortfolioExcessReturn?: number | null;
  avgMdd?: number | null;
  worstFoldMdd?: number | null;
  avgProfitFactor?: number | null;
  avgCapitalOccupancy?: number | null;
  foldsPositiveExcess?: number | null;
}

interface LegacyLatest {
  version?: string;
  aggregateRows?: LegacyAggregateRow[];
  resultPath?: string;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node scripts/run-v8-kosdaq-portfolio-design-8y.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
    `Portfolio design source cache verified: ${manifest.fileCount} files / ${(manifest.totalBytes / 1_000_000).toFixed(1)} MB\n`,
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

function buildFixedEntrySignals(series: PortfolioSeries[]) {
  const out: EntrySignal[] = [];
  for (const item of series) {
    if (item.market !== "KOSDAQ") continue;
    for (let i = 120; i + 1 < item.bars.length; i++) {
      if (!crossedUp(adjustedScoreAt(item, i - 1), adjustedScoreAt(item, i), ENTRY_THRESHOLD))
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

function buildCandidate(signal: EntrySignal): PortfolioCandidateTrade | null {
  const series = signal.series;
  const signalIndex = signal.signalIndex;
  const entryIndex = signalIndex + 1;
  const plannedExit = signalIndex + MAX_HOLDING_DAYS;
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
      const exitSignal = getKosdaqOperationalExitSignal(previous, current, false);
      if (exitSignal === "DOWN30") {
        exitIndex = j;
        exitPrice = bar.open;
        exitReason = "DOWNSIDE_SCORE";
        exitTiming = "OPEN";
        break;
      }
      if (exitSignal === "UP90") {
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
    scenarioId: "KOSDAQ-E8-U9-D3-H60",
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

function positionKey(candidate: PortfolioCandidateTrade) {
  return `${candidate.market}:${candidate.symbol}`;
}

function candidateKey(candidate: PortfolioCandidateTrade) {
  return `${candidate.market}:${candidate.symbol}:${candidate.entryDate}`;
}

function lookupSeries(series: PortfolioSeries[]) {
  return new Map(series.map((item) => [`${item.market}:${item.symbol}`, item]));
}

function markPrice(
  position: Position,
  date: string,
  timing: "OPEN" | "CLOSE",
  seriesMap: Map<string, PortfolioSeries>,
) {
  const series = seriesMap.get(`${position.candidate.market}:${position.candidate.symbol}`);
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

function entryWeightFactors(candidates: PortfolioCandidateTrade[], mode: WeightMode) {
  const factors = new Map<string, number>();
  if (!candidates.length) return factors;
  const sorted = [...candidates].sort(candidatePriority);
  if (mode === "EQUAL" || sorted.length === 1) {
    for (const candidate of sorted) factors.set(candidateKey(candidate), 1);
    return factors;
  }

  const raw = sorted.map((candidate, index) => {
    const rankTilt = 1.2 - 0.4 * (index / Math.max(1, sorted.length - 1));
    const scoreProgress = clamp((candidate.adjustedScore10 - ENTRY_THRESHOLD) / 2, 0, 1);
    const scoreTilt = 0.9 + 0.2 * scoreProgress;
    return rankTilt * scoreTilt;
  });
  const rawMean = average(raw) ?? 1;
  const firstPass = raw.map((value) => clamp(value / rawMean, 0.7, 1.3));
  const normalizedMean = average(firstPass) ?? 1;
  sorted.forEach((candidate, index) => {
    factors.set(candidateKey(candidate), firstPass[index]! / normalizedMean);
  });
  return factors;
}

function sectorMarkedValue(positions: Map<string, Position>, sectorCode: string) {
  let value = 0;
  for (const position of positions.values()) {
    if (position.candidate.sectorCode === sectorCode) value += position.shares * position.lastMark;
  }
  return value;
}

function concentrationSnapshot(positions: Map<string, Position>, equity: number) {
  if (!(equity > 0) || !positions.size)
    return { maxSectorWeightPct: 0, activeSectorCount: 0 };
  const sectorValues = new Map<string, number>();
  for (const position of positions.values()) {
    sectorValues.set(
      position.candidate.sectorCode,
      (sectorValues.get(position.candidate.sectorCode) ?? 0) + position.shares * position.lastMark,
    );
  }
  const maxSectorValue = Math.max(...sectorValues.values());
  return {
    maxSectorWeightPct: (maxSectorValue / equity) * 100,
    activeSectorCount: sectorValues.size,
  };
}

function simulatePortfolio(
  candidates: PortfolioCandidateTrade[],
  series: PortfolioSeries[],
  dates: string[],
  policy: PortfolioPolicy,
  roundTripCostBps: number,
): SimulationResult {
  const seriesMap = lookupSeries(series);
  const halfCost = Math.max(0, roundTripCostBps) / 20_000;
  const targetSlotWeight = 1 / policy.capacity.maxPositions;
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
  let peakEquity = INITIAL_CAPITAL;
  let totalFees = 0;
  let skippedForCapacity = 0;
  let skippedAlreadyHeld = 0;
  let skippedForCash = 0;
  let skippedForSectorCap = 0;
  let skippedForWholeShare = 0;

  const closePosition = (key: string, position: Position, price: number) => {
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
    positions.delete(key);
  };

  for (const date of dates) {
    for (const position of positions.values())
      position.lastMark = markPrice(position, date, "OPEN", seriesMap);
    for (const [key, position] of [...positions]) {
      if (position.candidate.exitDate === date && position.candidate.exitTiming === "OPEN")
        closePosition(key, position, position.candidate.exitPrice);
    }

    const openMarked = [...positions.values()].reduce(
      (sum, position) => sum + position.shares * position.lastMark,
      0,
    );
    const openEquity = cash + openMarked;
    const todayCandidates = byEntry.get(date) ?? [];
    const factors = entryWeightFactors(todayCandidates, policy.weightMode);

    for (const candidate of todayCandidates) {
      const key = positionKey(candidate);
      if (positions.has(key)) {
        skippedAlreadyHeld += 1;
        continue;
      }
      if (positions.size >= policy.capacity.maxPositions) {
        skippedForCapacity += 1;
        continue;
      }

      const factor = factors.get(candidateKey(candidate)) ?? 1;
      let targetNotional = openEquity * targetSlotWeight * factor;
      if (policy.sectorCap !== null) {
        const currentSectorValue = sectorMarkedValue(positions, candidate.sectorCode);
        const room = openEquity * policy.sectorCap - currentSectorValue;
        if (!(room > 1)) {
          skippedForSectorCap += 1;
          continue;
        }
        targetNotional = Math.min(targetNotional, room);
      }

      const maxAffordable = cash / (1 + halfCost);
      const budget = Math.min(targetNotional, maxAffordable);
      if (!(budget > 1)) {
        skippedForCash += 1;
        continue;
      }
      const shares = Math.floor(budget / candidate.entryPrice);
      if (shares < 1) {
        skippedForWholeShare += 1;
        continue;
      }
      const entryNotional = shares * candidate.entryPrice;
      const entryFee = entryNotional * halfCost;
      if (entryNotional + entryFee > cash + 1e-6) {
        skippedForCash += 1;
        continue;
      }
      cash -= entryNotional + entryFee;
      totalFees += entryFee;
      positions.set(key, {
        candidate,
        shares,
        entryNotional,
        entryFee,
        lastMark: candidate.entryPrice,
      });
    }

    for (const position of positions.values())
      position.lastMark = markPrice(position, date, "CLOSE", seriesMap);
    for (const [key, position] of [...positions]) {
      if (position.candidate.exitDate === date && position.candidate.exitTiming === "CLOSE")
        closePosition(key, position, position.candidate.exitPrice);
    }
    const marked = [...positions.values()].reduce(
      (sum, position) => sum + position.shares * position.lastMark,
      0,
    );
    const equity = cash + marked;
    peakEquity = Math.max(peakEquity, equity);
    const drawdown = peakEquity > 0 ? (equity / peakEquity - 1) * 100 : 0;
    const concentration = concentrationSnapshot(positions, equity);
    points.push({
      date,
      equity,
      cashWeight: equity > 0 ? (cash / equity) * 100 : 100,
      activePositions: positions.size,
      drawdown,
      ...concentration,
    });
  }

  return {
    points,
    trades,
    candidateSignals: candidates.length,
    skippedForCapacity,
    skippedAlreadyHeld,
    skippedForCash,
    skippedForSectorCap,
    skippedForWholeShare,
    totalFees,
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

function dailyReturnStats(points: EquityPoint[]) {
  if (points.length < 3) return { sharpe: null, annualizedVolatility: null };
  const returns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!.equity;
    const current = points[i]!.equity;
    if (previous > 0 && current > 0) returns.push(current / previous - 1);
  }
  if (returns.length < 2) return { sharpe: null, annualizedVolatility: null };
  const mean = average(returns) ?? 0;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(Math.max(0, variance));
  return {
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : null,
    annualizedVolatility: sd * Math.sqrt(252) * 100,
  };
}

function profitFactor(trades: ClosedTrade[]) {
  const profit = trades
    .filter((trade) => trade.netReturn > 0)
    .reduce((sum, trade) => sum + trade.netReturn, 0);
  const loss = Math.abs(
    trades.filter((trade) => trade.netReturn < 0).reduce((sum, trade) => sum + trade.netReturn, 0),
  );
  return loss > 0 ? profit / loss : profit > 0 ? Number.POSITIVE_INFINITY : null;
}

function makeFoldRow(
  fold: FoldYear,
  policy: PortfolioPolicy,
  simulation: SimulationResult,
  zeroCost: SimulationResult,
  dataset: MarketDataset,
): FoldRow {
  const points = simulation.points;
  const last = points.at(-1);
  const zeroLast = zeroCost.points.at(-1);
  const totalReturn = last ? (last.equity / INITIAL_CAPITAL - 1) * 100 : null;
  const zeroCostTotalReturn = zeroLast ? (zeroLast.equity / INITIAL_CAPITAL - 1) * 100 : null;
  const benchmark = points.length
    ? benchmarkReturn(dataset, points[0]!.date, points.at(-1)!.date)
    : null;
  const cagr =
    last && points.length > 1
      ? ((last.equity / INITIAL_CAPITAL) ** (252 / (points.length - 1)) - 1) * 100
      : null;
  const tradeReturns = simulation.trades.map((trade) => trade.netReturn).filter(Number.isFinite);
  const stats = dailyReturnStats(points);
  return {
    fold,
    policyId: policy.id,
    capacity: policy.capacity.id,
    maxPositions: policy.capacity.maxPositions,
    weightMode: policy.weightMode,
    sectorCapPct: policy.sectorCap === null ? null : policy.sectorCap * 100,
    trades: simulation.trades.length,
    candidateSignals: simulation.candidateSignals,
    skippedForCapacity: simulation.skippedForCapacity,
    skippedAlreadyHeld: simulation.skippedAlreadyHeld,
    skippedForCash: simulation.skippedForCash,
    skippedForSectorCap: simulation.skippedForSectorCap,
    skippedForWholeShare: simulation.skippedForWholeShare,
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
    mdd: round(points.length ? Math.min(...points.map((point) => point.drawdown)) : null),
    sharpe: round(stats.sharpe),
    annualizedVolatility: round(stats.annualizedVolatility),
    medianTradeReturn: round(median(tradeReturns)),
    avgTradeReturn: round(average(tradeReturns)),
    winRate: round(
      tradeReturns.length
        ? (tradeReturns.filter((value) => value > 0).length / tradeReturns.length) * 100
        : null,
    ),
    profitFactor: round(profitFactor(simulation.trades)),
    averageHoldingDays: round(average(simulation.trades.map((trade) => trade.holdingDays))),
    avgCapitalOccupancy: round(
      average(points.map((point) => Math.max(0, 100 - point.cashWeight))),
    ),
    avgActivePositions: round(average(points.map((point) => point.activePositions))),
    peakActivePositions: points.length ? Math.max(...points.map((point) => point.activePositions)) : 0,
    avgMaxSectorWeightPct: round(average(points.map((point) => point.maxSectorWeightPct))),
    peakMaxSectorWeightPct: round(
      points.length ? Math.max(...points.map((point) => point.maxSectorWeightPct)) : null,
    ),
    avgActiveSectorCount: round(average(points.map((point) => point.activeSectorCount))),
    totalFees: round(simulation.totalFees, 0) ?? 0,
    finalCapital: round(last?.equity ?? null, 0),
  };
}

function policyId(capacity: CapacitySpec, weightMode: WeightMode, sectorCap: number | null) {
  const sector = sectorCap === null ? "NOSEC" : `SEC${Math.round(sectorCap * 100)}`;
  return `${capacity.id}-${weightMode}-${sector}`;
}

function buildPolicies(): PortfolioPolicy[] {
  const policies: PortfolioPolicy[] = [];
  for (const capacity of CAPACITIES) {
    for (const weightMode of WEIGHT_MODES) {
      for (const sectorCap of SECTOR_CAPS) {
        policies.push({
          id: policyId(capacity, weightMode, sectorCap),
          capacity,
          weightMode,
          sectorCap,
          sectorCapLabel: sectorCap === null ? "none" : `${Math.round(sectorCap * 100)}% entry cap`,
        });
      }
    }
  }
  return policies;
}

function aggregateRows(foldRows: FoldRow[], panel: PanelId, folds: readonly number[]) {
  const selected = foldRows.filter((row) => folds.includes(row.fold));
  const grouped = new Map<string, FoldRow[]>();
  for (const row of selected) {
    const list = grouped.get(row.policyId) ?? [];
    list.push(row);
    grouped.set(row.policyId, list);
  }
  const out: AggregateRow[] = [];
  for (const rows of grouped.values()) {
    const first = rows[0]!;
    const values = (selector: (row: FoldRow) => number | null) =>
      rows.map(selector).filter(finite);
    const returns = values((row) => row.totalReturn);
    const excess = values((row) => row.portfolioExcessReturn);
    const mdds = values((row) => row.mdd);
    const peakSector = values((row) => row.peakMaxSectorWeightPct);
    out.push({
      panel,
      policyId: first.policyId,
      capacity: first.capacity,
      maxPositions: first.maxPositions,
      weightMode: first.weightMode,
      sectorCapPct: first.sectorCapPct,
      folds: rows.length,
      foldsPositiveReturn: returns.filter((value) => value > 0).length,
      foldsPositiveExcess: excess.filter((value) => value > 0).length,
      avgTotalReturn: round(average(returns)),
      medianFoldTotalReturn: round(median(returns)),
      worstFoldReturn: returns.length ? round(Math.min(...returns)) : null,
      avgPortfolioExcessReturn: round(average(excess)),
      medianFoldExcessReturn: round(median(excess)),
      worstFoldExcessReturn: excess.length ? round(Math.min(...excess)) : null,
      avgCagr: round(average(values((row) => row.cagr))),
      avgMdd: round(average(mdds)),
      worstFoldMdd: mdds.length ? round(Math.min(...mdds)) : null,
      meanSharpe: round(average(values((row) => row.sharpe))),
      meanAnnualizedVolatility: round(
        average(values((row) => row.annualizedVolatility)),
      ),
      avgMedianTradeReturn: round(average(values((row) => row.medianTradeReturn))),
      avgTradeReturn: round(average(values((row) => row.avgTradeReturn))),
      avgProfitFactor: round(average(values((row) => row.profitFactor))),
      avgCapitalOccupancy: round(average(values((row) => row.avgCapitalOccupancy))),
      avgActivePositions: round(average(values((row) => row.avgActivePositions))),
      maxPeakActivePositions: Math.max(...rows.map((row) => row.peakActivePositions)),
      avgTrades: round(average(rows.map((row) => row.trades))),
      totalCapacitySkips: rows.reduce((sum, row) => sum + row.skippedForCapacity, 0),
      totalSectorCapSkips: rows.reduce((sum, row) => sum + row.skippedForSectorCap, 0),
      totalWholeShareSkips: rows.reduce((sum, row) => sum + row.skippedForWholeShare, 0),
      avgCostDragPctPoint: round(average(values((row) => row.costDragPctPoint))),
      avgMaxSectorWeightPct: round(average(values((row) => row.avgMaxSectorWeightPct))),
      worstPeakSectorWeightPct: peakSector.length ? round(Math.max(...peakSector)) : null,
      avgActiveSectorCount: round(average(values((row) => row.avgActiveSectorCount))),
      avgFinalCapital: round(average(values((row) => row.finalCapital)), 0),
    });
  }
  return out.sort((a, b) => a.policyId.localeCompare(b.policyId));
}

function baselineRows(aggregate: AggregateRow[], panel: PanelId) {
  return aggregate.filter(
    (row) => row.panel === panel && row.weightMode === "EQUAL" && row.sectorCapPct === null,
  );
}

function topRows(aggregate: AggregateRow[], panel: PanelId, field: "avgPortfolioExcessReturn" | "meanSharpe") {
  return aggregate
    .filter((row) => row.panel === panel)
    .filter((row) => finite(row[field]))
    .sort((a, b) => (b[field] ?? -Infinity) - (a[field] ?? -Infinity))
    .slice(0, 10);
}

async function loadLegacyReference(userId: string | null) {
  if (!userId) return null;
  const client = trustedSupabaseClient();
  const objectPath = `${userId}/results/v8-11b-kosdaq80-exit-portfolio-fixed-entry-3fos/latest.json`;
  try {
    const latest = await downloadJson<LegacyLatest>(client, objectPath);
    const rows = (latest.aggregateRows ?? []).filter(
      (row) => row.scenario === "BOTH95_DOWN25_H60" && ["P10", "P20", "P30"].includes(row.capacity ?? ""),
    );
    return {
      sourcePath: objectPath,
      version: latest.version ?? null,
      resultPath: latest.resultPath ?? null,
      p5Available: false,
      rows,
    };
  } catch (error) {
    return {
      sourcePath: objectPath,
      error: error instanceof Error ? error.message : String(error),
      p5Available: false,
      rows: [] as LegacyAggregateRow[],
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const parsed = parseManualMarketData(texts);
  const dataset = parsed.dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const fixedSignals = buildFixedEntrySignals(context.series);
  const policies = buildPolicies();
  const foldRows: FoldRow[] = [];
  const foldSignalCounts: Array<{ fold: FoldYear; signals: number; candidates: number }> = [];

  for (const fold of FOLD_YEARS) {
    const foldSignals = fixedSignals.filter(
      (signal) => Number(signal.signalDate.slice(0, 4)) === fold,
    );
    const candidates = foldSignals
      .map((signal) => buildCandidate(signal))
      .filter((candidate): candidate is PortfolioCandidateTrade => candidate !== null);
    const dates = datesForCandidates(context.allDates, candidates);
    foldSignalCounts.push({ fold, signals: foldSignals.length, candidates: candidates.length });
    process.stderr.write(
      `Fold ${fold}: ${foldSignals.length} signals / ${candidates.length} complete candidates / ${dates.length} eval dates\n`,
    );

    for (const policy of policies) {
      const simulation = simulatePortfolio(
        candidates,
        context.series,
        dates,
        policy,
        ROUND_TRIP_COST_BPS,
      );
      const zeroCost = simulatePortfolio(candidates, context.series, dates, policy, 0);
      foldRows.push(makeFoldRow(fold, policy, simulation, zeroCost, dataset));
    }
  }

  const aggregateRowsAll = [
    ...aggregateRows(foldRows, "ORIGINAL_3FOS", ORIGINAL_3FOS),
    ...aggregateRows(foldRows, "PRIOR_HOLDOUT_5", PRIOR_HOLDOUT_5),
    ...aggregateRows(foldRows, "ALL_8Y", FOLD_YEARS),
  ];
  const legacyReference = await loadLegacyReference(options.userId);
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
      market: "KOSDAQ",
      folds: [...FOLD_YEARS],
      panels: {
        ORIGINAL_3FOS: [...ORIGINAL_3FOS],
        PRIOR_HOLDOUT_5: [...PRIOR_HOLDOUT_5],
        ALL_8Y: [...FOLD_YEARS],
      },
      strategy: {
        entry: "8.0 onset; NEXT_OPEN",
        upsideExit: `${UPSIDE_EXIT_THRESHOLD.toFixed(1)} fresh upward recross; NEXT_OPEN`,
        downsideExit: `${DOWNSIDE_EXIT_THRESHOLD.toFixed(1)} fresh downward cross; NEXT_OPEN`,
        maxHoldingDays: MAX_HOLDING_DAYS,
        timeExit: "SAME_DAY_CLOSE",
      },
      initialCapitalKrw: INITIAL_CAPITAL,
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      wholeShares: true,
      fractionalShares: false,
      rebalanceExistingPositions: false,
      capacities: CAPACITIES,
      weightModes: {
        EQUAL: "Each new position targets 1/P of entry-time portfolio equity.",
        SCORE_PRIORITY:
          "Same-day candidates are ordered by adjustedScore10 desc, scoreRise5d desc, tradingValue desc. Position size receives a mild contemporaneous 0.7~1.3x normalized tilt combining 8~10 score level and that priority rank; no future data is used.",
      },
      sectorCaps: SECTOR_CAPS.map((cap) => (cap === null ? null : cap * 100)),
      sectorCapMechanics:
        "Entry-time sector market-value cap only. Existing positions are not forcibly rebalanced or sold when price drift later pushes a sector above the cap.",
      duplicateEntryAllowed: false,
      candidateSelectionPriority: [
        "adjustedScore10 desc",
        "scoreRise5d desc",
        "signalTradingValue desc",
        "symbol asc",
      ],
      interpretation:
        "The five 2019/2020/2021/2023/2024 folds were previously used as candidate-level holdout and are now consumed. ALL_8Y is a robustness/tuning panel, not a new untouched OOS test.",
    },
    legacyReference,
    foldSignalCounts,
    policies,
    aggregateRows: aggregateRowsAll,
    foldRows,
    notes: [
      "Legacy V8-11b reference used 100m KRW, fractional shares, and 9.5/2.5/60D exits; it is retained only as historical context.",
      "This study resets every fold to 10m KRW and uses whole-share execution so capacity effects are directly interpretable for the user's intended account size.",
      "All portfolio variants share the same fixed 8.0 Onset candidates and current 9.0/3.0/60D exit engine. Only capacity, sizing, and sector concentration policy differ.",
      "Sector caps are tested at 20/30/40% plus no cap to avoid choosing one arbitrary cap without sensitivity evidence.",
    ],
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `v8-kosdaq-portfolio-design-8y-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kosdaq-portfolio-design-8y/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(client, `${options.userId}/results/v8-kosdaq-portfolio-design-8y/latest.json`, {
      version: STUDY_VERSION,
      createdAt,
      runId,
      resultPath: remotePath,
      design: result.design,
      legacyReference,
      foldSignalCounts,
      baselineAll8: baselineRows(aggregateRowsAll, "ALL_8Y"),
      topAll8ByExcess: topRows(aggregateRowsAll, "ALL_8Y", "avgPortfolioExcessReturn"),
      topAll8BySharpe: topRows(aggregateRowsAll, "ALL_8Y", "meanSharpe"),
      aggregateRows: aggregateRowsAll,
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        outputPath,
        remotePath,
        foldSignalCounts,
        legacyReference,
        baselineOriginal3: baselineRows(aggregateRowsAll, "ORIGINAL_3FOS"),
        baselinePriorHoldout5: baselineRows(aggregateRowsAll, "PRIOR_HOLDOUT_5"),
        baselineAll8: baselineRows(aggregateRowsAll, "ALL_8Y"),
        topAll8ByExcess: topRows(aggregateRowsAll, "ALL_8Y", "avgPortfolioExcessReturn"),
        topAll8BySharpe: topRows(aggregateRowsAll, "ALL_8Y", "meanSharpe"),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
