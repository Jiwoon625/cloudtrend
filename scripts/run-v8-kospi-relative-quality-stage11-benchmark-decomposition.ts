import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildPortfolioSignalContext } from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { DailyPrice } from "../src/lib/engine/types";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8 KOSPI Relative Quality Stage11 Benchmark Decomposition" as const;
const YEARS = Array.from({ length: 10 }, (_, i) => 2017 + i);
const COMPLETE_YEARS = Array.from({ length: 9 }, (_, i) => 2017 + i);
const FOLD_YEARS = [2018, 2022, 2025] as const;
const HORIZON = 20;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const MIN_IC_CROSS_SECTION = 10;

type Target = "ABS_RETURN" | "INDEX_EXCESS" | "EW_EXCESS" | "SECTOR_EXCESS";
const TARGETS: Target[] = ["ABS_RETURN", "INDEX_EXCESS", "EW_EXCESS", "SECTOR_EXCESS"];

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
interface Row {
  year: number;
  date: string;
  symbol: string;
  sectorCode: string;
  score: number;
  onset8: boolean;
  ret: number;
  indexReturn: number;
  indexExcess: number;
  ewReturn: number | null;
  ewExcess: number | null;
  sectorReturn: number | null;
  sectorExcess: number | null;
  rsAccel: number | null;
}

