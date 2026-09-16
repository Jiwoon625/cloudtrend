import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildFullUniverseSectorDataset } from "../src/lib/engine/sectorRotationFullUniverse";
import { buildPortfolioSignalContext, type PortfolioSeries } from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";
import { buildHistoricalRotationScoreMap } from "./v8-priority-rotation-history";

const STUDY_VERSION = "CloudTrend V8-13 Priority Index Weight Portfolio 3-FOS" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const INDEX_WEIGHTS = [0, 0.5, 1, 2] as const;
const POSITION_LIMITS = [10, 20, 30] as const;
const LIMIT = 613;
const INITIAL_CAPITAL = 100_000_000;
const ENTRY_THRESHOLD = 8;
const UPSIDE_EXIT = 9.5;
const DOWNSIDE_EXIT = 2.5;
const MAX_HOLDING_DAYS = 60;
const ROUND_TRIP_COST_BPS = 30;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const SECTOR_SLOT = 0.5;
const MIN_MARKET_CAP = 300_000_000_000;
const EXCESS_RETURN_THRESHOLD_PP = 2;
const MEMBERSHIP_PATH = "research-data/kosdaq150_membership_intervals_3fos.csv";

type FoldYear = (typeof FOLD_YEARS)[number];
type IndexWeight = (typeof INDEX_WEIGHTS)[number];
type PositionLimit = (typeof POSITION_LIMITS)[number];

interface CacheManifestFile { id: string; fileName: string; bytes: number; savedAt: string; fileHash: string; cacheFile: string; }
interface CacheManifest { schemaVersion: 1; sourceType: "backtest"; cacheKey: string; fileCount: number; totalBytes: number; files: CacheManifestFile[]; }
interface Options { sourceManifest: string; sourceCacheDir: string; userId: string | null; upload: boolean; }
interface MembershipInterval { symbol: string; start: string; end: string; }
interface Candidate {
  fold: FoldYear;
  symbol: string;
  name: string;
  sectorCode: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  exitTiming: "OPEN" | "CLOSE";
  exitReason: "UPSIDE_SCORE" | "DOWNSIDE_SCORE" | "TIME";
  signalIndex: number;
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  holdingDays: number;
  signalScore: number;
  signalTradingValue: number;
  marketCap: number | null;
  sizePoint: number;
  relativePoint: number;
  relativeReturnPp: number | null;
  sectorRotationScore: number | null;
  sectorRotationPoint: number;
  supplyPenalty: 0 | -0.5 | -1;
  indexMember: boolean;
  basePriorityNoIndex: number;
  grossReturn: number;
  mae: number;
  mfe: number;
}
interface Position { candidate: Candidate; shares: number; lastMark: number; entryNotional: number; entryFee: number; priorityScore: number; }
interface AcceptedTrade extends Candidate { priorityScore: number; netReturn: number; }
interface EquityPoint { date: string; equity: number; dailyReturn: number; cashWeight: number; activePositions: number; drawdown: number; }
interface Simulation {
  fold: FoldYear;
  indexWeight: IndexWeight;
  maxPositions: PositionLimit;
  points: EquityPoint[];
  trades: AcceptedTrade[];
  candidateSignals: number;
  skippedCapacity: number;
  skippedAlreadyHeld: number;
  skippedCash: number;
}

function usage(message?: string): never {
  throw new Error([...(message ? [message, ""] : []), "Usage:", "  npx vite-node scripts/run-v8-priority-index-weight-portfolio-3fos.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]"].join("\n"));
}
function parseArgs(argv: string[]): Options {
  const options: Options = { sourceManifest: "", sourceCacheDir: "", userId: process.env["SUPABASE_USER_ID"] ?? null, upload: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source-manifest") options.sourceManifest = argv[++i] ?? usage("--source-manifest 값이 없습니다.");
    else if (arg === "--source-cache-dir") options.sourceCacheDir = argv[++i] ?? usage("--source-cache-dir 값이 없습니다.");
    else if (arg === "--supabase-user-id") options.userId = argv[++i] ?? usage("--supabase-user-id 값이 없습니다.");
    else if (arg === "--upload") options.upload = true;
    else usage(`지원하지 않는 인자입니다: ${arg}`);
  }
  if (!options.sourceManifest || !options.sourceCacheDir) usage("source manifest와 cache dir가 필요합니다.");
  if (options.upload && !/^[0-9a-f-]{36}$/i.test(options.userId ?? "")) usage("업로드에는 유효한 Supabase user id가 필요합니다.");
  return options;
}

