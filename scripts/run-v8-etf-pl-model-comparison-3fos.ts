import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  buildPortfolioSignalContext,
  type PortfolioSeries,
} from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { DailyPrice, Instrument } from "../src/lib/engine/types";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8 ETF PL Model Comparison 3-FOS Expanded ETF History" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const LIMIT = 613;
const INITIAL_CAPITAL = 100_000_000;
const ROUND_TRIP_COST_BPS = 30;
const ENTRY_THRESHOLD = 8;
const PL_OVERHEAT_THRESHOLD = 80;
const SECTOR_SLOT = 0.5;
const MAX_POSITIONS = 10;

type FoldYear = (typeof FOLD_YEARS)[number];
type Market = "KOSPI" | "KOSDAQ";
type ModelId = "A_STOCK_PL" | "B_ETF_PL" | "C_HYBRID_PL" | "D_ETF_PRIMARY_FALLBACK";

interface ModelDef {
  id: ModelId;
  label: string;
  description: string;
}

const MODELS: ModelDef[] = [
  { id: "A_STOCK_PL", label: "A. Existing V8", description: "Stock PL only" },
  { id: "B_ETF_PL", label: "B. ETF PL", description: "ETF PL only" },
  {
    id: "C_HYBRID_PL",
    label: "C. Hybrid PL",
    description: "50% Stock PL + 50% ETF PL when both exist; otherwise use the available side",
  },
  {
    id: "D_ETF_PRIMARY_FALLBACK",
    label: "D. ETF-primary fallback",
    description: "Use ETF PL when available; otherwise fall back to Stock PL",
  },
];

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

interface EtfCacheManifest {
  version: "etf-backtest-cache-v1";
  createdAt: string;
  cacheKey: string;
  sourceFilename: string;
  logicalFileHash: string;
  logicalSizeBytes: number;
  cacheFile: string;
}

interface Options {
  sourceManifest: string;
  sourceCacheDir: string;
  etfSourceManifest: string;
  etfSourceCacheDir: string;
  userId: string | null;
  upload: boolean;
}

interface Prepared {
  instrument: Instrument;
  bars: DailyPrice[];
  dateIndex: Map<string, number>;
  closePrefix: number[];
  turnoverPrefix: number[];
  rollingHigh250: number[];
}

interface Agg {
  sectorCode: string;
  r20: number[];
  r60: number[];
  r120: number[];
  turnover5: number;
  turnover20: number;
  turnover5Count: number;
  turnover20Count: number;
  aboveMa20True: number;
  aboveMa20Valid: number;
  aboveMa60True: number;
  aboveMa60Valid: number;
  aboveMa120True: number;
  aboveMa120Valid: number;
  maAlignedTrue: number;
  maAlignedValid: number;
  nearHighTrue: number;
  nearHighValid: number;
  advancingTrue: number;
  advancingValid: number;
}

interface RawSector {
  sectorCode: string;
  rs20: number | null;
  rs60: number | null;
  rs120: number | null;
  relativeTurnover: number | null;
  advancing: number | null;
  aboveMa20: number | null;
  aboveMa60: number | null;
  aboveMa120: number | null;
  maAligned: number | null;
  nearHigh: number | null;
}

interface Candidate {
  symbol: string;
  name: string;
  market: Market;
  sectorCode: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  exitTiming: "OPEN" | "CLOSE";
  exitReason: "UP" | "DOWN" | "TIME";
  holdingDays: number;
  adjustedScore10: number;
  scoreRise5d: number | null;
  sectorPl: number | null;
  signalTradingValue: number;
  grossReturn: number;
}

interface Position {
  candidate: Candidate;
  shares: number;
  entryNotional: number;
  entryFee: number;
  lastMark: number;
}

interface ClosedTrade extends Candidate {
  netReturn: number;
}

interface EquityPoint {
  date: string;
  equity: number;
  cashWeight: number;
  activePositions: number;
  drawdown: number;
}

interface Simulation {
  points: EquityPoint[];
  trades: ClosedTrade[];
  candidateSignals: number;
  skippedForCapacity: number;
  totalFees: number;
}

interface FoldRow {
  model: ModelId;
  market: Market;
  fold: FoldYear;
  candidateSignals: number;
  trades: number;
  plCoverageRate: number | null;
  slotEarnRate: number | null;
  avgSignalPl: number | null;
  candidateAvgGrossReturn: number | null;
  candidateMedianGrossReturn: number | null;
  candidateWinRate: number | null;
  totalReturn: number | null;
  benchmarkReturn: number | null;
  excessReturn: number | null;
  cagr: number | null;
  mdd: number | null;
  avgTradeReturn: number | null;
  medianTradeReturn: number | null;
  winRate: number | null;
  profitFactor: number | null;
  avgHoldingDays: number | null;
  avgCapitalOccupancy: number | null;
  skippedForCapacity: number;
  totalFees: number;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node scripts/run-v8-etf-pl-model-comparison-3fos.ts --source-manifest <path> --source-cache-dir <dir> --etf-source-manifest <path> --etf-source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    sourceManifest: "",
    sourceCacheDir: "",
    etfSourceManifest: "",
    etfSourceCacheDir: "",
    userId: process.env["SUPABASE_USER_ID"] ?? null,
    upload: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source-manifest")
      options.sourceManifest = argv[++i] ?? usage("--source-manifest value is required.");
    else if (arg === "--source-cache-dir")
      options.sourceCacheDir = argv[++i] ?? usage("--source-cache-dir value is required.");
    else if (arg === "--etf-source-manifest")
      options.etfSourceManifest = argv[++i] ?? usage("--etf-source-manifest value is required.");
    else if (arg === "--etf-source-cache-dir")
      options.etfSourceCacheDir = argv[++i] ?? usage("--etf-source-cache-dir value is required.");
    else if (arg === "--supabase-user-id")
      options.userId = argv[++i] ?? usage("--supabase-user-id value is required.");
    else if (arg === "--upload") options.upload = true;
    else usage("Unsupported argument: " + arg);
  }
  if (
    !options.sourceManifest ||
    !options.sourceCacheDir ||
    !options.etfSourceManifest ||
    !options.etfSourceCacheDir
  )
    usage("stock and ETF source manifests/cache dirs are required.");
  if (options.upload && !/^[0-9a-f-]{36}$/i.test(options.userId ?? ""))
    usage("A valid Supabase user id is required for upload.");
  return options;
}

