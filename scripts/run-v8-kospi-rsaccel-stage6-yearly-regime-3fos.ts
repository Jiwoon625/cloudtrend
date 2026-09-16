import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parseManualMarketData } from "../src/lib/engine/manualDataset";
import { buildPortfolioSignalContext } from "../src/lib/engine/sectorPenaltyPortfolioSignals";
import type { MarketDataset } from "../src/lib/engine/dataset";
import type { DailyPrice } from "../src/lib/engine/types";
import { trustedSupabaseClient, uploadJson } from "./analysis-run-store";

const STUDY_VERSION = "CloudTrend V8 KOSPI RSAccel Stage6 Yearly Regime Robustness" as const;
const YEARS = Array.from({ length: 11 }, (_, i) => 2016 + i);
const HORIZON = 20;
const COST_BPS = 20;
const LIMIT = 613;
const ONSET_THRESHOLD = 8;
const SECTOR_SLOT = 0.5;
const SECTOR_OVERHEAT_THRESHOLD = 80;
const MA_LOOKBACK = 120;
const RETURN_LOOKBACK = 60;
const BULL_RETURN_THRESHOLD = 5;
const BEAR_RETURN_THRESHOLD = -5;

type Regime = "BULL" | "NEUTRAL" | "BEAR";
type StrategyId = "BASELINE_ONSET8" | "FILTER_POSITIVE" | "FILTER_Q4PLUS";

interface CacheManifestFile { id: string; fileName: string; bytes: number; savedAt: string; fileHash: string; cacheFile: string }
interface CacheManifest { schemaVersion: 1; sourceType: "backtest"; cacheKey: string; fileCount: number; totalBytes: number; files: CacheManifestFile[] }
interface Options { sourceManifest: string; sourceCacheDir: string; userId: string | null; upload: boolean }
interface Observation { date: string; symbol: string; score: number; rs20: number; rs60: number; rsAccel: number; onset8: boolean; signalIndex: number; regime: Regime }
interface Trade { year: number; regime: Regime; strategy: StrategyId; symbol: string; signalDate: string; entryDate: string; exitDate: string; grossReturnPct: number; benchmarkReturnPct: number; netReturnPct: number; netExcessPct: number }

function usage(message?: string): never {
  throw new Error([...(message ? [message, ""] : []), "Usage:", "  npx vite-node scripts/run-v8-kospi-rsaccel-stage6-yearly-regime-3fos.ts --source-manifest <path> --source-cache-dir <dir> [--supabase-user-id <uuid>] [--upload]"].join("\n"));
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

const finite = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value);
const average = (values: number[]) => values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
function median(values: number[]) { if (!values.length) return null; const s = [...values].sort((a,b)=>a-b); const m=(s.length-1)/2; return (s[Math.floor(m)]!+s[Math.ceil(m)]!)/2; }
function round(value: number | null, digits = 6) { if (!finite(value)) return null; const f=10**digits; return Math.round(value*f)/f; }
function decodeSourceBytes(bytes: Uint8Array) { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return new TextDecoder("euc-kr").decode(bytes); } }

async function loadCachedTexts(manifestPath: string, cacheDir: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CacheManifest;
  if (manifest.schemaVersion !== 1 || manifest.sourceType !== "backtest" || !Array.isArray(manifest.files) || manifest.files.length !== manifest.fileCount) throw new Error("지원하지 않거나 손상된 source cache manifest입니다.");
  const texts: string[] = [];
  for (const file of manifest.files) {
    const bytes = new Uint8Array(await readFile(path.join(cacheDir, file.cacheFile)));
    const fileHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== file.bytes || fileHash !== file.fileHash) throw new Error(`source cache 무결성 검증 실패: ${file.fileName}`);
    texts.push(decodeSourceBytes(bytes));
  }
  process.stderr.write(`KOSPI RSAccel stage6 source cache verified: ${manifest.fileCount} files / ${(manifest.totalBytes / 1_000_000).toFixed(1)} MB\n`);
  return { texts, manifest };
}