const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function median(xs: number[]) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2; }
function stdev(xs: number[]) { if (xs.length < 2) return null; const m = mean(xs)!; return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); }
function round(v: number | null, digits = 4) { if (!finite(v)) return null; const f = 10 ** digits; return Math.round(v * f) / f; }
function compound(xs: number[]) { return xs.length ? (xs.reduce((eq, r) => eq * (1 + r), 1) - 1) * 100 : null; }

function decodeSourceBytes(bytes: Uint8Array) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("euc-kr").decode(bytes); }
}
async function loadCachedTexts(manifestPath: string, cacheDir: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CacheManifest;
  if (manifest.schemaVersion !== 1 || manifest.sourceType !== "backtest" || !Array.isArray(manifest.files) || manifest.files.length !== manifest.fileCount)
    throw new Error("지원하지 않거나 손상된 source cache manifest입니다.");
  const texts: string[] = [];
  for (const file of manifest.files) {
    const bytes = new Uint8Array(await readFile(path.join(cacheDir, file.cacheFile)));
    const fileHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== file.bytes || fileHash !== file.fileHash) throw new Error(`source cache 무결성 검증 실패: ${file.fileName}`);
    texts.push(decodeSourceBytes(bytes));
  }
  return { texts, manifest };
}

function adjustedScoreAt(series: PortfolioSeries, index: number) {
  const base = series.baseScores[index];
  if (!finite(base)) return null;
  const sectorPl = series.sectorPriceLeadership[index] ?? null;
  const sectorContribution = finite(sectorPl) && sectorPl < SECTOR_OVERHEAT_THRESHOLD ? SECTOR_SLOT : 0;
  return Math.min(10, Math.max(0, Math.round((base + sectorContribution) * 100) / 100));
}
function crossedUp(prev: number | null, cur: number | null, threshold: number) { return finite(prev) && finite(cur) && prev < threshold && cur >= threshold; }
function crossedDown(prev: number | null, cur: number | null, threshold: number) { return finite(prev) && finite(cur) && prev >= threshold && cur < threshold; }
function diff20(values: Array<number | null | undefined>, i: number) { const a = values[i], b = values[i - 20]; return finite(a) && finite(b) ? a - b : null; }

async function loadMembershipIntervals() {
  const text = await readFile(MEMBERSHIP_PATH, "utf8");
  const bySymbol = new Map<string, MembershipInterval[]>();
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const [symbol, start, end] = line.split(",");
    if (!symbol || !start || !end) continue;
    const list = bySymbol.get(symbol) ?? [];
    list.push({ symbol, start, end });
    bySymbol.set(symbol, list);
  }
  return bySymbol;
}
function isIndexMember(bySymbol: Map<string, MembershipInterval[]>, symbol: string, date: string) {
  return (bySymbol.get(symbol) ?? []).some((x) => x.start <= date && date <= x.end);
}

function benchmarkReturnMap(series: Array<{ tradeDate: string; close: number }>) {
  const out = new Map<string, number>();
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!.close, cur = series[i]!.close;
    if (finite(prev) && finite(cur) && prev > 0) out.set(series[i]!.tradeDate, cur / prev - 1);
  }
  return out;
}