const finite = (v: number | null | undefined): v is number =>
  v !== null && v !== undefined && Number.isFinite(v);
const average = (xs: number[]) =>
  xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : null;
function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2;
}
function round(v: number | null, digits = 6) {
  if (!finite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
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
    throw new Error("Unsupported or damaged source cache manifest.");
  const texts: string[] = [];
  for (const file of manifest.files) {
    const bytes = new Uint8Array(await readFile(path.join(cacheDir, file.cacheFile)));
    const fileHash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== file.bytes || fileHash !== file.fileHash)
      throw new Error("Source cache integrity failure: " + file.fileName);
    texts.push(decodeSourceBytes(bytes));
  }
  process.stderr.write(
    "Stock source cache verified: " +
      manifest.fileCount +
      " files / " +
      (manifest.totalBytes / 1_000_000).toFixed(1) +
      " MB\n",
  );
  return { texts, manifest };
}

async function loadEtfCachedText(manifestPath: string, cacheDir: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EtfCacheManifest;
  if (
    manifest.version !== "etf-backtest-cache-v1" ||
    !/^[0-9a-f]{64}$/.test(manifest.cacheKey) ||
    manifest.cacheFile !== manifest.cacheKey + ".source" ||
    manifest.logicalFileHash !== "sha256:" + manifest.cacheKey
  )
    throw new Error("Unsupported or damaged ETF source cache manifest.");
  const bytes = new Uint8Array(await readFile(path.join(cacheDir, manifest.cacheFile)));
  const fileHash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== manifest.logicalSizeBytes || fileHash !== manifest.logicalFileHash)
    throw new Error("ETF source cache integrity failure: " + manifest.sourceFilename);
  process.stderr.write(
    "ETF canonical source cache verified: " +
      manifest.sourceFilename +
      " / " +
      (manifest.logicalSizeBytes / 1_000_000).toFixed(1) +
      " MB logical CSV\n",
  );
  return { text: decodeSourceBytes(bytes), manifest };
}

function prefix(values: number[]) {
  const out = new Array<number>(values.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) out[i + 1] = out[i]! + values[i]!;
  return out;
}
function windowSum(sum: number[], endIndex: number, period: number) {
  const start = endIndex - period + 1;
  return start < 0 ? null : sum[endIndex + 1]! - sum[start]!;
}
function periodReturn(bars: DailyPrice[], endIndex: number, period: number) {
  const past = bars[endIndex - period]?.close;
  const cur = bars[endIndex]?.close;
  return finite(past) && finite(cur) && past > 0 ? cur / past - 1 : null;
}
function rollingHigh(bars: DailyPrice[], window = 250, minimum = 60) {
  const out = new Array<number>(bars.length).fill(Number.NaN);
  const deque: number[] = [];
  let head = 0;
  for (let i = 0; i < bars.length; i++) {
    while (head < deque.length && deque[head]! < i - window + 1) head++;
    while (deque.length > head && bars[deque[deque.length - 1]!]!.high <= bars[i]!.high)
      deque.pop();
    deque.push(i);
    if (i >= minimum - 1) out[i] = bars[deque[head]!]!.high;
    if (head > 256 && head * 2 > deque.length) {
      deque.splice(0, head);
      head = 0;
    }
  }
  return out;
}
function prep(instrument: Instrument, bars: DailyPrice[]): Prepared {
  return {
    instrument,
    bars,
    dateIndex: new Map(bars.map((b, i) => [b.tradeDate, i])),
    closePrefix: prefix(bars.map((b) => b.close)),
    turnoverPrefix: prefix(bars.map((b) => b.tradingValue)),
    rollingHigh250: rollingHigh(bars),
  };
}
function createAgg(code: string): Agg {
  return {
    sectorCode: code,
    r20: [],
    r60: [],
    r120: [],
    turnover5: 0,
    turnover20: 0,
    turnover5Count: 0,
    turnover20Count: 0,
    aboveMa20True: 0,
    aboveMa20Valid: 0,
    aboveMa60True: 0,
    aboveMa60Valid: 0,
    aboveMa120True: 0,
    aboveMa120Valid: 0,
    maAlignedTrue: 0,
    maAlignedValid: 0,
    nearHighTrue: 0,
    nearHighValid: 0,
    advancingTrue: 0,
    advancingValid: 0,
  };
}
function addBool(
  agg: Agg,
  key: "aboveMa20" | "aboveMa60" | "aboveMa120" | "maAligned" | "nearHigh" | "advancing",
  value: boolean | null,
) {
  if (value === null) return;
  (agg[(key + "True") as keyof Agg] as number) += value ? 1 : 0;
  (agg[(key + "Valid") as keyof Agg] as number) += 1;
}
function ratio(t: number, n: number) {
  return n ? (t / n) * 100 : null;
}
function avgRatio(values: Array<number | null>) {
  const valid = values.filter(finite).map((v) => v / 100);
  return average(valid);
}
function percentileRatio(sortedAsc: number[], value: number | null) {
  if (!finite(value) || !sortedAsc.length) return null;
  let below = 0;
  for (const x of sortedAsc) if (x < value) below++;
  return below / sortedAsc.length;
}
function combine(parts: Array<{ weight: number; ratio: number | null }>) {
  const available = parts.filter((p) => finite(p.ratio));
  const weight = available.reduce((sum, p) => sum + p.weight, 0);
  return weight
    ? (available.reduce((sum, p) => sum + p.weight * (p.ratio ?? 0), 0) / weight) * 100
    : null;
}

