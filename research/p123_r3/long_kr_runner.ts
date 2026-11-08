/** Isolated frozen-engine reproduction. No network, live DB or production writes. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const [engineRoot,inputRoot,outputRoot,specFile]=process.argv.slice(2).map(v=>path.resolve(v));
const {runAdoptedKrBacktest}=await import(pathToFileURL(path.join(engineRoot,'src/lib/research/adoptedKrBacktest.ts')).href);
const {configureExitRisk,partialFills}=await import(pathToFileURL(path.join(engineRoot,'src/lib/research/exitRiskPolicy.ts')).href);
const read=(name:string)=>JSON.parse(gunzipSync(fs.readFileSync(path.join(inputRoot,name))).toString('utf8'));
const meta=JSON.parse(fs.readFileSync(path.join(inputRoot,'meta.json'),'utf8'));
const bars=read('KOSDAQ.bars.json.gz'),sig=read('kr.signals.json.gz');
const specs=JSON.parse(fs.readFileSync(specFile,'utf8'));
const sha=(b:any)=>createHash('sha256').update(b).digest('hex');
const inputs=['KOSDAQ.bars.json.gz','kr.signals.json.gz','meta.json','cache-receipts.json'].map(name=>({name,sha256:sha(fs.readFileSync(path.join(inputRoot,name)))}));
const engineFiles=fs.readdirSync(path.join(engineRoot,'src'),{recursive:true}).map(String).filter(p=>p.endsWith('.ts')||p.endsWith('.json')).sort().map(p=>({name:p,sha256:sha(fs.readFileSync(path.join(engineRoot,'src',p)))}));
const codeHash=sha(JSON.stringify({runner:sha(fs.readFileSync(import.meta.filename)),engineFiles}));
const scores:Record<string,Map<string,number>>={};
for(const s of sig.snapshots)for(const e of s.entries)if(Number.isFinite(e.technicalPoints)){scores[e.symbol]??=new Map();scores[e.symbol].set(s.asOfDate,e.technicalPoints);}
for(const spec of specs){
 if(!/^[A-Za-z0-9_-]+$/.test(spec.name))throw Error('invalid scenario');
 const dest=path.join(outputRoot,spec.name),identity=sha(JSON.stringify({inputs,codeHash,spec})),marker=path.join(dest,'COMPLETE.json');
 if(fs.existsSync(marker)){const c=JSON.parse(fs.readFileSync(marker,'utf8'));if(c.identity!==identity)throw Error('checkpoint identity changed');for(const f of c.files)if(sha(fs.readFileSync(path.join(dest,f.name)))!==f.sha256)throw Error('checkpoint output changed');console.log(JSON.stringify({resumed:spec.name}));continue;}
 fs.mkdirSync(dest,{recursive:true});
 const t=performance.now();
 const snapshots=spec.scoreMax?sig.snapshots.map((s:any)=>({...s,entries:s.entries.map((e:any)=>({...e,kosdaq80Onset:e.kosdaq80Onset&&Number.isFinite(e.technicalPoints)&&e.technicalPoints<spec.scoreMax}))})):sig.snapshots;
 const policy=spec.stop?{id:'FIXED_STOP10_C1',stop:spec.stop,confirm:1,fee:spec.fee}:{id:'OFF',fee:spec.fee};
 configureExitRisk(policy,bars,scores,meta.sessions);
 const result=runAdoptedKrBacktest({snapshots,bars,markets:meta.markets,marketDates:meta.sessions,marketGates:sig.gates,startDate:spec.start??'2017-08-21',throughDate:spec.end??'2026-09-11',scope:'KOSDAQ',fingerprint:'historical-pinned-source',marketLiquidCounts:meta.liquidCounts});
 const atomic=(name:string,body:string)=>{fs.writeFileSync(path.join(dest,name+'.tmp'),body);fs.renameSync(path.join(dest,name+'.tmp'),path.join(dest,name));};
 const json=(name:string,x:any)=>atomic(name,JSON.stringify(x));
 const rows=(name:string,x:any[])=>atomic(name,x.map(v=>JSON.stringify(v)).join('\n')+'\n');
 rows('nav.jsonl',result.dailyNAV);rows('trades.jsonl',result.trades);json('budgets.json',result.yearlyBudgets);json('accounting.json',result.ledger.modelAccounting);json('timing.json',result.ledger.researchHistory.exitTiming);json('partial-fills.json',partialFills);json('summary.json',result.ledger.summary);json('evidence.json',result.evidence);
 const files=fs.readdirSync(dest).filter(n=>n!=='COMPLETE.json').sort().map(name=>({name,sha256:sha(fs.readFileSync(path.join(dest,name))),bytes:fs.statSync(path.join(dest,name)).size}));
 json('COMPLETE.json',{identity,inputs,codeHash,spec,files,elapsedSeconds:(performance.now()-t)/1000,historicalUniverse:'frozen legacy 325-symbol roster; NOT PIT certified; conditional reproduction only',independentOOS:false,productionChanged:false});
 console.log(JSON.stringify({complete:spec.name,seconds:(performance.now()-t)/1000,navRows:result.dailyNAV.length,trades:result.trades.length}));
}
