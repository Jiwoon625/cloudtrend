import fs from'node:fs';import path from'node:path';import{gunzipSync,gzipSync}from'node:zlib';import{createHash}from'node:crypto';import{createReadStream}from'node:fs';import{createGunzip}from'node:zlib';import{StringDecoder}from'node:string_decoder';
import{configureExitRisk,partialFills,type ExitRiskPolicy}from'../src/lib/research/exitRiskPolicy';
import{runAdoptedKrBacktest}from'../src/lib/research/adoptedKrBacktest';import{runAdoptedEtfBacktest}from'../src/lib/research/adoptedEtfBacktest';
const args=process.argv.slice(2).filter(v=>v!=='--');const market=args[0]??'KOSPI';const policy:ExitRiskPolicy=JSON.parse(args[1]??'{"id":"OFF"}');const root=path.resolve('../inputs/derived');const dest=path.resolve('../results',market,policy.id);fs.mkdirSync(dest,{recursive:true});
const sha=(b:any)=>createHash('sha256').update(b).digest('hex');const policyHash=sha(JSON.stringify(policy));

const read=(name:string)=>JSON.parse(gunzipSync(fs.readFileSync(path.join(root,name))).toString('utf8'));
const bars=read(market+'.bars.json.gz');const meta=JSON.parse(fs.readFileSync(path.join(root,'meta.json'),'utf8'));const start=policy.smoke?'2019-12-02':market==='KOSPI'?'2017-08-21':'2017-01-11';const end=policy.smoke?'2019-12-30':'2026-09-11';const dates=meta.sessions;
const codeFiles=['src/lib/portfolioLedgers.ts','src/lib/portfolioStrategyRules.ts','src/lib/ledger/etfAdoptedShadow.ts','src/lib/ledger/modelSeries.ts','src/lib/research/exitRiskPolicy.ts','scripts/exit-risk-run.ts'];const codeHash='sha256:'+sha(JSON.stringify(codeFiles.map(p=>({p,hash:sha(fs.readFileSync(p))}))));
const inputFiles=[market+'.bars.json.gz','meta.json','cache-receipts.json',market==='KOSPI'?'kr.signals.json.gz':'etf.signals.jsonl.gz'].map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))}));
if(fs.existsSync(path.join(dest,'COMPLETE.json'))){const c=JSON.parse(fs.readFileSync(path.join(dest,'COMPLETE.json'),'utf8'));if(c.policyHash!==policyHash||c.codeHash!==codeHash)throw Error('Different policy at output path');if(JSON.stringify(c.inputFiles)!==JSON.stringify(inputFiles))throw Error('Checkpoint input hashes changed');for(const f of c.files){const data=fs.readFileSync(path.join(dest,f.path));if(data.length!==f.bytes||sha(data)!==f.sha256)throw Error('Checkpoint output hash mismatch');}console.log('Already complete',market,policy.id);process.exit(0);}
const write=(name:string,value:any)=>fs.writeFileSync(path.join(dest,name),JSON.stringify(value));
const writeRows=(name:string,value:any[])=>fs.writeFileSync(path.join(dest,name),value.map(v=>JSON.stringify(v)).join('\n')+'\n');

const time=performance.now();
if(market==='KOSPI'){
 const sig=read('kr.signals.json.gz');const score:Record<string,Map<string,number>>={};for(const s of sig.snapshots)for(const e of s.entries)if(Number.isFinite(e.technicalPoints)){score[e.symbol]??=new Map();score[e.symbol]!.set(s.asOfDate,e.technicalPoints);}
 configureExitRisk(policy,bars,score,dates);
 const result=runAdoptedKrBacktest({snapshots:sig.snapshots,bars,markets:meta.markets,marketDates:dates,marketGates:sig.gates,startDate:start,throughDate:end,scope:'KOSPI',fingerprint:'historical-pinned-source',marketLiquidCounts:meta.liquidCounts});
 writeRows('nav.jsonl',result.dailyNAV);writeRows('trades.jsonl',result.trades);write('partial-fills.json',partialFills);write('budgets.json',result.yearlyBudgets);write('accounting.json',result.ledger.modelAccounting);write('timing.json',result.ledger.researchHistory!.exitTiming);
}else{
 configureExitRisk(policy,bars,{},dates);
 async function* boundedLines(stream:any){
  const decoder=new StringDecoder('utf8');let pending='';
  for await(const chunk of stream){pending+=decoder.write(chunk);let at:number;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);if(line)yield line;}}
  pending+=decoder.end();if(pending.trim())yield pending;
 }
 async function* snapshots(){
  const compact=path.join(root,'etf.signals.jsonl.gz');
  if(fs.existsSync(compact)){
   const stream=createReadStream(compact).pipe(createGunzip());let last='';
   for await(const line of boundedLines(stream)){if(!line)continue;const r=JSON.parse(line);if(r.date<=last)throw Error('Non chronological compact snapshots');last=r.date;if(r.date>=start&&r.date<=end)yield r;}
  }else{
   let last='';for(let i=0;i<20;i++){
    const dir=path.resolve('../inputs/research/stored','score-'+String(i).padStart(3,'0'),'attempt-1');
    const stream=createReadStream(path.join(dir,'signal-cache.jsonl.gz')).pipe(createGunzip());
    for await(const line of boundedLines(stream)){if(!line)continue;const w=JSON.parse(line);const r=w.record??w;if(r.date<=last)throw Error('Non chronological cache');last=r.date;if(r.date>=start&&r.date<=end)yield r.etfSnapshot;}
   }
  }
 }

 const result=await runAdoptedEtfBacktest({runId:'exit-'+policy.id,startDate:start,endDate:end,sourceHash:'sha256:'+sha(fs.readFileSync(path.join(root,'cache-receipts.json'))),codeHash:codeHash as any,calendar:{market:'KR',sourceHash:('sha256:'+sha(JSON.stringify(dates)))as any,coverageStart:dates[0],coverageEnd:dates.at(-1),regularSessions:dates},etfSymbols:Object.keys(bars),observedBars:bars,snapshots:snapshots()});
 writeRows('nav.jsonl',result.dailyNav);writeRows('trades.jsonl',result.fills);write('budgets.json',result.finalState.researchYearAssetBases);write('quality.json',result.quality);write('final-state.json',result.finalState);
}
const files=fs.readdirSync(dest).filter(p=>p!=='COMPLETE.json').map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(dest,p))),bytes:fs.statSync(path.join(dest,p)).size}));
write('COMPLETE.json',{policy,policyHash,codeHash,inputFiles,cacheReceipts:sha(fs.readFileSync(path.join(root,'cache-receipts.json'))),start,end,files,wallSeconds:(performance.now()-time)/1000,rssKiB:process.resourceUsage().maxRSS,cpuSeconds:(process.cpuUsage().user+process.cpuUsage().system)/1e6});
console.log('Complete',market,policy.id,Math.round((performance.now()-time)/1000),'seconds');