function buildPriceLeadershipMap(dataset: MarketDataset, sourceType: "STOCK" | "ETF") {
  const kospi = dataset.indexSeries.find((s) => s.indexCode === "KOSPI");
  if (!kospi || kospi.bars.length < 130) return new Map<string, number>();
  const prepared = dataset.instruments
    .filter(
      (inst) =>
        inst.instrumentType === sourceType &&
        inst.isActive &&
        inst.sectorCode !== "MARKET_IDX" &&
        inst.sectorCode !== "ETC",
    )
    .map((inst) => prep(inst, dataset.bars[inst.symbol] ?? []))
    .filter((x) => x.bars.length >= 130);
  const out = new Map<string, number>();
  for (let mi = 120; mi < kospi.bars.length; mi++) {
    const date = kospi.bars[mi]!.tradeDate;
    const mr20 = periodReturn(kospi.bars, mi, 20);
    const mr60 = periodReturn(kospi.bars, mi, 60);
    const mr120 = periodReturn(kospi.bars, mi, 120);
    const aggs = new Map<string, Agg>();
    for (const item of prepared) {
      const i = item.dateIndex.get(date);
      if (i === undefined || i < 120) continue;
      const bar = item.bars[i]!;
      const prev = item.bars[i - 1];
      if (!prev) continue;
      const ma = (p: number) => {
        const v = windowSum(item.closePrefix, i, p);
        return v === null ? null : v / p;
      };
      const tv = (p: number) => {
        const v = windowSum(item.turnoverPrefix, i, p);
        return v === null ? null : v / p;
      };
      const ma20 = ma(20);
      const ma60 = ma(60);
      const ma120 = ma(120);
      const tv5 = tv(5);
      const tv20 = tv(20);
      const code = item.instrument.sectorCode;
      const agg = aggs.get(code) ?? createAgg(code);
      const r20 = periodReturn(item.bars, i, 20);
      const r60 = periodReturn(item.bars, i, 60);
      const r120 = periodReturn(item.bars, i, 120);
      if (finite(r20)) agg.r20.push(r20);
      if (finite(r60)) agg.r60.push(r60);
      if (finite(r120)) agg.r120.push(r120);
      if (finite(tv5)) {
        agg.turnover5 += tv5;
        agg.turnover5Count++;
      }
      if (finite(tv20)) {
        agg.turnover20 += tv20;
        agg.turnover20Count++;
      }
      addBool(agg, "aboveMa20", ma20 === null ? null : bar.close > ma20);
      addBool(agg, "aboveMa60", ma60 === null ? null : bar.close > ma60);
      addBool(agg, "aboveMa120", ma120 === null ? null : bar.close > ma120);
      addBool(
        agg,
        "maAligned",
        ma20 === null || ma60 === null || ma120 === null ? null : ma20 > ma60 && ma60 > ma120,
      );
      addBool(
        agg,
        "nearHigh",
        Number.isFinite(item.rollingHigh250[i])
          ? bar.close >= item.rollingHigh250[i]! * 0.95
          : null,
      );
      addBool(agg, "advancing", bar.close > prev.close);
      aggs.set(code, agg);
    }
    const raw: RawSector[] = [...aggs.values()].map((a) => {
      const e20 = median(a.r20);
      const e60 = median(a.r60);
      const e120 = median(a.r120);
      return {
        sectorCode: a.sectorCode,
        rs20: finite(e20) && finite(mr20) ? (e20 - mr20) * 100 : null,
        rs60: finite(e60) && finite(mr60) ? (e60 - mr60) * 100 : null,
        rs120: finite(e120) && finite(mr120) ? (e120 - mr120) * 100 : null,
        relativeTurnover:
          a.turnover20Count && a.turnover5Count && a.turnover20 > 0
            ? a.turnover5 / a.turnover20
            : null,
        advancing: ratio(a.advancingTrue, a.advancingValid),
        aboveMa20: ratio(a.aboveMa20True, a.aboveMa20Valid),
        aboveMa60: ratio(a.aboveMa60True, a.aboveMa60Valid),
        aboveMa120: ratio(a.aboveMa120True, a.aboveMa120Valid),
        maAligned: ratio(a.maAlignedTrue, a.maAlignedValid),
        nearHigh: ratio(a.nearHighTrue, a.nearHighValid),
      };
    });
    const rs20s = raw.map((r) => r.rs20).filter(finite).sort((a, b) => a - b);
    const rs60s = raw.map((r) => r.rs60).filter(finite).sort((a, b) => a - b);
    const rs120s = raw.map((r) => r.rs120).filter(finite).sort((a, b) => a - b);
    for (const r of raw) {
      const trend = avgRatio([r.aboveMa20, r.aboveMa60, r.aboveMa120]);
      const breadth = avgRatio([r.advancing, r.aboveMa20, r.maAligned]);
      const price = combine([
        { weight: 20, ratio: percentileRatio(rs20s, r.rs20) },
        { weight: 20, ratio: percentileRatio(rs60s, r.rs60) },
        { weight: 10, ratio: percentileRatio(rs120s, r.rs120) },
        { weight: 15, ratio: trend },
        { weight: 20, ratio: breadth },
        { weight: 10, ratio: r.nearHigh === null ? null : r.nearHigh / 100 },
        {
          weight: 5,
          ratio:
            r.relativeTurnover === null
              ? null
              : Math.min(1, Math.max(0, (r.relativeTurnover - 0.7) / 0.8)),
        },
      ]);
      if (finite(price)) out.set(date + "|" + r.sectorCode, price);
    }
  }
  return out;
}

