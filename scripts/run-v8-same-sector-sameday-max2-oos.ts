import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData, realizedVolatilitySeries } from "../src/lib/engine/manualDataset";
import { computeIndicators } from "../src/lib/engine/indicators";
import {
  buildPortfolioSignalContext,
  type PortfolioSeries,
} from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { DailyPrice, Instrument } from "../src/lib/engine/types";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8 Same-Sector Same-Day Max2 Full OOS" as const;
// 130-bar ETF PL warm-up begins in 2016-07 data, so 2017 is only partially warm.
// 2018 is the first full calendar year with the intended ETF PL lookback available.
// 2026 is excluded because the source ends 2026-09-18 and is not a complete OOS year.
const FOLD_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] as const;
const LIMIT = 613;
const INITIAL_CAPITAL = 100_000_000;
const ROUND_TRIP_COST_BPS = 30;
const ENTRY_THRESHOLD = 8;
const STOCK_FALLBACK_THRESHOLD = 80;
const ETF_THRESHOLDS = [] as const;
const SECTOR_SLOT = 0.5;
const MAX_POSITIONS = 30;

type FoldYear = (typeof FOLD_YEARS)[number];
type Market = "KOSPI" | "KOSDAQ";
type MarketRegime = "RISK_ON" | "NEUTRAL" | "RISK_OFF";
type SameSectorSameDayPolicy = "BASELINE" | "MAX2";
type ModelId = "A_STOCK_PL" | "FINAL_MARKET_SPECIFIC";

interface ModelDef {
  id: ModelId;
  label: string;
  description: string;
  etfThreshold: number | null;
}

