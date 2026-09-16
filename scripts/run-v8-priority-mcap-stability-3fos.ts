import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import {
  buildPortfolioSignalContext,
  type PortfolioSeries,
} from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8-12 Priority MarketCap Stability 3-FOS" as const;
const FOLD_YEARS = [2018, 2022, 2025] as const;
const LIMIT = 613;
const ENTRY_THRESHOLD = 8;
const UPSIDE_EXIT = 9.5;
const DOWNSIDE_EXIT = 2.5;
const MAX_HOLDING_DAYS = 60;
const ROUND_TRIP_COST_BPS = 30;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const SECTOR_SLOT = 0.5;

type FoldYear = (typeof FOLD_YEARS)[number];

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
interface Trade {
  fold: FoldYear;
  symbol: string;
  name: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  holdingDays: number;
  exitReason: "UPSIDE_SCORE" | "DOWNSIDE_SCORE" | "TIME";
  signalScore: number;
  signalMarketCap: number | null;
  marketCapBucket: string;
  grossReturn: number;
  netReturn: number;
  mae: number;
  mfe: number;
  sectorPriceLeadership: number | null;
  supplyPenalty: 0 | -0.5 | -1;
  short20dChangePp: number | null;
  lending20dChange: number | null;
}
interface Stats {
  n: number;
  avgReturn: number | null;
  medianReturn: number | null;
  stdReturn: number | null;
  downsideDeviation: number | null;
  winRate: number | null;
  profitFactor: number | null;
  p10Return: number | null;
  cvar10: number | null;
  avgMae: number | null;
  p10Mae: number | null;
  avgMfe: number | null;
  avgHoldingDays: number | null;
}