function benchmarkSeries(dataset: MarketDataset) {
  const series = dataset.indexSeries.find((item) => item.indexCode === "KOSPI");
  if (!series?.bars.length) throw new Error("KOSPI 지수 일봉이 없습니다.");
  const bars = [...series.bars].sort((a,b)=>a.tradeDate.localeCompare(b.tradeDate));
  return { bars, byDate: new Map(bars.map((bar)=>[bar.tradeDate,bar])), indexByDate: new Map(bars.map((bar,index)=>[bar.tradeDate,index])) };
}

function adjustedScore10(baseScore9p5: number | null, sectorPriceLeadership: number | null) {
  if (!finite(baseScore9p5)) return null;
  const available = finite(sectorPriceLeadership);
  const overheated = available && sectorPriceLeadership >= SECTOR_OVERHEAT_THRESHOLD;
  return Math.round((baseScore9p5 + (available && !overheated ? SECTOR_SLOT : 0)) * 100) / 100;
}

function alignedRelativeStrength(bars: DailyPrice[], dateIndex: Map<string, number>, signalDate: string, benchmark: ReturnType<typeof benchmarkSeries>, lag: number) {
  const bi = benchmark.indexByDate.get(signalDate); if (bi === undefined || bi < lag) return null;
  const pb = benchmark.bars[bi-lag]; const cb = benchmark.bars[bi]; if (!pb || !cb || !finite(pb.close) || !finite(cb.close) || pb.close <= 0) return null;
  const ci = dateIndex.get(signalDate); const pi = dateIndex.get(pb.tradeDate); if (ci === undefined || pi === undefined) return null;
  const cs = bars[ci]; const ps = bars[pi]; if (!cs || !ps || !finite(cs.close) || !finite(ps.close) || ps.close <= 0) return null;
  return (cs.close / ps.close - 1) * 100 - (cb.close / pb.close - 1) * 100;
}

function regimeAt(date: string, benchmark: ReturnType<typeof benchmarkSeries>): Regime | null {
  const i = benchmark.indexByDate.get(date); if (i === undefined || i < Math.max(MA_LOOKBACK-1, RETURN_LOOKBACK)) return null;
  const cur = benchmark.bars[i]; const past = benchmark.bars[i-RETURN_LOOKBACK]; if (!cur || !past || !finite(cur.close) || !finite(past.close) || past.close <= 0) return null;
  const maBars = benchmark.bars.slice(i-MA_LOOKBACK+1, i+1); if (maBars.length !== MA_LOOKBACK || maBars.some((b)=>!finite(b.close))) return null;
  const ma = maBars.reduce((s,b)=>s+b.close,0)/MA_LOOKBACK;
  const r60 = (cur.close/past.close-1)*100;
  if (cur.close > ma && r60 > BULL_RETURN_THRESHOLD) return "BULL";
  if (cur.close < ma && r60 < BEAR_RETURN_THRESHOLD) return "BEAR";
  return "NEUTRAL";
}

function ranks(values: number[]) {
  const indexed = values.map((value,index)=>({value,index})).sort((a,b)=>a.value-b.value); const out=new Array<number>(values.length); let i=0;
  while(i<indexed.length){let j=i+1; while(j<indexed.length && indexed[j]!.value===indexed[i]!.value) j++; const r=(i+1+j)/2; for(let k=i;k<j;k++) out[indexed[k]!.index]=r; i=j;} return out;
}

function dailyQuintiles(rows: Observation[]) {
  const byDate = new Map<string, Observation[]>();
  for (const row of rows) { const bucket=byDate.get(row.date)??[]; bucket.push(row); byDate.set(row.date,bucket); }
  const q = new Map<string,1|2|3|4|5>();
  for (const [date,dateRows] of byDate) { if (dateRows.length<5) continue; const rr=ranks(dateRows.map(r=>r.rsAccel)); for(let i=0;i<dateRows.length;i++){const qq=Math.min(5,Math.max(1,Math.floor(((rr[i]!-1)*5)/dateRows.length)+1)) as 1|2|3|4|5; q.set(`${date}|${dateRows[i]!.symbol}`,qq);} }
  return q;
}