const MODELS: ModelDef[] = [
  { id: "A_STOCK_PL", label: "A. Existing V8", description: "Stock PL only, threshold 80", etfThreshold: null },
  { id: "FINAL_MARKET_SPECIFIC", label: "Finalist. Market-specific ETF PL", description: "KOSPI ETF PL 84; KOSDAQ ETF PL 85; Stock fallback 80", etfThreshold: null },
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
  plSource: "ETF" | "STOCK" | null;
  signalTradingValue: number;
  grossReturn: number;
  overshoot: boolean;
  regime: MarketRegime;
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
  skippedForSector: number;
  skippedForSameSectorSameDay: number;
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
  sharpe: number | null;
  mdd: number | null;
  avgTradeReturn: number | null;
  medianTradeReturn: number | null;
  winRate: number | null;
  profitFactor: number | null;
  avgHoldingDays: number | null;
  avgCapitalOccupancy: number | null;
  skippedForCapacity: number;
  skippedForSector: number;
  skippedForSameSectorSameDay: number;
  totalFees: number;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node scripts/run-v8-etf-pl-market-specific-finalist-oos.ts --source-manifest <path> --source-cache-dir <dir> --etf-source-manifest <path> --etf-source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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

interface SelectedPl {
  value: number | null;
  source: "ETF" | "STOCK" | null;
  threshold: number | null;
}

function selectedPlAt(
  series: PortfolioSeries,
  index: number,
  stockPl: Map<string, number>,
  etfPl: Map<string, number>,
  etfThreshold: number | null,
): SelectedPl {
  const bar = series.bars[index];
  if (!bar) return { value: null, source: null, threshold: null };
  const mapKey = bar.tradeDate + "|" + series.sectorCode;
  if (etfThreshold !== null) {
    const etfValue = etfPl.get(mapKey);
    if (finite(etfValue)) return { value: etfValue, source: "ETF", threshold: etfThreshold };
  }
  const stockValue = stockPl.get(mapKey);
  if (finite(stockValue))
    return { value: stockValue, source: "STOCK", threshold: STOCK_FALLBACK_THRESHOLD };
  return { value: null, source: null, threshold: null };
}

function adjustedScoreAt(
  series: PortfolioSeries,
  index: number,
  stockPl: Map<string, number>,
  etfPl: Map<string, number>,
  etfThreshold: number | null,
) {
  const base = series.baseScores[index];
  if (!finite(base)) return null;
  const selected = selectedPlAt(series, index, stockPl, etfPl, etfThreshold);
  const contribution =
    finite(selected.value) && finite(selected.threshold) && selected.value < selected.threshold
      ? SECTOR_SLOT
      : 0;
  return Math.min(10, Math.max(0, Math.round((base + contribution) * 100) / 100));
}
function crossedUp(prev: number | null, cur: number | null, threshold: number) {
  return finite(prev) && finite(cur) && prev < threshold && cur >= threshold;
}
function crossedDown(prev: number | null, cur: number | null, threshold: number) {
  return finite(prev) && finite(cur) && prev > threshold && cur <= threshold;
}
function scoreRise(
  series: PortfolioSeries,
  index: number,
  stockPl: Map<string, number>,
  etfPl: Map<string, number>,
  etfThreshold: number | null,
) {
  const cur = adjustedScoreAt(series, index, stockPl, etfPl, etfThreshold);
  const prev = adjustedScoreAt(series, index - 5, stockPl, etfPl, etfThreshold);
  return finite(cur) && finite(prev) ? (cur - prev) * 10 : null;
}


function buildMarketRegimeByDate(dataset: MarketDataset) {
  const kospi = dataset.indexSeries.find((series) => series.indexCode === "KOSPI");
  const kosdaq = dataset.indexSeries.find((series) => series.indexCode === "KOSDAQ");
  if (!kospi) throw new Error("KOSPI index is required for historical market regimes.");

  const kospiVol = realizedVolatilitySeries(kospi.bars.map((bar) => bar.close));
  const kosdaqVol = kosdaq ? realizedVolatilitySeries(kosdaq.bars.map((bar) => bar.close)) : [];
  const kosdaqVolByDate = new Map<string, number>();
  if (kosdaq) {
    kosdaq.bars.forEach((bar, index) => {
      const value = kosdaqVol[index];
      if (finite(value)) kosdaqVolByDate.set(bar.tradeDate, value);
    });
  }

  const fallbackForeignByDate = new Map<string, number>();
  const fallbackForeignCountByDate = new Map<string, number>();
  for (const instrument of dataset.instruments) {
    for (const bar of dataset.bars[instrument.symbol] ?? []) {
      if (!finite(bar.foreignNetBuyValue)) continue;
      fallbackForeignByDate.set(
        bar.tradeDate,
        (fallbackForeignByDate.get(bar.tradeDate) ?? 0) + bar.foreignNetBuyValue,
      );
      fallbackForeignCountByDate.set(
        bar.tradeDate,
        (fallbackForeignCountByDate.get(bar.tradeDate) ?? 0) + 1,
      );
    }
  }

  const out = new Map<string, {
    status: MarketRegime;
    metCount: number;
    evaluatedCount: number;
    benchmarkAboveMa60: boolean | null;
    benchmarkAboveCloud: boolean | null;
    vkospiBelow30: boolean | null;
    foreignNet5dPositive: boolean | null;
    volatility: number | null;
    foreignNet5d: number | null;
  }>();

  for (let i = 0; i < kospi.bars.length; i++) {
    if (i < 120) continue;
    const bar = kospi.bars[i]!;
    const snap = computeIndicators(kospi.bars, i);
    const aboveMa60 = snap.ma60 !== null ? snap.close > snap.ma60 : null;
    const aboveCloud = snap.ichimoku.cloudTop !== null ? snap.close > snap.ichimoku.cloudTop : null;
    const kVol = kospiVol[i];
    const qVol = kosdaqVolByDate.get(bar.tradeDate);
    const volatility =
      finite(kVol) && finite(qVol) ? 0.7 * kVol + 0.3 * qVol : finite(kVol) ? kVol : null;
    const vk = finite(volatility) ? volatility < 30 : null;

    const window = kospi.bars.slice(Math.max(0, i - 4), i + 1);
    let foreignNet5d: number | null = null;
    if (window.length === 5 && window.every((item) => finite(item.foreignNetBuyValue))) {
      foreignNet5d = window.reduce((sum, item) => sum + (item.foreignNetBuyValue ?? 0), 0);
    } else {
      let sum = 0;
      let contributing = 0;
      for (const item of window) {
        if ((fallbackForeignCountByDate.get(item.tradeDate) ?? 0) > 0) {
          sum += fallbackForeignByDate.get(item.tradeDate) ?? 0;
          contributing++;
        }
      }
      foreignNet5d = contributing > 0 ? sum : null;
    }
    const fr = foreignNet5d !== null ? foreignNet5d > 0 : null;
    const flags = [aboveMa60, aboveCloud, vk, fr];
    const evaluatedCount = flags.filter((flag) => flag !== null).length;
    const metCount = flags.filter((flag) => flag === true).length;
    const status: MarketRegime =
      metCount >= 4 ? "RISK_ON" : metCount >= 2 ? "NEUTRAL" : "RISK_OFF";
    out.set(bar.tradeDate, {
      status,
      metCount,
      evaluatedCount,
      benchmarkAboveMa60: aboveMa60,
      benchmarkAboveCloud: aboveCloud,
      vkospiBelow30: vk,
      foreignNet5dPositive: fr,
      volatility,
      foreignNet5d,
    });
  }
  return out;
}


const SECTOR_SCHEMES = [
  { id: "CURRENT_30", kospi: 0.30, kosdaq: 0.30 },
  { id: "MARKET_SPECIFIC_10_20", kospi: 0.10, kosdaq: 0.20 },
] as const;

function sectorCapFor(
  scheme: (typeof SECTOR_SCHEMES)[number],
  market: Market,
) {
  return market === "KOSPI" ? scheme.kospi : scheme.kosdaq;
}

function buildCandidates(
  series: PortfolioSeries[],
  market: Market,
  fold: FoldYear,
  stockPl: Map<string, number>,
  etfPl: Map<string, number>,
  etfThreshold: number | null,
  up: number,
  down: number | null,
  regimeByDate: ReturnType<typeof buildMarketRegimeByDate>,
) {
  const out: Candidate[] = [];
  const maxHolding = 60;
  for (const s of series) {
    if (s.market !== market) continue;
    for (let i = 120; i + 1 < s.bars.length; i++) {
      if (Number(s.bars[i]!.tradeDate.slice(0, 4)) !== fold) continue;
      const prevScore = adjustedScoreAt(s, i - 1, stockPl, etfPl, etfThreshold);
      const score = adjustedScoreAt(s, i, stockPl, etfPl, etfThreshold);
      if (!crossedUp(prevScore, score, ENTRY_THRESHOLD)) continue;
      const overshoot = finite(score) && score >= up;
      const regime = regimeByDate.get(s.bars[i]!.tradeDate)?.status ?? "RISK_OFF";
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
        // Entry-day overshoot is intentionally not an immediate exit. Exit crossings are
        // evaluated only after the position has been established, matching production.
        if (j > entryIndex) {
          const si = j - 1;
          const p = adjustedScoreAt(s, si - 1, stockPl, etfPl, etfThreshold);
          const cur = adjustedScoreAt(s, si, stockPl, etfPl, etfThreshold);
          if (finite(down) && crossedDown(p, cur, down)) {
            exitIndex = j;
            exitPrice = bar.open;
            exitTiming = "OPEN";
            exitReason = "DOWN";
            break;
          }
          if (crossedUp(p, cur, up)) {
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
      const selectedPl = selectedPlAt(s, i, stockPl, etfPl, etfThreshold);
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
        scoreRise5d: scoreRise(s, i, stockPl, etfPl, etfThreshold),
        sectorPl: selectedPl.value,
        plSource: selectedPl.source,
        signalTradingValue: s.bars[i]?.tradingValue ?? 0,
        grossReturn: (exitPrice / entry.open - 1) * 100,
        overshoot,
        regime,
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
  sectorCap: number,
  sameSectorSameDayPolicy: SameSectorSameDayPolicy,
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
  let skippedForSector = 0;
  let skippedForSameSectorSameDay = 0;

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
    const acceptedTodayBySector = new Map<string, number>();
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
      if (
        sameSectorSameDayPolicy === "MAX2" &&
        (acceptedTodayBySector.get(candidate.sectorCode) ?? 0) >= 2
      ) {
        skippedForSameSectorSameDay++;
        continue;
      }
      if (sectorCap < 1) {
        const sectorValue = [...positions.values()]
          .filter((position) => position.candidate.sectorCode === candidate.sectorCode)
          .reduce((sum, position) => sum + position.shares * position.lastMark, 0);
        if (sectorValue + entryNotional > openEquity * sectorCap + 1) {
          skippedForSector++;
          continue;
        }
      }
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
      acceptedTodayBySector.set(
        candidate.sectorCode,
        (acceptedTodayBySector.get(candidate.sectorCode) ?? 0) + 1,
      );
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
    skippedForSector,
    skippedForSameSectorSameDay,
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

function sharpeFromPoints(points: EquityPoint[]) {
  if (points.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!.equity;
    const cur = points[i]!.equity;
    if (prev > 0 && finite(prev) && finite(cur)) returns.push(cur / prev - 1);
  }
  if (returns.length < 2) return null;
  const mean = average(returns);
  if (!finite(mean)) return null;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? (mean / sd) * Math.sqrt(252) : null;
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
  const slotEarned = candidates.filter((c) => {
    if (!finite(c.sectorPl)) return false;
    const threshold =
      c.plSource === "ETF"
        ? model === "FINAL_MARKET_SPECIFIC"
          ? market === "KOSPI"
            ? 84
            : 85
          : null
        : STOCK_FALLBACK_THRESHOLD;
    return finite(threshold) && c.sectorPl < threshold;
  }).length;
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
    sharpe: round(sharpeFromPoints(points)),
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
    skippedForSector: simulation.skippedForSector,
    skippedForSameSectorSameDay: simulation.skippedForSameSectorSameDay,
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

function buildRobustness(rows: FoldRow[]) {
  const out = [];
  for (const market of ["KOSPI","KOSDAQ"] as const) {
    const base = rows.filter(r=>r.model==="A_STOCK_PL" && r.market===market).sort((a,b)=>a.fold-b.fold);
    const fin = rows.filter(r=>r.model==="FINAL_MARKET_SPECIFIC" && r.market===market).sort((a,b)=>a.fold-b.fold);
    const pairs = base.map((a,i)=>({fold:a.fold, base:a.totalReturn!, finalist:fin[i]!.totalReturn!, delta:fin[i]!.totalReturn!-a.totalReturn!}));
    const deltas=pairs.map(x=>x.delta).sort((a,b)=>a-b);
    const trim=(xs:number[])=>xs.length>2?xs.slice(1,-1):xs;
    const wins=pairs.filter(x=>x.delta>0).length, losses=pairs.filter(x=>x.delta<0).length;
    out.push({market,pairs,wins,losses,ties:pairs.length-wins-losses,
      medianAnnualDeltaPp:round(median(deltas)), trimmedMeanAnnualDeltaPp:round(average(trim(deltas))),
      worstAnnualDeltaPp:round(Math.min(...deltas)), bestAnnualDeltaPp:round(Math.max(...deltas)),
      positiveDeltaYears:pairs.filter(x=>x.delta>0).map(x=>x.fold),
      negativeDeltaYears:pairs.filter(x=>x.delta<0).map(x=>x.fold)});
  }
  return out;
}

function deltaVsA(aggregateRows: ReturnType<typeof aggregate>) {
  const out = [];
  for (const market of ["KOSPI", "KOSDAQ"] as const) {
    const base = aggregateRows.find((r) => r.model === "A_STOCK_PL" && r.market === market);
    if (!base) continue;
    for (const model of MODELS.map((item) => item.id).filter((id) => id !== "A_STOCK_PL")) {
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


  const strategies = [
    {
      market: "KOSPI" as const,
      id: "KOSPI-E8-U9.5-DX-H60",
      up: 9.5,
      down: null,
      etfThreshold: 84,
      plPolicy: "ETF PL 84 primary; Stock PL 80 fallback",
    },
    {
      market: "KOSDAQ" as const,
      id: "KOSDAQ-E8-U9.0-D3.0-H60",
      up: 9.0,
      down: 3.0,
      etfThreshold: null,
      plPolicy: "Stock PL 80",
    },
  ] as const;
  const regimeByDate = buildMarketRegimeByDate(dataset);
  const modelSeries = context.series;
  const policies: SameSectorSameDayPolicy[] = ["BASELINE", "MAX2"];

  const foldRows: Array<
    FoldRow & {
      strategy: string;
      sameSectorSameDayPolicy: SameSectorSameDayPolicy;
      sectorScheme: string;
      sectorCap: number;
      totalOnsetSignals: number;
      sameDaySameSector3PlusSignals: number;
    }
  > = [];

  const clusterDiagnostics: Array<{
    strategy: string;
    market: Market;
    fold: FoldYear;
    clusterCount: number;
    signalsInClusters: number;
    excessSignalsBeyondMax2: number;
  }> = [];

  for (const strategy of strategies) {
    for (const fold of FOLD_YEARS) {
      const allCandidates = buildCandidates(
        modelSeries,
        strategy.market,
        fold,
        stockPl,
        etfPl,
        strategy.etfThreshold,
        strategy.up,
        strategy.down,
        regimeByDate,
      );

      const clusterMap = new Map<string, Candidate[]>();
      for (const candidate of allCandidates) {
        const clusterKey = candidate.signalDate + "|" + candidate.sectorCode;
        const list = clusterMap.get(clusterKey) ?? [];
        list.push(candidate);
        clusterMap.set(clusterKey, list);
      }
      const clusters = [...clusterMap.values()].filter((items) => items.length >= 3);
      clusterDiagnostics.push({
        strategy: strategy.id,
        market: strategy.market,
        fold,
        clusterCount: clusters.length,
        signalsInClusters: clusters.reduce((sum, items) => sum + items.length, 0),
        excessSignalsBeyondMax2: clusters.reduce((sum, items) => sum + Math.max(0, items.length - 2), 0),
      });

      const dates = evaluationDates(dataset, strategy.market, fold);
      for (const sectorScheme of SECTOR_SCHEMES) {
        const sectorCap = sectorCapFor(sectorScheme, strategy.market);
        for (const policy of policies) {
          const simulation = simulate(modelSeries, allCandidates, dates, sectorCap, policy);
          foldRows.push({
            ...foldRow(
              "FINAL_MARKET_SPECIFIC",
              strategy.market,
              fold,
              dataset,
              allCandidates,
              simulation,
            ),
            strategy: strategy.id,
            sameSectorSameDayPolicy: policy,
            sectorScheme: sectorScheme.id,
            sectorCap,
            totalOnsetSignals: allCandidates.length,
            sameDaySameSector3PlusSignals: clusters.reduce((sum, items) => sum + items.length, 0),
          });
        }
      }
    }
  }

  function summarizeRows(selected: typeof foldRows) {
    const avg = (pick: (row: (typeof selected)[number]) => number | null) =>
      round(average(selected.map(pick).filter(finite)));
    return {
      folds: selected.length,
      avgTotalReturn: avg((row) => row.totalReturn),
      avgExcessReturn: avg((row) => row.excessReturn),
      avgCagr: avg((row) => row.cagr),
      avgSharpe: avg((row) => row.sharpe),
      avgMdd: avg((row) => row.mdd),
      worstFoldMdd: selected.length
        ? round(Math.min(...selected.map((row) => row.mdd).filter(finite)))
        : null,
      avgTradeReturn: avg((row) => row.avgTradeReturn),
      avgMedianTradeReturn: avg((row) => row.medianTradeReturn),
      avgWinRate: avg((row) => row.winRate),
      avgProfitFactor: avg((row) => row.profitFactor),
      avgCapitalOccupancy: avg((row) => row.avgCapitalOccupancy),
      foldsPositiveReturn: selected.filter((row) => finite(row.totalReturn) && row.totalReturn > 0).length,
      foldsPositiveExcess: selected.filter((row) => finite(row.excessReturn) && row.excessReturn > 0).length,
      totalTrades: selected.reduce((sum, row) => sum + row.trades, 0),
      totalSectorSkips: selected.reduce((sum, row) => sum + row.skippedForSector, 0),
      totalCapacitySkips: selected.reduce((sum, row) => sum + row.skippedForCapacity, 0),
      totalMax2Skips: selected.reduce((sum, row) => sum + row.skippedForSameSectorSameDay, 0),
    };
  }

  const aggregateRows = strategies.flatMap((strategy) =>
    SECTOR_SCHEMES.flatMap((sectorScheme) =>
      policies.map((policy) => {
        const selected = foldRows.filter(
          (row) =>
            row.strategy === strategy.id &&
            row.sectorScheme === sectorScheme.id &&
            row.sameSectorSameDayPolicy === policy,
        );
        return {
          strategy: strategy.id,
          market: strategy.market,
          sectorScheme: sectorScheme.id,
          sectorCap: sectorCapFor(sectorScheme, strategy.market),
          sameSectorSameDayPolicy: policy,
          with2025: summarizeRows(selected),
          without2025: summarizeRows(selected.filter((row) => row.fold !== 2025)),
        };
      }),
    ),
  );

  const comparisonRows = strategies.flatMap((strategy) =>
    SECTOR_SCHEMES.map((sectorScheme) => {
      const baseline = aggregateRows.find(
        (row) =>
          row.strategy === strategy.id &&
          row.sectorScheme === sectorScheme.id &&
          row.sameSectorSameDayPolicy === "BASELINE",
      )!;
      const max2 = aggregateRows.find(
        (row) =>
          row.strategy === strategy.id &&
          row.sectorScheme === sectorScheme.id &&
          row.sameSectorSameDayPolicy === "MAX2",
      )!;
      const delta = (
        a: ReturnType<typeof summarizeRows>,
        b: ReturnType<typeof summarizeRows>,
      ) => {
        const d = (x: number | null, y: number | null) =>
          finite(x) && finite(y) ? round(y - x) : null;
        return {
          totalReturnDeltaPp: d(a.avgTotalReturn, b.avgTotalReturn),
          excessReturnDeltaPp: d(a.avgExcessReturn, b.avgExcessReturn),
          cagrDeltaPp: d(a.avgCagr, b.avgCagr),
          sharpeDelta: d(a.avgSharpe, b.avgSharpe),
          avgMddDeltaPp: d(a.avgMdd, b.avgMdd),
          worstMddDeltaPp: d(a.worstFoldMdd, b.worstFoldMdd),
          tradeReturnDeltaPp: d(a.avgTradeReturn, b.avgTradeReturn),
          winRateDeltaPp: d(a.avgWinRate, b.avgWinRate),
          profitFactorDelta: d(a.avgProfitFactor, b.avgProfitFactor),
          tradeCountDelta: b.totalTrades - a.totalTrades,
          max2Skips: b.totalMax2Skips,
        };
      };
      return {
        strategy: strategy.id,
        market: strategy.market,
        sectorScheme: sectorScheme.id,
        sectorCap: sectorCapFor(sectorScheme, strategy.market),
        comparison: "MAX2_MINUS_BASELINE",
        with2025: delta(baseline.with2025, max2.with2025),
        without2025: delta(baseline.without2025, max2.without2025),
      };
    }),
  );

  const yearlyDeltaRows = foldRows
    .filter((row) => row.sameSectorSameDayPolicy === "MAX2")
    .map((max2) => {
      const baseline = foldRows.find(
        (row) =>
          row.strategy === max2.strategy &&
          row.fold === max2.fold &&
          row.sectorScheme === max2.sectorScheme &&
          row.sameSectorSameDayPolicy === "BASELINE",
      )!;
      return {
        strategy: max2.strategy,
        market: max2.market,
        sectorScheme: max2.sectorScheme,
        fold: max2.fold,
        totalReturnDeltaPp:
          finite(max2.totalReturn) && finite(baseline.totalReturn)
            ? round(max2.totalReturn - baseline.totalReturn)
            : null,
        sharpeDelta:
          finite(max2.sharpe) && finite(baseline.sharpe)
            ? round(max2.sharpe - baseline.sharpe)
            : null,
        mddDeltaPp:
          finite(max2.mdd) && finite(baseline.mdd)
            ? round(max2.mdd - baseline.mdd)
            : null,
        max2Skips: max2.skippedForSameSectorSameDay,
      };
    });

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
      etfSymbols: dataset.instruments
        .filter((instrument) => instrument.instrumentType === "ETF")
        .map((instrument) => instrument.symbol)
        .sort(),
    },
    design: {
      strategies,
      sameSectorSameDayPolicies: policies,
      sectorSchemes: SECTOR_SCHEMES,
      folds: [...FOLD_YEARS],
      etfThresholdGrid: [],
      marketSpecificThresholds: { KOSPI: 84, KOSDAQ: null },
      stockFallbackThreshold: STOCK_FALLBACK_THRESHOLD,
      plFormula:
        "Same V8 PL formula: RS20 20% + RS60 20% + RS120 10% + trend 15% + breadth 20% + near-high 10% + relative-turnover 5%.",
      thresholdGridFormula:
        "Production parity: KOSPI uses ETF PL 84 primary with Stock PL 80 fallback; KOSDAQ uses Stock PL 80. OOS years 2018-2025.",
      excludedPlSectors: ["MARKET_IDX", "ETC"],
      scoreRule:
        "Base 9.5 + 0.5 only when selected PL is below its applicable threshold. ETF threshold varies by model; Stock fallback threshold remains 80. Missing PL earns 0 sector slot.",
      entry: "8.0 onset, NEXT_OPEN",
      kospiExit: "E8 / UP 9.5 crossing / downside exit OFF / max 60D",
      kosdaqExit: "UP 9.0 crossing or DOWN 3.0 crossing at NEXT_OPEN; max 60D SAME_DAY_CLOSE",
      portfolio: "P30 equal-slot portfolio. Compare BASELINE vs same-signal-day same-sector MAX2. Sector schemes: current 30% both markets and proposed KOSPI 10% / KOSDAQ 20%. Overshoot remains fully allowed."
      evaluationCalendar:
        "For each market/fold, all models use the same calendar: first trading day of the fold year through 65 market trading days after the last fold-year trading day.",
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      initialCapital: INITIAL_CAPITAL,
    },
    coverage: sourceCoverage(dataset, etfPl, stockPl),
    clusterDiagnostics,
    aggregateRows,
    comparisonRows,
    yearlyDeltaRows,
    foldRows,
    notes: [
      "One-variable operational test: BASELINE versus same-signal-day same-sector MAX2; score, exit, overshoot, fill, cost, holding and ranking rules are unchanged.",
      "MAX2 counts only entries accepted on the same entry date in the same sector. Existing sector holdings do not consume the daily MAX2 quota, but they do count toward the separate sector-cap constraint.",
      "When more than two candidates compete in the same sector on the same day, current candidate priority is used: adjusted score, 5D score rise, signal trading value, symbol.",
      "Overshoot remains fully allowed in both BASELINE and MAX2.",
      "Two sector-cap contexts are tested: current 30% for both markets, and the preceding study finalist of KOSPI 10% / KOSDAQ 20%.",
      "Final validation uses every complete annual OOS fold from 2018 through 2025; 2026 is excluded because the source year is incomplete."
    ]
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(
    outputDir,
    "v8-same-sector-sameday-max2-oos-" + runId + ".json",
  );
  await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");

  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath =
      options.userId + "/results/v8-same-sector-sameday-max2-oos/" + runId + ".json";
    await uploadJson(client, remotePath, result);
    await uploadJson(
      client,
      options.userId + "/results/v8-same-sector-sameday-max2-oos/latest.json",
      {
        version: STUDY_VERSION,
        createdAt,
        runId,
        resultPath: remotePath,
        coverage: result.coverage,
        clusterDiagnostics,
        aggregateRows,
        comparisonRows,
        yearlyDeltaRows,
      },
    );
  }

  process.stdout.write(
    JSON.stringify(
      {
        outputPath,
        remotePath,
        coverage: result.coverage,
        clusterDiagnostics,
        aggregateRows,
        comparisonRows,
        yearlyDeltaRows,
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