function buildCandidate(
  series: PortfolioSeries,
  signalIndex: number,
  fold: FoldYear,
  sectorCode: string,
  rotationMap: Map<string, number>,
  membership: Map<string, MembershipInterval[]>,
  kosdaqReturns: Map<string, number>,
): Candidate | null {
  const entryIndex = signalIndex + 1;
  const entry = series.bars[entryIndex];
  if (!entry || !finite(entry.open) || entry.open <= 0) return null;
  let exitIndex = -1, exitPrice = 0;
  let exitReason: Candidate["exitReason"] = "TIME";
  let exitTiming: Candidate["exitTiming"] = "CLOSE";
  const last = Math.min(signalIndex + MAX_HOLDING_DAYS, series.bars.length - 1);
  for (let j = entryIndex; j <= last; j++) {
    const bar = series.bars[j]!;
    if (![bar.open, bar.close, bar.low, bar.high].every((v) => finite(v) && v > 0)) return null;
    if (j > entryIndex) {
      const si = j - 1;
      const prev = adjustedScoreAt(series, si - 1), cur = adjustedScoreAt(series, si);
      if (crossedDown(prev, cur, DOWNSIDE_EXIT)) { exitIndex = j; exitPrice = bar.open; exitReason = "DOWNSIDE_SCORE"; exitTiming = "OPEN"; break; }
      if (crossedUp(prev, cur, UPSIDE_EXIT)) { exitIndex = j; exitPrice = bar.open; exitReason = "UPSIDE_SCORE"; exitTiming = "OPEN"; break; }
    }
    if (j === last) { exitIndex = j; exitPrice = bar.close; exitReason = "TIME"; exitTiming = "CLOSE"; }
  }
  if (exitIndex < 0 || exitPrice <= 0) return null;
  const signalBar = series.bars[signalIndex]!;
  const signalScore = adjustedScoreAt(series, signalIndex);
  if (!finite(signalScore)) return null;
  const prevClose = series.bars[signalIndex - 1]?.close;
  const stockDayReturn = finite(prevClose) && prevClose > 0 ? signalBar.close / prevClose - 1 : null;
  const benchmarkDayReturn = kosdaqReturns.get(signalBar.tradeDate) ?? null;
  const relativeReturnPp = finite(stockDayReturn) && finite(benchmarkDayReturn) ? (stockDayReturn - benchmarkDayReturn) * 100 : null;
  const relativePoint = finite(relativeReturnPp) && relativeReturnPp >= EXCESS_RETURN_THRESHOLD_PP ? 1 : 0;
  const cap = signalBar.marketCap ?? null;
  const sizePoint = finite(cap) && cap >= MIN_MARKET_CAP ? 1 : 0;
  const sectorRotationScore = rotationMap.get(`${signalBar.tradeDate}|${sectorCode}`) ?? null;
  const sectorRotationPoint = finite(sectorRotationScore) ? Math.min(1, Math.max(0, sectorRotationScore / 100)) : 0;
  const shortValues = series.bars.map((b) => b.shortSellingVolumeRate ?? null);
  const lendValues = series.bars.map((b) => b.lendingBalanceQuantity ?? null);
  const shortChange = diff20(shortValues, signalIndex), lendChange = diff20(lendValues, signalIndex);
  const riskCount = (finite(shortChange) && shortChange > 0 ? 1 : 0) + (finite(lendChange) && lendChange > 0 ? 1 : 0);
  const supplyPenalty = (riskCount === 2 ? -1 : riskCount === 1 ? -0.5 : 0) as Candidate["supplyPenalty"];
  const indexMember = isIndexMember(membership, series.symbol, signalBar.tradeDate);
  const basePriorityNoIndex = sizePoint + relativePoint + sectorRotationPoint + supplyPenalty;
  let low = entry.open, high = entry.open;
  for (let i = entryIndex; i <= exitIndex; i++) {
    const bar = series.bars[i]!;
    if (i === exitIndex && exitTiming === "OPEN") { low = Math.min(low, exitPrice); high = Math.max(high, exitPrice); break; }
    low = Math.min(low, bar.low); high = Math.max(high, bar.high);
  }
  return {
    fold, symbol: series.symbol, name: series.name, sectorCode, signalDate: signalBar.tradeDate,
    entryDate: entry.tradeDate, exitDate: series.bars[exitIndex]!.tradeDate, exitTiming, exitReason,
    signalIndex, entryIndex, exitIndex, entryPrice: entry.open, exitPrice,
    holdingDays: exitIndex - entryIndex + 1, signalScore, signalTradingValue: signalBar.tradingValue,
    marketCap: cap, sizePoint, relativePoint, relativeReturnPp: round(relativeReturnPp),
    sectorRotationScore: round(sectorRotationScore), sectorRotationPoint: round(sectorRotationPoint)!,
    supplyPenalty, indexMember, basePriorityNoIndex: round(basePriorityNoIndex)!,
    grossReturn: round((exitPrice / entry.open - 1) * 100)!,
    mae: round((low / entry.open - 1) * 100)!, mfe: round((high / entry.open - 1) * 100)!,
  };
}