function usage(message?: string): never {
  throw new Error(
    [
      ...(message ? [message, ""] : []),
      "Usage:",
      "  npx vite-node scripts/run-v8-kospi-relative-quality-stage11-benchmark-decomposition.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]",
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
function ranks(values: number[]) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const output = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i + 1;
    while (j < indexed.length && indexed[j]!.value === indexed[i]!.value) j++;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) output[indexed[k]!.index] = rank;
    i = j;
  }
  return output;
}
function pearson(xs: number[], ys: number[]) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = average(xs)!;
  const my = average(ys)!;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  const denominator = Math.sqrt(vx * vy);
  return denominator > 0 ? cov / denominator : null;
}
function spearman(xs: number[], ys: number[]) {
  return pearson(ranks(xs), ranks(ys));
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
  ) throw new Error("지원하지 않거나 손상된 source cache manifest입니다.");
  const texts: string[] = [];
  for (const file of manifest.files) {
    const bytes = new Uint8Array(await readFile(path.join(cacheDir, file.cacheFile)));
    const fileHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== file.bytes || fileHash !== file.fileHash)
      throw new Error(`source cache 무결성 검증 실패: ${file.fileName}`);
    texts.push(decodeSourceBytes(bytes));
  }
  process.stderr.write(
    `KOSPI stage11 source cache verified: ${manifest.fileCount} files / ${(manifest.totalBytes / 1_000_000).toFixed(1)} MB\n`,
  );
  return { texts, manifest };
}
function benchmarkSeries(dataset: MarketDataset) {
  const series = dataset.indexSeries.find((item) => item.indexCode === "KOSPI");
  if (!series?.bars.length) throw new Error("KOSPI 지수 일봉이 없습니다.");
  const bars = [...series.bars].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  return { bars, byDate: new Map(bars.map((bar) => [bar.tradeDate, bar])), indexByDate: new Map(bars.map((bar, index) => [bar.tradeDate, index])) };
}
function benchmarkReturn(benchmark: ReturnType<typeof benchmarkSeries>, entryDate: string, exitDate: string) {
  const entry = benchmark.byDate.get(entryDate);
  const exit = benchmark.byDate.get(exitDate);
  if (!entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exit.close) || exit.close <= 0) return null;
  return (exit.close / entry.open - 1) * 100;
}
function adjustedScore10(baseScore9p5: number | null, sectorPriceLeadership: number | null) {
  if (!finite(baseScore9p5)) return null;
  const available = finite(sectorPriceLeadership);
  const overheated = available && sectorPriceLeadership >= SECTOR_OVERHEAT_THRESHOLD;
  return Math.round((baseScore9p5 + (available && !overheated ? SECTOR_SLOT : 0)) * 100) / 100;
}
function alignedRs(
  bars: DailyPrice[],
  dateIndex: Map<string, number>,
  benchmark: ReturnType<typeof benchmarkSeries>,
  signalDate: string,
  lag: number,
) {
  const marketIndex = benchmark.indexByDate.get(signalDate);
  if (marketIndex === undefined || marketIndex < lag) return null;
  const marketNow = benchmark.bars[marketIndex];
  const marketPast = benchmark.bars[marketIndex - lag];
  if (!marketNow || !marketPast || !finite(marketNow.close) || !finite(marketPast.close) || marketPast.close <= 0) return null;
  const stockNowIndex = dateIndex.get(marketNow.tradeDate);
  const stockPastIndex = dateIndex.get(marketPast.tradeDate);
  if (stockNowIndex === undefined || stockPastIndex === undefined) return null;
  const stockNow = bars[stockNowIndex];
  const stockPast = bars[stockPastIndex];
  if (!stockNow || !stockPast || !finite(stockNow.close) || !finite(stockPast.close) || stockPast.close <= 0) return null;
  return (stockNow.close / stockPast.close - 1) * 100 - (marketNow.close / marketPast.close - 1) * 100;
}
function targetValue(row: Row, target: Target) {
  if (target === "ABS_RETURN") return row.ret;
  if (target === "INDEX_EXCESS") return row.indexExcess;
  if (target === "EW_EXCESS") return row.ewExcess;
  return row.sectorExcess;
}
function byDate(rows: Row[]) {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    const bucket = map.get(row.date) ?? [];
    bucket.push(row);
    map.set(row.date, bucket);
  }
  return map;
}
function dailyScoreIc(rows: Row[], target: Target) {
  const values: number[] = [];
  for (const dateRows of byDate(rows).values()) {
    const valid = dateRows.filter((row) => finite(targetValue(row, target)));
    if (valid.length < MIN_IC_CROSS_SECTION) continue;
    const ic = spearman(valid.map((row) => row.score), valid.map((row) => targetValue(row, target) as number));
    if (finite(ic)) values.push(ic);
  }
  return {
    dates: values.length,
    meanIc: round(average(values)),
    medianIc: round(median(values)),
    positiveIcRatePct: values.length ? round((values.filter((value) => value > 0).length / values.length) * 100) : null,
  };
}
function summarize(rows: Row[], target: Target) {
  const values = rows.map((row) => targetValue(row, target)).filter(finite);
  return {
    count: values.length,
    averagePct: round(average(values)),
    medianPct: round(median(values)),
    positiveRatePct: values.length ? round((values.filter((value) => value > 0).length / values.length) * 100) : null,
  };
}
function rsTail(rows: Row[], target: Target) {
  const valid = rows.filter((row) => finite(row.rsAccel) && finite(targetValue(row, target)));
  const sorted = [...valid].sort((a, b) => (a.rsAccel as number) - (b.rsAccel as number));
  const n = Math.floor(sorted.length * 0.3);
  const low = n >= 5 ? sorted.slice(0, n) : [];
  const high = n >= 5 ? sorted.slice(-n) : [];
  const highValues = high.map((row) => targetValue(row, target) as number);
  const lowValues = low.map((row) => targetValue(row, target) as number);
  return {
    observations: valid.length,
    highCount: high.length,
    lowCount: low.length,
    highAveragePct: round(average(highValues)),
    lowAveragePct: round(average(lowValues)),
    highMedianPct: round(median(highValues)),
    lowMedianPct: round(median(lowValues)),
    highMinusLowAveragePct: high.length && low.length ? round(average(highValues)! - average(lowValues)!) : null,
    spearman: valid.length >= 5 ? round(spearman(valid.map((row) => row.rsAccel as number), valid.map((row) => targetValue(row, target) as number))) : null,
  };
}
function assignPeerBenchmarks(rows: Row[]) {
  for (const dateRows of byDate(rows).values()) {
    const ew = average(dateRows.map((row) => row.ret));
    const sectorGroups = new Map<string, Row[]>();
    for (const row of dateRows) {
      const bucket = sectorGroups.get(row.sectorCode) ?? [];
      bucket.push(row);
      sectorGroups.set(row.sectorCode, bucket);
    }
    for (const row of dateRows) {
      row.ewReturn = ew;
      row.ewExcess = finite(ew) ? row.ret - ew : null;
      const peers = sectorGroups.get(row.sectorCode) ?? [];
      if (peers.length >= 3) {
        const peerMean = (peers.reduce((sum, item) => sum + item.ret, 0) - row.ret) / (peers.length - 1);
        row.sectorReturn = peerMean;
        row.sectorExcess = row.ret - peerMean;
      }
    }
  }
}
function concentrationSummary(rows: Row[]) {
  const valid = rows.filter((row) => finite(row.ewReturn));
  const gaps = valid.map((row) => row.indexReturn - (row.ewReturn as number));
  return {
    observations: valid.length,
    averageIndexReturnPct: round(average(valid.map((row) => row.indexReturn))),
    averageEqualWeightReturnPct: round(average(valid.map((row) => row.ewReturn as number))),
    averageIndexMinusEqualWeightPct: round(average(gaps)),
    medianIndexMinusEqualWeightPct: round(median(gaps)),
    indexBeatsEqualWeightRatePct: gaps.length ? round((gaps.filter((gap) => gap > 0).length / gaps.length) * 100) : null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { texts, manifest } = await loadCachedTexts(options.sourceManifest, options.sourceCacheDir);
  const dataset = parseManualMarketData(texts).dataset;
  const context = buildPortfolioSignalContext(dataset, LIMIT);
  const benchmark = benchmarkSeries(dataset);
  const kospiSeries = context.series.filter((series) => series.market === "KOSPI");
  const rows: Row[] = [];

  for (const series of kospiSeries) {
    const scores = series.baseScores.map((base, index) => adjustedScore10(base, series.sectorPriceLeadership[index] ?? null));
    for (let i = 1; i + HORIZON < series.bars.length; i++) {
      const signal = series.bars[i]!;
      const year = Number(signal.tradeDate.slice(0, 4));
      if (!YEARS.includes(year)) continue;
      const score = scores[i];
      const previousScore = scores[i - 1];
      if (!finite(score) || !finite(previousScore)) continue;
      const entry = series.bars[i + 1];
      const exit = series.bars[i + HORIZON];
      if (!entry || !exit || !finite(entry.open) || entry.open <= 0 || !finite(exit.close) || exit.close <= 0) continue;
      const indexReturn = benchmarkReturn(benchmark, entry.tradeDate, exit.tradeDate);
      if (!finite(indexReturn)) continue;
      const ret = (exit.close / entry.open - 1) * 100;
      const rs20 = alignedRs(series.bars, series.dateIndex, benchmark, signal.tradeDate, 20);
      const rs60 = alignedRs(series.bars, series.dateIndex, benchmark, signal.tradeDate, 60);
      rows.push({
        year,
        date: signal.tradeDate,
        symbol: series.symbol,
        sectorCode: series.sectorCode,
        score,
        onset8: previousScore < ONSET_THRESHOLD && score >= ONSET_THRESHOLD,
        ret,
        indexReturn,
        indexExcess: ret - indexReturn,
        ewReturn: null,
        ewExcess: null,
        sectorReturn: null,
        sectorExcess: null,
        rsAccel: finite(rs20) && finite(rs60) ? rs20 - rs60 : null,
      });
    }
  }
  assignPeerBenchmarks(rows);

  const yearly = YEARS.map((year) => {
    const all = rows.filter((row) => row.year === year);
    const onset = all.filter((row) => row.onset8);
    return {
      year,
      allRows: all.length,
      onsetRows: onset.length,
      scoreIc: Object.fromEntries(TARGETS.map((target) => [target, dailyScoreIc(all, target)])),
      onset: Object.fromEntries(TARGETS.map((target) => [target, summarize(onset, target)])),
      rsAccelOnset: Object.fromEntries(TARGETS.map((target) => [target, rsTail(onset, target)])),
      onsetConcentration: concentrationSummary(onset),
    };
  });

  const aggregateYears = (selectedYears: readonly number[]) => {
    const all = rows.filter((row) => selectedYears.includes(row.year));
    const onset = all.filter((row) => row.onset8);
    return {
      years: selectedYears,
      allRows: all.length,
      onsetRows: onset.length,
      scoreIc: Object.fromEntries(TARGETS.map((target) => [target, dailyScoreIc(all, target)])),
      onset: Object.fromEntries(TARGETS.map((target) => [target, summarize(onset, target)])),
      rsAccelOnset: Object.fromEntries(TARGETS.map((target) => [target, rsTail(onset, target)])),
      onsetConcentration: concentrationSummary(onset),
    };
  };

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
      kospiSymbols: kospiSeries.length,
      rows: rows.length,
    },
    design: {
      objective: "Diagnose whether weak KOSPI results are caused by cap-weighted KOSPI benchmark concentration or sector effects before adding more Relative Quality features.",
      horizon: HORIZON,
      completeYears: COMPLETE_YEARS,
      threeFosYears: [...FOLD_YEARS],
      holdoutYear: 2026,
      targets: {
        ABS_RETURN: "Stock NEXT_OPEN to 20D-close return.",
        INDEX_EXCESS: "Stock return minus KOSPI index return over each stock trade's identical entry/exit dates.",
        EW_EXCESS: "Stock return minus equal-weight mean future return of available KOSPI universe stocks sharing the same signal date.",
        SECTOR_EXCESS: "Stock return minus equal-weight mean future return of other KOSPI stocks in the same mapped sector and signal date; requires at least two peers.",
      },
      notes: [
        "Subtracting one common market return from every stock on a date cannot change daily cross-sectional ranks; sector-relative excess can change ranks because the benchmark differs by sector.",
        "Peer benchmarks are evaluation targets only and never enter signal construction, so future peer returns are not used for trading decisions.",
        "RSAccel remains point-in-time and is included only to see whether its candidate separation survives alternative benchmarks.",
      ],
    },
    threeFos: aggregateYears(FOLD_YEARS),
    completeYears: aggregateYears(COMPLETE_YEARS),
    holdout2026: aggregateYears([2026]),
    yearly,
  };

  const outputDir = path.resolve("analysis-runs");
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `v8-kospi-relative-quality-stage11-benchmark-decomposition-${runId}.json`);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  let remotePath: string | null = null;
  if (options.upload) {
    const client = trustedSupabaseClient();
    remotePath = `${options.userId}/results/v8-kospi-relative-quality-stage11-benchmark-decomposition/${runId}.json`;
    await uploadJson(client, remotePath, result);
    await uploadJson(client, `${options.userId}/results/v8-kospi-relative-quality-stage11-benchmark-decomposition/latest.json`, result);
  }
  process.stdout.write(`${JSON.stringify({ outputPath, remotePath, threeFos: result.threeFos, holdout2026: result.holdout2026 }, null, 2)}\n`);
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