function hybridMap(stock: Map<string, number>, etf: Map<string, number>) {
  const out = new Map<string, number>();
  const keys = new Set([...stock.keys(), ...etf.keys()]);
  for (const key of keys) {
    const s = stock.get(key);
    const e = etf.get(key);
    if (finite(s) && finite(e)) out.set(key, (s + e) / 2);
    else if (finite(s)) out.set(key, s);
    else if (finite(e)) out.set(key, e);
  }
  return out;
}

function etfPrimaryFallbackMap(stock: Map<string, number>, etf: Map<string, number>) {
  const out = new Map<string, number>();
  const keys = new Set([...stock.keys(), ...etf.keys()]);
  for (const key of keys) {
    const e = etf.get(key);
    const s = stock.get(key);
    if (finite(e)) out.set(key, e);
    else if (finite(s)) out.set(key, s);
  }
  return out;
}

function attachPl(series: PortfolioSeries[], map: Map<string, number>) {
  return series.map((s) => ({
    ...s,
    sectorPriceLeadership: s.bars.map(
      (bar) => map.get(bar.tradeDate + "|" + s.sectorCode) ?? null,
    ),
  }));
}

function adjustedScoreAt(series: PortfolioSeries, index: number) {
  const base = series.baseScores[index];
  if (!finite(base)) return null;
  const pl = series.sectorPriceLeadership[index] ?? null;
  const contribution = finite(pl) && pl < PL_OVERHEAT_THRESHOLD ? SECTOR_SLOT : 0;
  return Math.min(10, Math.max(0, Math.round((base + contribution) * 100) / 100));
}
function crossedUp(prev: number | null, cur: number | null, threshold: number) {
  return finite(prev) && finite(cur) && prev < threshold && cur >= threshold;
}
function crossedDown(prev: number | null, cur: number | null, threshold: number) {
  return finite(prev) && finite(cur) && prev > threshold && cur <= threshold;
}
function scoreRise(series: PortfolioSeries, index: number) {
  const cur = adjustedScoreAt(series, index);
  const prev = adjustedScoreAt(series, index - 5);
  return finite(cur) && finite(prev) ? (cur - prev) * 10 : null;
}

function buildCandidates(series: PortfolioSeries[], market: Market, fold: FoldYear) {
  const out: Candidate[] = [];
  const up = market === "KOSDAQ" ? 9 : 9.5;
  const down = market === "KOSDAQ" ? 3 : 2.5;
  const maxHolding = 60;
  for (const s of series) {
    if (s.market !== market) continue;
    for (let i = 120; i + 1 < s.bars.length; i++) {
      if (Number(s.bars[i]!.tradeDate.slice(0, 4)) !== fold) continue;
      const prevScore = adjustedScoreAt(s, i - 1);
      const score = adjustedScoreAt(s, i);
      if (!crossedUp(prevScore, score, ENTRY_THRESHOLD)) continue;
      const entryIndex = i + 1;
      const entry = s.bars[entryIndex];
      if (!entry || !finite(entry.open) || entry.open <= 0) continue;
      const plannedExit = i + maxHolding;
      let exitIndex = -1;
      let exitPrice = 0;
      let exitTiming: Candidate["exitTiming"] = "CLOSE";
      let exitReason: Candidate["exitReason"] = "TIME";
      for (let j = entryIndex; j <= Math.min(plannedExit, s.bars.length - 1); j++) {
        const bar = s.bars[j]!;
        if (![bar.open, bar.close, bar.low, bar.high].every((v) => finite(v) && v > 0)) {
          exitIndex = -1;
          break;
        }
        if (j > entryIndex) {
          const si = j - 1;
          const p = adjustedScoreAt(s, si - 1);
          const c = adjustedScoreAt(s, si);
          if (crossedDown(p, c, down)) {
            exitIndex = j;
            exitPrice = bar.open;
            exitTiming = "OPEN";
            exitReason = "DOWN";
            break;
          }
          if (crossedUp(p, c, up)) {
            exitIndex = j;
            exitPrice = bar.open;
            exitTiming = "OPEN";
            exitReason = "UP";
            break;
          }
        }
        if (j === plannedExit) {
          exitIndex = j;
          exitPrice = bar.close;
          exitTiming = "CLOSE";
          exitReason = "TIME";
        }
      }
      if (exitIndex < 0 || exitPrice <= 0 || !finite(score)) continue;
      const pl = s.sectorPriceLeadership[i] ?? null;
      out.push({
        symbol: s.symbol,
        name: s.name,
        market,
        sectorCode: s.sectorCode,
        signalDate: s.bars[i]!.tradeDate,
        entryDate: entry.tradeDate,
        exitDate: s.bars[exitIndex]!.tradeDate,
        entryPrice: entry.open,
        exitPrice,
        exitTiming,
        exitReason,
        holdingDays: exitIndex - entryIndex + 1,
        adjustedScore10: score,
        scoreRise5d: scoreRise(s, i),
        sectorPl: pl,
        signalTradingValue: s.bars[i]?.tradingValue ?? 0,
        grossReturn: (exitPrice / entry.open - 1) * 100,
      });
    }
  }
  return out;
}