function buildCandidates(
  series: PortfolioSeries[],
  sectorCodeBySymbol: Map<string, string>,
  rotationMap: Map<string, number>,
  membership: Map<string, MembershipInterval[]>,
  kosdaqReturns: Map<string, number>,
) {
  const out: Candidate[] = [];
  for (const s of series) {
    if (s.market !== "KOSDAQ") continue;
    const sectorCode = sectorCodeBySymbol.get(s.symbol) ?? s.sectorCode;
    for (let i = 120; i + 1 < s.bars.length; i++) {
      const year = Number(s.bars[i]!.tradeDate.slice(0, 4));
      if (!FOLD_YEARS.includes(year as FoldYear)) continue;
      if (!crossedUp(adjustedScoreAt(s, i - 1), adjustedScoreAt(s, i), ENTRY_THRESHOLD)) continue;
      const c = buildCandidate(s, i, year as FoldYear, sectorCode, rotationMap, membership, kosdaqReturns);
      if (c) out.push(c);
    }
  }
  return out;
}

function priorityScore(c: Candidate, indexWeight: IndexWeight) {
  return c.basePriorityNoIndex + (c.indexMember ? indexWeight : 0);
}
function candidateSort(indexWeight: IndexWeight) {
  return (a: Candidate, b: Candidate) => {
    const pa = priorityScore(a, indexWeight), pb = priorityScore(b, indexWeight);
    if (pb !== pa) return pb - pa;
    if (b.signalScore !== a.signalScore) return b.signalScore - a.signalScore;
    if (b.signalTradingValue !== a.signalTradingValue) return b.signalTradingValue - a.signalTradingValue;
    return a.symbol.localeCompare(b.symbol);
  };
}

function seriesLookup(series: PortfolioSeries[]) { return new Map(series.filter((s) => s.market === "KOSDAQ").map((s) => [s.symbol, s])); }
function markPrice(position: Position, date: string, timing: "OPEN" | "CLOSE", lookup: Map<string, PortfolioSeries>) {
  const s = lookup.get(position.candidate.symbol); const i = s?.dateIndex.get(date); const bar = i === undefined ? undefined : s?.bars[i];
  const price = timing === "OPEN" ? bar?.open : bar?.close;
  return finite(price) && price > 0 ? price : position.lastMark;
}

function simulate(
  fold: FoldYear,
  candidates: Candidate[],
  dates: string[],
  series: PortfolioSeries[],
  indexWeight: IndexWeight,
  maxPositions: PositionLimit,
): Simulation {
  const lookup = seriesLookup(series);
  const halfCost = ROUND_TRIP_COST_BPS / 20_000;
  const byEntry = new Map<string, Candidate[]>();
  for (const c of candidates) { const list = byEntry.get(c.entryDate) ?? []; list.push(c); byEntry.set(c.entryDate, list); }
  for (const list of byEntry.values()) list.sort(candidateSort(indexWeight));
  const positions = new Map<string, Position>();
  const accepted: AcceptedTrade[] = [];
  const points: EquityPoint[] = [];
  let cash = INITIAL_CAPITAL, previousEquity = INITIAL_CAPITAL, peak = INITIAL_CAPITAL;
  let skippedCapacity = 0, skippedAlreadyHeld = 0, skippedCash = 0;
  const close = (symbol: string, p: Position, price: number) => {
    const gross = p.shares * price, fee = gross * halfCost;
    cash += gross - fee;
    const basis = p.entryNotional + p.entryFee;
    accepted.push({ ...p.candidate, priorityScore: p.priorityScore, netReturn: basis > 0 ? (gross - fee) / basis * 100 - 100 : 0 });
    positions.delete(symbol);
  };
  for (const date of dates) {
    for (const p of positions.values()) p.lastMark = markPrice(p, date, "OPEN", lookup);
    for (const [symbol, p] of [...positions]) if (p.candidate.exitDate === date && p.candidate.exitTiming === "OPEN") close(symbol, p, p.candidate.exitPrice);
    const openEquity = cash + [...positions.values()].reduce((s, p) => s + p.shares * p.lastMark, 0);
    for (const c of byEntry.get(date) ?? []) {
      if (positions.has(c.symbol)) { skippedAlreadyHeld++; continue; }
      if (positions.size >= maxPositions) { skippedCapacity++; continue; }
      const budget = Math.min(openEquity / maxPositions, cash / (1 + halfCost));
      const shares = Math.floor(budget / c.entryPrice);
      if (shares < 1) { skippedCash++; continue; }
      const notional = shares * c.entryPrice, fee = notional * halfCost;
      if (notional + fee > cash + 1e-6) { skippedCash++; continue; }
      cash -= notional + fee;
      positions.set(c.symbol, { candidate: c, shares, lastMark: c.entryPrice, entryNotional: notional, entryFee: fee, priorityScore: priorityScore(c, indexWeight) });
    }
    for (const p of positions.values()) p.lastMark = markPrice(p, date, "CLOSE", lookup);
    for (const [symbol, p] of [...positions]) if (p.candidate.exitDate === date && p.candidate.exitTiming === "CLOSE") close(symbol, p, p.candidate.exitPrice);
    const equity = cash + [...positions.values()].reduce((s, p) => s + p.shares * p.lastMark, 0);
    peak = Math.max(peak, equity);
    const dailyReturn = previousEquity > 0 ? equity / previousEquity - 1 : 0;
    points.push({ date, equity, dailyReturn: dailyReturn * 100, cashWeight: equity > 0 ? cash / equity * 100 : 100, activePositions: positions.size, drawdown: peak > 0 ? (equity / peak - 1) * 100 : 0 });
    previousEquity = equity;
  }
  return { fold, indexWeight, maxPositions, points, trades: accepted, candidateSignals: candidates.length, skippedCapacity, skippedAlreadyHeld, skippedCash };
}