function select(strategy: StrategyId, rows: Observation[], q: Map<string,1|2|3|4|5>) {
  if (strategy === "BASELINE_ONSET8") return rows.filter(r=>r.onset8);
  if (strategy === "FILTER_POSITIVE") return rows.filter(r=>r.onset8 && r.rsAccel>0);
  return rows.filter(r=>r.onset8 && (q.get(`${r.date}|${r.symbol}`) ?? 0) >= 4);
}

function benchmarkReturn(benchmark: ReturnType<typeof benchmarkSeries>, entryDate: string, exitDate: string) {
  const e=benchmark.byDate.get(entryDate); const x=benchmark.byDate.get(exitDate); if(!e||!x||!finite(e.open)||e.open<=0||!finite(x.close)||x.close<=0) return null; return (x.close/e.open-1)*100;
}

function buildTrades(year: number, regime: Regime, strategy: StrategyId, rows: Observation[], q: Map<string,1|2|3|4|5>, seriesBySymbol: Map<string,{bars:DailyPrice[]}>, benchmark: ReturnType<typeof benchmarkSeries>) {
  const candidates: Trade[]=[];
  for (const signal of select(strategy, rows.filter(r=>r.regime===regime), q)) {
    const s=seriesBySymbol.get(signal.symbol); if(!s) continue; const entry=s.bars[signal.signalIndex+1]; const exit=s.bars[signal.signalIndex+HORIZON]; if(!entry||!exit||!finite(entry.open)||entry.open<=0||!finite(exit.close)||exit.close<=0) continue;
    const br=benchmarkReturn(benchmark,entry.tradeDate,exit.tradeDate); if(!finite(br)) continue; const gross=(exit.close/entry.open-1)*100; candidates.push({year,regime,strategy,symbol:signal.symbol,signalDate:signal.date,entryDate:entry.tradeDate,exitDate:exit.tradeDate,grossReturnPct:gross,benchmarkReturnPct:br,netReturnPct:gross-COST_BPS/100,netExcessPct:gross-br-COST_BPS/100});
  }
  candidates.sort((a,b)=>a.entryDate.localeCompare(b.entryDate)||a.symbol.localeCompare(b.symbol));
  const accepted: Trade[]=[]; const heldUntil=new Map<string,string>();
  for(const t of candidates){const prev=heldUntil.get(t.symbol); if(prev && t.entryDate<=prev) continue; accepted.push(t); heldUntil.set(t.symbol,t.exitDate);} return accepted;
}

function summarize(trades: Trade[]) {
  const r=trades.map(t=>t.netReturnPct); const x=trades.map(t=>t.netExcessPct);
  return { trades: trades.length, avgReturnPct: round(average(r)), medianReturnPct: round(median(r)), winRatePct: trades.length?round(r.filter(v=>v>0).length/trades.length*100):null, avgExcessPct: round(average(x)), medianExcessPct: round(median(x)), excessWinRatePct: trades.length?round(x.filter(v=>v>0).length/trades.length*100):null };
}