function key(market: string, symbol: string) {
  return market + ":" + symbol;
}
function candidatePriority(a: Candidate, b: Candidate) {
  if (b.adjustedScore10 !== a.adjustedScore10) return b.adjustedScore10 - a.adjustedScore10;
  const ar = a.scoreRise5d ?? -Infinity;
  const br = b.scoreRise5d ?? -Infinity;
  if (br !== ar) return br - ar;
  if (b.signalTradingValue !== a.signalTradingValue)
    return b.signalTradingValue - a.signalTradingValue;
  return a.symbol.localeCompare(b.symbol);
}
function calendar(dataset: MarketDataset, market: Market) {
  return (
    dataset.indexSeries.find((s) => s.indexCode === market)?.bars.map((b) => b.tradeDate) ?? []
  );
}
function evaluationDates(dataset: MarketDataset, market: Market, fold: FoldYear) {
  const dates = calendar(dataset, market);
  const first = dates.findIndex((d) => Number(d.slice(0, 4)) === fold);
  let last = -1;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (Number(dates[i]!.slice(0, 4)) === fold) {
      last = i;
      break;
    }
  }
  if (first < 0 || last < first) return [];
  // Fold-year signals may hold for up to 60 trading days, so use a model-independent
  // tail long enough to realize every planned exit on the same evaluation calendar.
  return dates.slice(first, Math.min(dates.length, last + 66));
}

function simulate(
  series: PortfolioSeries[],
  candidates: Candidate[],
  dates: string[],
): Simulation {
  const seriesMap = new Map(series.map((s) => [key(s.market, s.symbol), s]));
  const halfCost = ROUND_TRIP_COST_BPS / 20_000;
  const byEntry = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byEntry.get(c.entryDate) ?? [];
    list.push(c);
    byEntry.set(c.entryDate, list);
  }
  for (const list of byEntry.values()) list.sort(candidatePriority);

  const positions = new Map<string, Position>();
  const trades: ClosedTrade[] = [];
  const points: EquityPoint[] = [];
  let cash = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let totalFees = 0;
  let skippedForCapacity = 0;

  const mark = (position: Position, date: string, timing: "OPEN" | "CLOSE") => {
    const s = seriesMap.get(key(position.candidate.market, position.candidate.symbol));
    const i = s?.dateIndex.get(date);
    const bar = i === undefined ? undefined : s?.bars[i];
    const price = timing === "OPEN" ? bar?.open : bar?.close;
    return finite(price) && price > 0 ? price : position.lastMark;
  };

  const closePosition = (positionKey: string, position: Position, price: number) => {
    const gross = position.shares * price;
    const fee = gross * halfCost;
    cash += gross - fee;
    totalFees += fee;
    const basis = position.entryNotional + position.entryFee;
    trades.push({
      ...position.candidate,
      netReturn: basis > 0 ? ((gross - fee) / basis - 1) * 100 : 0,
    });
    positions.delete(positionKey);
  };

  for (const date of dates) {
    for (const p of positions.values()) p.lastMark = mark(p, date, "OPEN");
    for (const [k, p] of [...positions]) {
      if (p.candidate.exitDate === date && p.candidate.exitTiming === "OPEN")
        closePosition(k, p, p.candidate.exitPrice);
    }
    const openMarked = [...positions.values()].reduce(
      (sum, p) => sum + p.shares * p.lastMark,
      0,
    );
    const openEquity = cash + openMarked;
    for (const candidate of byEntry.get(date) ?? []) {
      const k = key(candidate.market, candidate.symbol);
      if (positions.has(k)) continue;
      if (positions.size >= MAX_POSITIONS) {
        skippedForCapacity++;
        continue;
      }
      const targetNotional = openEquity / MAX_POSITIONS;
      const maxAffordable = cash / (1 + halfCost);
      const entryNotional = Math.min(targetNotional, maxAffordable);
      if (!(entryNotional > 1)) continue;
      const shares = entryNotional / candidate.entryPrice;
      const entryFee = entryNotional * halfCost;
      cash -= entryNotional + entryFee;
      totalFees += entryFee;
      positions.set(k, {
        candidate,
        shares,
        entryNotional,
        entryFee,
        lastMark: candidate.entryPrice,
      });
    }
    for (const p of positions.values()) p.lastMark = mark(p, date, "CLOSE");
    for (const [k, p] of [...positions]) {
      if (p.candidate.exitDate === date && p.candidate.exitTiming === "CLOSE")
        closePosition(k, p, p.candidate.exitPrice);
    }
    const marked = [...positions.values()].reduce(
      (sum, p) => sum + p.shares * p.lastMark,
      0,
    );
    const equity = cash + marked;
    peak = Math.max(peak, equity);
    points.push({
      date,
      equity,
      cashWeight: equity > 0 ? (cash / equity) * 100 : 100,
      activePositions: positions.size,
      drawdown: peak > 0 ? (equity / peak - 1) * 100 : 0,
    });
  }
  return {
    points,
    trades,
    candidateSignals: candidates.length,
    skippedForCapacity,
    totalFees,
  };
}