function monthlyReturns(points: EquityPoint[]) {
  const groups = new Map<string, number[]>();
  for (const p of points) { const key = p.date.slice(0, 7), list = groups.get(key) ?? []; list.push(p.dailyReturn / 100); groups.set(key, list); }
  return [...groups.values()].map((r) => compound(r)!).filter(finite);
}
function metrics(sim: Simulation) {
  const points = sim.points, trades = sim.trades;
  const finalEquity = points.at(-1)?.equity ?? INITIAL_CAPITAL;
  const totalReturn = (finalEquity / INITIAL_CAPITAL - 1) * 100;
  const daily = points.map((p) => p.dailyReturn / 100);
  const avgDaily = mean(daily), sd = stdev(daily);
  const downside = daily.filter((r) => r < 0);
  const downsideDev = downside.length ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length) : null;
  const tradeReturns = trades.map((t) => t.netReturn), wins = tradeReturns.filter((r) => r > 0), losses = tradeReturns.filter((r) => r < 0);
  const lossSum = Math.abs(losses.reduce((a, b) => a + b, 0));
  const memberTrades = trades.filter((t) => t.indexMember).length;
  const months = monthlyReturns(points);
  return {
    fold: sim.fold, indexWeight: sim.indexWeight, maxPositions: sim.maxPositions,
    totalReturn: round(totalReturn), annualizedVolatility: round(sd === null ? null : sd * Math.sqrt(252) * 100),
    sharpe: round(sd && avgDaily !== null ? avgDaily / sd * Math.sqrt(252) : null),
    sortino: round(downsideDev && avgDaily !== null ? avgDaily / downsideDev * Math.sqrt(252) : null),
    mdd: round(points.length ? Math.min(...points.map((p) => p.drawdown)) : null),
    worstMonthlyReturn: round(months.length ? Math.min(...months) : null),
    trades: trades.length, winRate: round(trades.length ? wins.length / trades.length * 100 : null),
    avgTradeReturn: round(mean(tradeReturns)), medianTradeReturn: round(median(tradeReturns)),
    profitFactor: round(lossSum > 0 ? wins.reduce((a, b) => a + b, 0) / lossSum : null),
    avgMae: round(mean(trades.map((t) => t.mae))), avgMfe: round(mean(trades.map((t) => t.mfe))),
    avgHoldingDays: round(mean(trades.map((t) => t.holdingDays)), 2),
    indexMemberTradeShare: round(trades.length ? memberTrades / trades.length * 100 : null),
    avgPriorityScore: round(mean(trades.map((t) => t.priorityScore))),
    avgActivePositions: round(mean(points.map((p) => p.activePositions)), 2),
    peakActivePositions: points.length ? Math.max(...points.map((p) => p.activePositions)) : 0,
    avgCashWeight: round(mean(points.map((p) => p.cashWeight))),
    exposureUtilization: round(mean(points.map((p) => p.activePositions / sim.maxPositions * 100))),
    candidateSignals: sim.candidateSignals, skippedCapacity: sim.skippedCapacity, skippedAlreadyHeld: sim.skippedAlreadyHeld, skippedCash: sim.skippedCash,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const parsed = parseManualMarketData(texts);
  const dataset = parsed.dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const canonical = buildFullUniverseSectorDataset(dataset);
  const sectorCodeBySymbol = new Map(canonical.instruments.map((i) => [i.symbol, i.sectorCode]));
  const membership = await loadMembershipIntervals();
  process.stdout.write("Building historical sector rotation map...\n");
  const rotationMap = buildHistoricalRotationScoreMap(dataset);
  process.stdout.write(`Historical rotation points: ${rotationMap.size}\n`);
  const kosdaq = dataset.indexSeries.find((s) => s.indexCode === "KOSDAQ");
  if (!kosdaq) throw new Error("KOSDAQ index series not found");
  const kosdaqReturns = benchmarkReturnMap(kosdaq.bars);
  const candidates = buildCandidates(context.series, sectorCodeBySymbol, rotationMap, membership, kosdaqReturns);
  const series = context.series.filter((s) => s.market === "KOSDAQ");
  const foldMetrics: ReturnType<typeof metrics>[] = [];
  const simulations: Simulation[] = [];
  for (const fold of FOLD_YEARS) {
    const foldCandidates = candidates.filter((c) => c.fold === fold);
    const lastExit = foldCandidates.map((c) => c.exitDate).sort().at(-1) ?? `${fold}-12-31`;
    const dates = kosdaq.bars.map((b) => b.tradeDate).filter((d) => d >= `${fold}-01-01` && d <= lastExit);
    for (const indexWeight of INDEX_WEIGHTS) for (const maxPositions of POSITION_LIMITS) {
      const sim = simulate(fold, foldCandidates, dates, series, indexWeight, maxPositions);
      simulations.push(sim);
      foldMetrics.push(metrics(sim));
    }
  }
  const summary = INDEX_WEIGHTS.flatMap((indexWeight) => POSITION_LIMITS.map((maxPositions) => {
    const rows = foldMetrics.filter((r) => r.indexWeight === indexWeight && r.maxPositions === maxPositions);
    const returns = rows.map((r) => r.totalReturn).filter(finite);
    const vols = rows.map((r) => r.annualizedVolatility).filter(finite);
    const sharpes = rows.map((r) => r.sharpe).filter(finite);
    const sortinos = rows.map((r) => r.sortino).filter(finite);
    const mdds = rows.map((r) => r.mdd).filter(finite);
    const memberShares = rows.map((r) => r.indexMemberTradeShare).filter(finite);
    return {
      indexWeight, maxPositions, folds: rows.length,
      positiveFolds: rows.filter((r) => finite(r.totalReturn) && r.totalReturn > 0).length,
      meanFoldReturn: round(mean(returns)), medianFoldReturn: round(median(returns)), worstFoldReturn: round(returns.length ? Math.min(...returns) : null),
      threeFoldCompoundedReturn: round(returns.length ? (returns.reduce((eq, r) => eq * (1 + r / 100), 1) - 1) * 100 : null),
      meanAnnualizedVolatility: round(mean(vols)), meanSharpe: round(mean(sharpes)), meanSortino: round(mean(sortinos)),
      meanMdd: round(mean(mdds)), worstMdd: round(mdds.length ? Math.min(...mdds) : null),
      totalTrades: rows.reduce((s, r) => s + r.trades, 0), meanIndexMemberTradeShare: round(mean(memberShares)),
      meanCashWeight: round(mean(rows.map((r) => r.avgCashWeight).filter(finite))),
      meanExposureUtilization: round(mean(rows.map((r) => r.exposureUtilization).filter(finite))),
      totalCapacitySkips: rows.reduce((s, r) => s + r.skippedCapacity, 0),
    };
  }));
  const baseline = new Map(summary.filter((r) => r.indexWeight === 0).map((r) => [r.maxPositions, r]));
  const comparison = summary.map((r) => {
    const b = baseline.get(r.maxPositions)!;
    return {
      ...r,
      deltaMeanFoldReturnVs0: round(finite(r.meanFoldReturn) && finite(b.meanFoldReturn) ? r.meanFoldReturn - b.meanFoldReturn : null),
      deltaVolVs0: round(finite(r.meanAnnualizedVolatility) && finite(b.meanAnnualizedVolatility) ? r.meanAnnualizedVolatility - b.meanAnnualizedVolatility : null),
      deltaWorstMddVs0: round(finite(r.worstMdd) && finite(b.worstMdd) ? r.worstMdd - b.worstMdd : null),
      deltaMemberShareVs0: round(finite(r.meanIndexMemberTradeShare) && finite(b.meanIndexMemberTradeShare) ? r.meanIndexMemberTradeShare - b.meanIndexMemberTradeShare : null),
    };
  });
  const result = {
    version: STUDY_VERSION, createdAt: new Date().toISOString(),
    data: { datasetVersion: dataset.version, asOfDate: dataset.asOfDate, sourceCacheKey: manifest.cacheKey, sourceFiles: manifest.fileCount, sourceBytes: manifest.totalBytes, symbolCount: context.symbolCount, rotationMapPoints: rotationMap.size, membershipSymbols: membership.size },
    design: {
      folds: [...FOLD_YEARS], market: "KOSDAQ", indexMembership: "signal-date point-in-time KOSDAQ150 membership",
      indexWeights: [...INDEX_WEIGHTS], positionLimits: [...POSITION_LIMITS], initialCapital: INITIAL_CAPITAL,
      entry: "V8 adjusted score 8.0 upward Onset, next trading-day open", exit: "9.5 upward or 2.5 downward crossing at next open; otherwise max 60D close",
      priority: "indexWeight*KOSDAQ150 + size>=3,000억(+1) + benchmark excess return>=2%p(+1) + sectorRotation/100(+0~1) + SupplyRisk(0~-1)",
      tieBreak: "priority desc -> V8 technical score desc -> signal trading value desc -> symbol",
      allocation: "equal fixed slot 1/maxPositions; no automatic rebalance; cash allowed; whole shares",
      capacity: "exit at open before same-day entries; capacity-skipped onset is not delayed; re-entry requires a later new onset",
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      foldReset: "each fold starts with 100% cash and independent initial capital",
    },
    candidateCount: candidates.length,
    candidateFoldCounts: FOLD_YEARS.map((fold) => ({ fold, candidates: candidates.filter((c) => c.fold === fold).length })),
    componentCoverage: {
      rotation: candidates.filter((c) => c.sectorRotationScore !== null).length,
      relative: candidates.filter((c) => c.relativeReturnPp !== null).length,
      marketCap: candidates.filter((c) => c.marketCap !== null).length,
      indexMembers: candidates.filter((c) => c.indexMember).length,
      total: candidates.length,
    },
    foldMetrics, summary: comparison,
    notes: [
      "기술점수·Entry/Exit은 지수 가중치와 무관하게 고정했고 우선점수는 동시 진입 후보의 포트폴리오 수용 순서에만 사용했다.",
      "지수편입 이력은 사용자가 KRX에서 수집한 point-in-time KOSDAQ150 이력을 사용해 look-ahead를 피했다.",
      "Sector Rotation은 CloudTrend의 가격리더십40%+자금흐름45%+로테이션모멘텀15% 산식을 일별로 과거 재계산했다.",
      "결과 차이는 포트폴리오 용량 제약이 발생하는 날에만 우선순위 변화가 실제 보유 종목을 바꾸기 때문에, capacity skip과 지수편입 종목 비중을 함께 해석해야 한다.",
    ],
  };
  const created = result.createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  await mkdir("analysis-runs", { recursive: true });
  const outputPath = `analysis-runs/v8-13-priority-index-weight-portfolio-3fos-${created}.json`;
  await writeFile(outputPath, JSON.stringify(result, null, 2));
  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-13-priority-index-weight-portfolio-3fos/${created}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(client, `${options.userId}/results/v8-13-priority-index-weight-portfolio-3fos/latest.json`, { version: STUDY_VERSION, createdAt: result.createdAt, resultPath: remotePath, candidateCount: result.candidateCount, foldMetrics: result.foldMetrics, summary: result.summary, componentCoverage: result.componentCoverage });
  }
  process.stdout.write(`${JSON.stringify({ outputPath, remotePath, candidateCount: result.candidateCount, candidateFoldCounts: result.candidateFoldCounts, componentCoverage: result.componentCoverage, summary: result.summary }, null, 2)}\n`);
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