async function main(){
  const options=parseArgs(process.argv.slice(2)); const {texts,manifest}=await loadCachedTexts(options.sourceManifest,options.sourceCacheDir); const parsed=parseManualMarketData(texts); const dataset=parsed.dataset; const context=buildPortfolioSignalContext(dataset,LIMIT); const benchmark=benchmarkSeries(dataset); const kospi=context.series.filter(s=>s.market==="KOSPI");
  const observations: Observation[]=[]; const seriesBySymbol=new Map<string,{bars:DailyPrice[]}>();
  for(const series of kospi){ const scores=series.baseScores.map((b,i)=>adjustedScore10(b,series.sectorPriceLeadership[i]??null)); const dateIndex=new Map(series.bars.map((b,i)=>[b.tradeDate,i])); seriesBySymbol.set(series.symbol,{bars:series.bars});
    for(let i=1;i+HORIZON<series.bars.length;i++){ const bar=series.bars[i]!; const year=Number(bar.tradeDate.slice(0,4)); if(!YEARS.includes(year)) continue; const score=scores[i]; const prev=scores[i-1]; if(!finite(score)) continue; const rs20=alignedRelativeStrength(series.bars,dateIndex,bar.tradeDate,benchmark,20); const rs60=alignedRelativeStrength(series.bars,dateIndex,bar.tradeDate,benchmark,60); const regime=regimeAt(bar.tradeDate,benchmark); if(!finite(rs20)||!finite(rs60)||!regime) continue; observations.push({date:bar.tradeDate,symbol:series.symbol,score,rs20,rs60,rsAccel:rs20-rs60,onset8:finite(prev)&&prev<ONSET_THRESHOLD&&score>=ONSET_THRESHOLD,signalIndex:i,regime}); }
  }
  const q=dailyQuintiles(observations); const strategies: StrategyId[]=["BASELINE_ONSET8","FILTER_POSITIVE","FILTER_Q4PLUS"]; const regimes: Regime[]=["BULL","NEUTRAL","BEAR"];
  const yearly=YEARS.flatMap(year=>regimes.flatMap(regime=>{ const yearRows=observations.filter(r=>Number(r.date.slice(0,4))===year); return strategies.map(strategy=>({year,regime,strategy,...summarize(buildTrades(year,regime,strategy,yearRows,q,seriesBySymbol,benchmark))})); }));
  const robustness=regimes.flatMap(regime=>strategies.map(strategy=>{ const rows=yearly.filter(r=>r.regime===regime&&r.strategy===strategy&&r.trades>0); const baselineByYear=new Map(yearly.filter(r=>r.regime===regime&&r.strategy==="BASELINE_ONSET8").map(r=>[r.year,r.avgExcessPct])); const deltas=rows.filter(r=>finite(r.avgExcessPct)&&finite(baselineByYear.get(r.year))).map(r=>r.avgExcessPct!-baselineByYear.get(r.year)!); return {regime,strategy,yearsWithTrades:rows.length,totalTrades:rows.reduce((s,r)=>s+r.trades,0),meanYearAvgExcessPct:round(average(rows.map(r=>r.avgExcessPct).filter(finite))),medianYearAvgExcessPct:round(median(rows.map(r=>r.avgExcessPct).filter(finite))),positiveExcessYears:rows.filter(r=>finite(r.avgExcessPct)&&r.avgExcessPct!>0).length,positiveDeltaYears:strategy==="BASELINE_ONSET8"?null:deltas.filter(v=>v>0).length,meanDeltaVsBaselinePct:strategy==="BASELINE_ONSET8"?0:round(average(deltas))}; }));
  const regimeCounts=regimes.map(regime=>({regime,onsetSignals:observations.filter(r=>r.onset8&&r.regime===regime).length,years:[...new Set(observations.filter(r=>r.onset8&&r.regime===regime).map(r=>Number(r.date.slice(0,4))))]}));
  const result={studyVersion:STUDY_VERSION,createdAt:new Date().toISOString(),datasetVersion:dataset.version,asOfDate:dataset.asOfDate,source:{cacheKey:manifest.cacheKey,fileCount:manifest.fileCount,totalBytes:manifest.totalBytes},config:{years:YEARS,horizon:HORIZON,costBps:COST_BPS,regime:{maLookback:MA_LOOKBACK,returnLookback:RETURN_LOOKBACK,bullReturnThreshold:BULL_RETURN_THRESHOLD,bearReturnThreshold:BEAR_RETURN_THRESHOLD},strategies},regimeCounts,yearly,robustness};
  await mkdir("analysis-runs",{recursive:true}); const stamp=new Date().toISOString().replace(/[-:TZ.]/g,"").slice(0,14); const outputPath=path.resolve(`analysis-runs/v8-kospi-rsaccel-stage6-yearly-regime-${stamp}.json`); await writeFile(outputPath,JSON.stringify(result,null,2)); let remotePath:string|null=null;
  if(options.upload&&options.userId){ const client=trustedSupabaseClient(); remotePath=`${options.userId}/results/v8-kospi-rsaccel-stage6-yearly-regime/${stamp}.json`; await uploadJson(client,remotePath,result); await uploadJson(client,`${options.userId}/results/v8-kospi-rsaccel-stage6-yearly-regime/latest.json`,result); }
  process.stdout.write(JSON.stringify({outputPath,remotePath,regimeCounts,robustness},null,2)+"\n");
}

void main();