function benchmarkReturn(dataset: MarketDataset, market: Market, start: string, end: string) {
  const bars = dataset.indexSeries.find((s) => s.indexCode === market)?.bars ?? [];
  const map = new Map(bars.map((b) => [b.tradeDate, b]));
  const a = map.get(start);
  const b = map.get(end);
  if (!a || !b || !finite(a.open) || a.open <= 0 || !finite(b.close) || b.close <= 0)
    return null;
  return (b.close / a.open - 1) * 100;
}
function profitFactor(xs: number[]) {
  const wins = xs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(xs.filter((x) => x < 0).reduce((a, b) => a + b, 0));
  return losses > 0 ? wins / losses : null;
}

function foldRow(
  model: ModelId,
  market: Market,
  fold: FoldYear,
  dataset: MarketDataset,
  candidates: Candidate[],
  simulation: Simulation,
): FoldRow {
  const points = simulation.points;
  const finalEquity = points.at(-1)?.equity ?? INITIAL_CAPITAL;
  const totalReturn = points.length ? (finalEquity / INITIAL_CAPITAL - 1) * 100 : null;
  const years = points.length / 252;
  const cagr =
    years > 0 && finalEquity > 0
      ? ((finalEquity / INITIAL_CAPITAL) ** (1 / years) - 1) * 100
      : null;
  const benchmark =
    points.length > 0
      ? benchmarkReturn(dataset, market, points[0]!.date, points.at(-1)!.date)
      : null;
  const returns = simulation.trades.map((t) => t.netReturn);
  const candidateGross = candidates.map((c) => c.grossReturn);
  const signalPl = candidates.map((c) => c.sectorPl).filter(finite);
  const plAvailable = signalPl.length;
  const slotEarned = candidates.filter((c) => finite(c.sectorPl) && c.sectorPl < 80).length;
  const avgCashWeight = average(points.map((p) => p.cashWeight));
  return {
    model,
    market,
    fold,
    candidateSignals: candidates.length,
    trades: simulation.trades.length,
    plCoverageRate: candidates.length ? round((plAvailable / candidates.length) * 100) : null,
    slotEarnRate: candidates.length ? round((slotEarned / candidates.length) * 100) : null,
    avgSignalPl: round(average(signalPl)),
    candidateAvgGrossReturn: round(average(candidateGross)),
    candidateMedianGrossReturn: round(median(candidateGross)),
    candidateWinRate: candidateGross.length
      ? round((candidateGross.filter((x) => x > 0).length / candidateGross.length) * 100)
      : null,
    totalReturn: round(totalReturn),
    benchmarkReturn: round(benchmark),
    excessReturn:
      finite(totalReturn) && finite(benchmark) ? round(totalReturn - benchmark) : null,
    cagr: round(cagr),
    mdd: points.length ? round(Math.min(...points.map((p) => p.drawdown))) : null,
    avgTradeReturn: round(average(returns)),
    medianTradeReturn: round(median(returns)),
    winRate: returns.length
      ? round((returns.filter((x) => x > 0).length / returns.length) * 100)
      : null,
    profitFactor: round(profitFactor(returns)),
    avgHoldingDays: round(average(simulation.trades.map((t) => t.holdingDays))),
    avgCapitalOccupancy: finite(avgCashWeight) ? round(100 - avgCashWeight) : null,
    skippedForCapacity: simulation.skippedForCapacity,
    totalFees: round(simulation.totalFees, 2) ?? 0,
  };
}

function aggregate(rows: FoldRow[]) {
  const out = [];
  for (const model of MODELS) {
    for (const market of ["KOSPI", "KOSDAQ"] as const) {
      const selected = rows.filter((r) => r.model === model.id && r.market === market);
      const avg = (pick: (r: FoldRow) => number | null) =>
        round(average(selected.map(pick).filter(finite)));
      out.push({
        model: model.id,
        label: model.label,
        market,
        folds: selected.length,
        foldsPositiveReturn: selected.filter((r) => finite(r.totalReturn) && r.totalReturn > 0)
          .length,
        foldsPositiveExcess: selected.filter((r) => finite(r.excessReturn) && r.excessReturn > 0)
          .length,
        avgTotalReturn: avg((r) => r.totalReturn),
        avgExcessReturn: avg((r) => r.excessReturn),
        avgCagr: avg((r) => r.cagr),
        avgMdd: avg((r) => r.mdd),
        worstFoldMdd: selected.length
          ? round(Math.min(...selected.map((r) => r.mdd).filter(finite)))
          : null,
        avgTradeReturn: avg((r) => r.avgTradeReturn),
        avgMedianTradeReturn: avg((r) => r.medianTradeReturn),
        avgWinRate: avg((r) => r.winRate),
        avgProfitFactor: avg((r) => r.profitFactor),
        avgHoldingDays: avg((r) => r.avgHoldingDays),
        avgCapitalOccupancy: avg((r) => r.avgCapitalOccupancy),
        avgCandidateSignals: round(average(selected.map((r) => r.candidateSignals))),
        avgTrades: round(average(selected.map((r) => r.trades))),
        avgPlCoverageRate: avg((r) => r.plCoverageRate),
        avgSlotEarnRate: avg((r) => r.slotEarnRate),
        avgCandidateGrossReturn: avg((r) => r.candidateAvgGrossReturn),
        avgCandidateMedianGrossReturn: avg((r) => r.candidateMedianGrossReturn),
        avgCandidateWinRate: avg((r) => r.candidateWinRate),
        totalCapacitySkips: selected.reduce((sum, r) => sum + r.skippedForCapacity, 0),
      });
    }
  }
  return out;
}

