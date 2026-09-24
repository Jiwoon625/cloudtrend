import { createHash } from 'node:crypto';
import { trustedSupabaseClient } from './analysis-run-store';
import { loadActiveSources, inputFingerprint } from '../src/lib/screeningSources.server';
import { parseManualMarketData } from '../src/lib/engine/manualDataset';
import { runFullMarketAnalysis } from '../src/lib/engine/fullMarketAnalysis';
import { mergeScoringConfig } from '../src/lib/engine/scoring';
import { deterministicAnalysis, stableCacheJson } from '../src/lib/screeningCacheContract';
import { warmRecentCharts } from '../src/lib/instrumentChartStore.server';
const client=trustedSupabaseClient(), uid=process.env.SUPABASE_USER_ID!;
if(!uid)throw new Error('SUPABASE_USER_ID required');
const start=Date.now();
const stage=(name:string,detail:unknown={})=>console.log(JSON.stringify({stage:name,ms:Date.now()-start,detail}));
const {data:blob,error}=await client.storage.from('cloudtrend-data').download(`${uid}/cache/screening/latest.json`);
if(error)throw error;
const saved=JSON.parse(await blob.text());
stage('saved-result');
const {sources,texts}=await loadActiveSources(client,uid);
stage('sources-loaded',{count:sources.length});
const config=mergeScoringConfig(undefined);
if(inputFingerprint(sources,config)!==saved.inputFingerprint)throw new Error('Current source/config fingerprint differs from saved screening');
const parsed=parseManualMarketData(texts);stage('parsed');
const {analysis,dataset}=runFullMarketAnalysis(parsed.dataset,config);stage('analysis');
const digest=createHash('sha256').update(stableCacheJson(deterministicAnalysis(analysis))).digest('hex');
if(digest!==saved.resultDigest){
 const left=deterministicAnalysis(analysis) as any,right=deterministicAnalysis(saved.payload.analysis) as any;
 const changed=Object.keys(left).filter(k=>stableCacheJson(left[k])!==stableCacheJson(right[k]));
 stage('digest-mismatch',{changed});
 for(const k of changed){
  if(k==='rows'){
   const differences=left.rows.flatMap((row:any)=>{const other=right.rows.find((r:any)=>r.instrument.symbol===row.instrument.symbol);if(!other)return [{symbol:row.instrument.symbol,missing:true}];const fields=Object.keys(row).filter(f=>stableCacheJson(row[f])!==stableCacheJson(other[f]));return fields.length?[{symbol:row.instrument.symbol,fields}]:[];});
   stage('row-differences',differences.slice(0,8));
  }else stage('field-difference',{field:k,current:left[k],saved:right[k]});
 }
 throw new Error('Recomputed result digest differs');
}
await warmRecentCharts(client,uid,saved,{analysis,dataset,config});stage('charts-ready');