function usage(message?: string): never {
  throw new Error([
    ...(message ? [message, ""] : []),
    "Usage:",
    "  npx vite-node scripts/run-v8-priority-mcap-stability-3fos.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
  ].join("\n"));
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
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)]! + s[Math.ceil(m)]!) / 2;
}
function percentile(xs: number[], p: number) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.max(0, Math.min(s.length - 1, Math.floor((s.length - 1) * p)));
  return s[i]!;
}
function std(xs: number[]) {
  if (xs.length < 2) return null;
  const m = avg(xs)!;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function round(v: number | null, d = 4) {
  if (!finite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function stats(trades: Trade[]): Stats {
  const r = trades.map((t) => t.netReturn).filter(Number.isFinite);
  const losses = r.filter((x) => x < 0);
  const gains = r.filter((x) => x > 0);
  const p10 = percentile(r, 0.1);
  const tail = p10 === null ? [] : r.filter((x) => x <= p10);
  const downside = r.map((x) => Math.min(0, x));
  const mae = trades.map((t) => t.mae);
  const mfe = trades.map((t) => t.mfe);
  const lossSum = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    n: trades.length,
    avgReturn: round(avg(r)),
    medianReturn: round(median(r)),
    stdReturn: round(std(r)),
    downsideDeviation: round(r.length ? Math.sqrt(downside.reduce((s, x) => s + x * x, 0) / r.length) : null),
    winRate: round(r.length ? gains.length / r.length * 100 : null),
    profitFactor: round(lossSum > 0 ? gains.reduce((a, b) => a + b, 0) / lossSum : null),
    p10Return: round(p10),
    cvar10: round(avg(tail)),
    avgMae: round(avg(mae)),
    p10Mae: round(percentile(mae, 0.1)),
    avgMfe: round(avg(mfe)),
    avgHoldingDays: round(avg(trades.map((t) => t.holdingDays)), 2),
  };
}

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
function crossedUp(prev: number | null, cur: number | null, threshold: number) {
  return finite(prev) && finite(cur) && prev < threshold && cur >= threshold;
}
function crossedDown(prev: number | null, cur: number | null, threshold: number) {
  return finite(prev) && finite(cur) && prev >= threshold && cur < threshold;
}
function marketCapBucket(cap: number | null) {
  if (!finite(cap) || cap <= 0) return "NO_DATA";
  if (cap < 300_000_000_000) return "<3,000억";
  if (cap < 500_000_000_000) return "3,000~5,000억";
  if (cap < 1_000_000_000_000) return "5,000억~1조";
  if (cap < 3_000_000_000_000) return "1~3조";
  return "3조+";
}
function diff20(values: Array<number | null | undefined>, i: number) {
  const a = values[i];
  const b = values[i - 20];
  return finite(a) && finite(b) ? a - b : null;
}
function buildTrade(series: PortfolioSeries, signalIndex: number, fold: FoldYear): Trade | null {
  const entryIndex = signalIndex + 1;
  const entry = series.bars[entryIndex];
  if (!entry || !finite(entry.open) || entry.open <= 0) return null;
  let exitIndex = -1;
  let exitPrice = 0;
  let exitReason: Trade["exitReason"] = "TIME";
  const last = Math.min(signalIndex + MAX_HOLDING_DAYS, series.bars.length - 1);
  for (let j = entryIndex; j <= last; j++) {
    const bar = series.bars[j]!;
    if (![bar.open, bar.close, bar.low, bar.high].every((v) => finite(v) && v > 0)) return null;
    if (j > entryIndex) {
      const scoreIndex = j - 1;
      const prev = adjustedScoreAt(series, scoreIndex - 1);
      const cur = adjustedScoreAt(series, scoreIndex);
      if (crossedDown(prev, cur, DOWNSIDE_EXIT)) {
        exitIndex = j; exitPrice = bar.open; exitReason = "DOWNSIDE_SCORE"; break;
      }
      if (crossedUp(prev, cur, UPSIDE_EXIT)) {
        exitIndex = j; exitPrice = bar.open; exitReason = "UPSIDE_SCORE"; break;
      }
    }
    if (j === last) { exitIndex = j; exitPrice = bar.close; exitReason = "TIME"; }
  }
  if (exitIndex < 0 || exitPrice <= 0) return null;
  const signalBar = series.bars[signalIndex]!;
  const signalScore = adjustedScoreAt(series, signalIndex);
  if (!finite(signalScore)) return null;
  const pathBars = series.bars.slice(entryIndex, exitIndex + 1);
  const mae = Math.min(...pathBars.map((b) => (b.low / entry.open - 1) * 100));
  const mfe = Math.max(...pathBars.map((b) => (b.high / entry.open - 1) * 100));
  const grossReturn = (exitPrice / entry.open - 1) * 100;
  const oneWay = ROUND_TRIP_COST_BPS / 2 / 10_000;
  const netReturn = (exitPrice * (1 - oneWay) / (entry.open * (1 + oneWay)) - 1) * 100;
  const shortValues = series.bars.map((b) => b.shortSellingVolumeRate ?? null);
  const lendValues = series.bars.map((b) => b.lendingBalanceQuantity ?? null);
  const short20dChangePp = diff20(shortValues, signalIndex);
  const lending20dChange = diff20(lendValues, signalIndex);
  const riskCount = (finite(short20dChangePp) && short20dChangePp > 0 ? 1 : 0) + (finite(lending20dChange) && lending20dChange > 0 ? 1 : 0);
  const supplyPenalty = (riskCount === 2 ? -1 : riskCount === 1 ? -0.5 : 0) as Trade["supplyPenalty"];
  const cap = signalBar.marketCap ?? null;
  return {
    fold,
    symbol: series.symbol,
    name: series.name,
    signalDate: signalBar.tradeDate,
    entryDate: entry.tradeDate,
    exitDate: series.bars[exitIndex]!.tradeDate,
    holdingDays: exitIndex - entryIndex + 1,
    exitReason,
    signalScore,
    signalMarketCap: cap,
    marketCapBucket: marketCapBucket(cap),
    grossReturn: round(grossReturn)!,
    netReturn: round(netReturn)!,
    mae: round(mae)!,
    mfe: round(mfe)!,
    sectorPriceLeadership: series.sectorPriceLeadership[signalIndex] ?? null,
    supplyPenalty,
    short20dChangePp: round(short20dChangePp),
    lending20dChange: round(lending20dChange, 0),
  };
}
function buildTrades(series: PortfolioSeries[]) {
  const trades: Trade[] = [];
  for (const item of series) {
    if (item.market !== "KOSDAQ") continue;
    for (let i = 120; i + 1 < item.bars.length; i++) {
      const year = Number(item.bars[i]!.tradeDate.slice(0, 4));
      if (!FOLD_YEARS.includes(year as FoldYear)) continue;
      if (!crossedUp(adjustedScoreAt(item, i - 1), adjustedScoreAt(item, i), ENTRY_THRESHOLD)) continue;
      const trade = buildTrade(item, i, year as FoldYear);
      if (trade) trades.push(trade);
    }
  }
  return trades;
}
function groupStats(trades: Trade[], keyFn: (t: Trade) => string) {
  const map = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = keyFn(t);
    const bucket = map.get(k) ?? [];
    bucket.push(t);
    map.set(k, bucket);
  }
  return [...map.entries()].map(([group, rows]) => ({ group, ...stats(rows) }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const headers = texts.map((t) => t.slice(0, t.indexOf("\n") >= 0 ? t.indexOf("\n") : 4000).toLowerCase());
  const historicalIndexColumns = [...new Set(headers.flatMap((h) => ["kospi200", "kosdaq150", "krx300", "indexmembership"].filter((x) => h.includes(x))))];
  const parsed = parseManualMarketData(texts);
  const dataset = parsed.dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const trades = buildTrades(context.series);

  const bucketOrder = ["<3,000억", "3,000~5,000억", "5,000억~1조", "1~3조", "3조+", "NO_DATA"];
  const pooledByCap = bucketOrder.map((bucket) => ({ bucket, ...stats(trades.filter((t) => t.marketCapBucket === bucket)) }));
  const foldByCap = FOLD_YEARS.flatMap((fold) => bucketOrder.map((bucket) => ({ fold, bucket, ...stats(trades.filter((t) => t.fold === fold && t.marketCapBucket === bucket)) })));
  const capThreshold = [
    { group: "<3,000억", ...stats(trades.filter((t) => finite(t.signalMarketCap) && t.signalMarketCap < 300_000_000_000)) },
    { group: ">=3,000억", ...stats(trades.filter((t) => finite(t.signalMarketCap) && t.signalMarketCap >= 300_000_000_000)) },
  ];
  const capFoldConsistency = bucketOrder.map((bucket) => {
    const rows = foldByCap.filter((r) => r.bucket === bucket && r.n > 0);
    const means = rows.map((r) => r.avgReturn).filter(finite);
    const stds = rows.map((r) => r.stdReturn).filter(finite);
    const p10s = rows.map((r) => r.p10Return).filter(finite);
    return {
      bucket,
      foldsWithData: rows.length,
      foldsPositiveMean: rows.filter((r) => finite(r.avgReturn) && r.avgReturn > 0).length,
      equalFoldAvgReturn: round(avg(means)),
      worstFoldAvgReturn: round(means.length ? Math.min(...means) : null),
      equalFoldAvgStd: round(avg(stds)),
      worstFoldP10: round(p10s.length ? Math.min(...p10s) : null),
    };
  });
  const supplyRisk = groupStats(trades, (t) => `${t.supplyPenalty}`);
  const supplyCoverage = {
    short20d: trades.filter((t) => t.short20dChangePp !== null).length,
    lending20d: trades.filter((t) => t.lending20dChange !== null).length,
    both: trades.filter((t) => t.short20dChangePp !== null && t.lending20dChange !== null).length,
    total: trades.length,
  };
  const indexMembership = {
    status: historicalIndexColumns.length > 0 ? "SOURCE_COLUMNS_DETECTED_BUT_NOT_VALIDATED" : "NOT_TESTABLE_NO_POINT_IN_TIME_MEMBERSHIP",
    detectedColumns: historicalIndexColumns,
    currentParserInstrumentMembershipCount: dataset.instruments.filter((i) => i.indexMemberships.length > 0).length,
    currentParserInstrumentCount: dataset.instruments.length,
    note: "현재 102컬럼 장기 원천데이터에는 KOSPI200/KOSDAQ150/KRX300 시점별 편입 플래그가 확인되지 않아 현재 편입상태를 과거에 소급하지 않았다.",
  };

  const result = {
    version: STUDY_VERSION,
    createdAt: new Date().toISOString(),
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
      universe: "현재 CloudTrend 거래대금 상위 613 종목의 과거 재현 방식",
      market: "KOSDAQ",
      entry: "V8 adjusted score 8.0 상향 Onset, 다음 거래일 시가 진입",
      exit: "score 9.5 상향 또는 2.5 하향 crossing 시 다음 거래일 시가, 그 외 최대 60D 종가",
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      marketCap: "signal-day point-in-time marketCap 사용",
      sector: "V8 기술점수 내 Sector Price Leadership 0.5 slot 유지; 우선점수 Sector Rotation은 본 분해에서 혼합하지 않음",
      supplyRisk: "진입/청산 신호에 미사용. 공매도 비중 20D 증가 -0.5, 대차잔고 20D 증가 -0.5를 별도 overlay로 기록",
    },
    tradeCount: trades.length,
    foldCounts: FOLD_YEARS.map((fold) => ({ fold, trades: trades.filter((t) => t.fold === fold).length })),
    overall: stats(trades),
    marketCap: { pooledByCap, foldByCap, foldConsistency: capFoldConsistency, threshold300b: capThreshold },
    supplyRisk: { coverage: supplyCoverage, byPenalty: supplyRisk },
    indexMembership,
    notes: [
      "시가총액은 종목 정적값이 아니라 신호일의 marketCap을 사용해 look-ahead를 피했다.",
      "지수 편입 여부는 point-in-time 데이터 부재로 이번 실행에서는 통계 비교를 생성하지 않았다.",
      "섹터 로테이션과 Supply Risk는 각각 추가수익성/공급압력 overlay로 분리한다는 운영 원칙을 유지했다.",
    ],
    trades,
  };
  const created = result.createdAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const outDir = "analysis-runs";
  await mkdir(outDir, { recursive: true });
  const outputPath = `${outDir}/v8-12-priority-mcap-stability-3fos-${created}.json`;
  await writeFile(outputPath, JSON.stringify(result, null, 2));
  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-12-priority-mcap-stability-3fos/${created}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(client, `${options.userId}/results/v8-12-priority-mcap-stability-3fos/latest.json`, {
      version: STUDY_VERSION,
      createdAt: result.createdAt,
      resultPath: remotePath,
      tradeCount: trades.length,
      overall: result.overall,
      marketCap: result.marketCap,
      supplyRisk: result.supplyRisk,
      indexMembership: result.indexMembership,
    });
  }
  process.stdout.write(`${JSON.stringify({ outputPath, remotePath, tradeCount: trades.length, foldCounts: result.foldCounts, overall: result.overall, marketCap: result.marketCap, supplyRisk: result.supplyRisk, indexMembership }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