function deltaVsA(aggregateRows: ReturnType<typeof aggregate>) {
  const out = [];
  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    const base = aggregateRows.find((r) => r.model === "A_STOCK_PL" && r.market === market);
    if (!base) continue;
    for (const model of ["B_ETF_PL", "C_HYBRID_PL", "D_ETF_PRIMARY_FALLBACK"] as const) {
      const row = aggregateRows.find((r) => r.model === model && r.market === market);
      if (!row) continue;
      const d = (a: number | null, b: number | null) =>
        finite(a) && finite(b) ? round(a - b) : null;
      out.push({
        model,
        market,
        avgTotalReturnDeltaPp: d(row.avgTotalReturn, base.avgTotalReturn),
        avgExcessReturnDeltaPp: d(row.avgExcessReturn, base.avgExcessReturn),
        avgCagrDeltaPp: d(row.avgCagr, base.avgCagr),
        avgMddDeltaPp: d(row.avgMdd, base.avgMdd),
        avgTradeReturnDeltaPp: d(row.avgTradeReturn, base.avgTradeReturn),
        avgProfitFactorDelta: d(row.avgProfitFactor, base.avgProfitFactor),
        avgSlotEarnRateDeltaPp: d(row.avgSlotEarnRate, base.avgSlotEarnRate),
      });
    }
  }
  return out;
}

function sourceCoverage(dataset: MarketDataset, etfMap: Map<string, number>, stockMap: Map<string, number>) {
  const allEtfs = dataset.instruments.filter((i) => i.instrumentType === "ETF");
  const eligibleEtfs = allEtfs.filter(
    (i) =>
      i.sectorCode !== "MARKET_IDX" &&
      i.sectorCode !== "ETC" &&
      (dataset.bars[i.symbol]?.length ?? 0) >= 130,
  );
  const eligibleBySector = new Map<string, number>();
  for (const i of eligibleEtfs)
    eligibleBySector.set(i.sectorCode, (eligibleBySector.get(i.sectorCode) ?? 0) + 1);
  const allBySector = new Map<string, number>();
  for (const i of allEtfs)
    allBySector.set(i.sectorCode, (allBySector.get(i.sectorCode) ?? 0) + 1);

  const oldestObservedEtfsBySector = [...new Set(allEtfs.map((i) => i.sectorCode))]
    .sort()
    .map((sectorCode) => ({
      sectorCode,
      top5: allEtfs
        .filter((i) => i.sectorCode === sectorCode)
        .map((i) => {
          const bars = dataset.bars[i.symbol] ?? [];
          return {
            symbol: i.symbol,
            name: i.name,
            firstObservedDate: bars[0]?.tradeDate ?? null,
            lastObservedDate: bars.at(-1)?.tradeDate ?? null,
            observedBars: bars.length,
          };
        })
        .sort(
          (a, b) =>
            String(a.firstObservedDate ?? "9999-99-99").localeCompare(
              String(b.firstObservedDate ?? "9999-99-99"),
            ) || b.observedBars - a.observedBars || a.symbol.localeCompare(b.symbol),
        )
        .slice(0, 5),
    }));

  return {
    stockInstruments: dataset.instruments.filter((i) => i.instrumentType === "STOCK").length,
    etfInstruments: allEtfs.length,
    allEtfsBySector: [...allBySector.entries()]
      .map(([sectorCode, count]) => ({ sectorCode, count }))
      .sort((a, b) => b.count - a.count || a.sectorCode.localeCompare(b.sectorCode)),
    eligibleEtfsForPl: eligibleEtfs.length,
    eligibleEtfSectors: eligibleBySector.size,
    eligibleEtfsBySector: [...eligibleBySector.entries()]
      .map(([sectorCode, count]) => ({ sectorCode, count }))
      .sort((a, b) => b.count - a.count || a.sectorCode.localeCompare(b.sectorCode)),
    oldestObservedEtfsBySector,
    stockPlDateSectorPoints: stockMap.size,
    etfPlDateSectorPoints: etfMap.size,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(
    options.sourceManifest,
    options.sourceCacheDir,
  );
  const etfSource = await loadEtfCachedText(
    options.etfSourceManifest,
    options.etfSourceCacheDir,
  );
  // Canonical ETF history comes first so its rows are authoritative on overlapping
  // (symbol, date) observations; the stock-core sources then fill stocks, indexes,
  // and any non-overlapping ETF history.
  const parsed = parseManualMarketData([etfSource.text, ...texts]);
  const dataset = parsed.dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);

  const stockPl = context.sectorPriceLeadershipByDate;
  const etfPl = buildPriceLeadershipMap(dataset, "ETF");
  const hybridPl = hybridMap(stockPl, etfPl);
  const etfPrimaryFallbackPl = etfPrimaryFallbackMap(stockPl, etfPl);
  const maps: Record<ModelId, Map<string, number>> = {
    A_STOCK_PL: stockPl,
    B_ETF_PL: etfPl,
    C_HYBRID_PL: hybridPl,
    D_ETF_PRIMARY_FALLBACK: etfPrimaryFallbackPl,
  };

  const foldRows: FoldRow[] = [];
  const signalDiagnostics = [];
  for (const model of MODELS) {
    const modelSeries = attachPl(context.series, maps[model.id]);
    for (const market of ["KOSPI", "KOSDAQ"] as const) {
      for (const fold of FOLD_YEARS) {
        const candidates = buildCandidates(modelSeries, market, fold);
        const dates = evaluationDates(dataset, market, fold);
        const lastExit = candidates.reduce(
          (max, item) => (item.exitDate > max ? item.exitDate : max),
          "",
        );
        if (lastExit && dates.at(-1) && lastExit > dates.at(-1)!) {
          throw new Error(
            `Evaluation calendar too short for ${model.id} ${market} ${fold}: ${lastExit} > ${dates.at(-1)}`,
          );
        }
        const simulation = simulate(modelSeries, candidates, dates);
        foldRows.push(foldRow(model.id, market, fold, dataset, candidates, simulation));
        signalDiagnostics.push({
          model: model.id,
          market,
          fold,
          candidates: candidates.length,
          plAvailable: candidates.filter((c) => finite(c.sectorPl)).length,
          plMissing: candidates.filter((c) => !finite(c.sectorPl)).length,
          slotEarned: candidates.filter((c) => finite(c.sectorPl) && c.sectorPl < 80).length,
          overheated: candidates.filter((c) => finite(c.sectorPl) && c.sectorPl >= 80).length,
        });
      }
    }
  }

  const aggregateRows = aggregate(foldRows);
  const createdAt = new Date().toISOString();
  const runId = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const result = {
    version: STUDY_VERSION,
    createdAt,
    runId,
    data: {
      datasetVersion: dataset.version,
      asOfDate: dataset.asOfDate,
      stockSourceCacheKey: manifest.cacheKey,
      stockSourceFiles: manifest.fileCount,
      stockSourceBytes: manifest.totalBytes,
      etfSourceCacheKey: etfSource.manifest.cacheKey,
      etfSourceFilename: etfSource.manifest.sourceFilename,
      etfSourceLogicalFileHash: etfSource.manifest.logicalFileHash,
      etfSourceLogicalBytes: etfSource.manifest.logicalSizeBytes,
      parsedStats: parsed.stats,
      selectedStockSeries: context.symbolCount,
    },
    design: {
      models: MODELS,
      folds: [...FOLD_YEARS],
      plFormula:
        "Same V8 PL formula: RS20 20% + RS60 20% + RS120 10% + trend 15% + breadth 20% + near-high 10% + relative-turnover 5%.",
      hybridFormula:
        "Arithmetic mean of independently normalized Stock PL and ETF PL when both exist; otherwise use the available side.",
      etfPrimaryFallbackFormula:
        "Use independently normalized ETF PL whenever it exists for date-sector; otherwise use Stock PL. This preserves PL coverage while isolating the value of ETF PL from missing-data filtering.",
      excludedPlSectors: ["MARKET_IDX", "ETC"],
      scoreRule:
        "Base 9.5 + 0.5 only when selected PL exists and is <80. PL>=80 or missing earns 0 sector slot.",
      entry: "8.0 onset, NEXT_OPEN",
      kospiExit: "UP 9.5 crossing or DOWN 2.5 crossing at NEXT_OPEN; max 60D SAME_DAY_CLOSE",
      kosdaqExit: "UP 9.0 crossing or DOWN 3.0 crossing at NEXT_OPEN; max 60D SAME_DAY_CLOSE",
      portfolio: "P10: max 10 positions, 10% target slot, fractional shares, no rebalancing",
      evaluationCalendar:
        "For each market/fold, all models use the same calendar: first trading day of the fold year through 65 market trading days after the last fold-year trading day.",
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      initialCapital: INITIAL_CAPITAL,
    },
    coverage: sourceCoverage(dataset, etfPl, stockPl),
    signalDiagnostics,
    aggregateRows,
    deltaVsA: deltaVsA(aggregateRows),
    foldRows,
    notes: [
      "A uses the existing V8 Stock PL map produced by buildPortfolioSignalContext, so the baseline is frozen to current engine behavior.",
      "B changes only the PL source universe to mapped ETFs; stock base scores and all entry/exit/portfolio rules remain unchanged.",
      "C blends independently normalized Stock PL and ETF PL 50:50 instead of pooling raw constituents, preventing sectors with many ETFs from receiving a mechanical constituent-count advantage.",
      "D uses ETF PL whenever available and falls back to Stock PL only when ETF PL is missing, preserving 100% PL coverage while isolating ETF PL information value.",
      "ETF PL requires at least 130 bars and excludes MARKET_IDX/ETC. In B, missing ETF PL does not receive the 0.5 sector slot; in D, Stock PL supplies the fallback.",
      "The separate canonical ETF history is parsed before stock-core inputs so overlapping ETF (symbol,date) rows use the verified canonical ETF copy; non-overlapping stock-core data are still retained.",
      "All four models use an identical market/fold evaluation calendar, so benchmark return and CAGR periods are directly comparable.",
      "Candidate gross-return diagnostics are reported separately from the P10 portfolio to distinguish signal-set quality from capacity/priority effects.",
      "The study is intentionally limited to the established 3-FOS years 2018/2022/2025 to keep comparability with prior V8 validation.",
    ],
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    "v8-etf-pl-model-comparison-3fos-expanded-" + runId + ".json",
  );
  await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath =
      options.userId + "/results/v8-etf-pl-model-comparison-3fos-expanded/" + runId + ".json";
    await uploadJson(client, remotePath, result);
    await uploadJson(
      client,
      options.userId + "/results/v8-etf-pl-model-comparison-3fos-expanded/latest.json",
      {
        version: STUDY_VERSION,
        createdAt,
        runId,
        resultPath: remotePath,
        coverage: result.coverage,
        aggregateRows,
        deltaVsA: result.deltaVsA,
      },
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        outputPath,
        remotePath,
        coverage: result.coverage,
        aggregateRows,
        deltaVsA: result.deltaVsA,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? error.stack ?? error.message : String(error)) + "\n",
  );
  process.exitCode = 1;
});
