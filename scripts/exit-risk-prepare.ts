import fs from 'node:fs';import path from 'node:path';import {gunzipSync,gzipSync}from'node:zlib';import {createHash}from'node:crypto';
import {parseManualMarketData}from'../src/lib/engine/manualDataset';
const root=path.resolve('../inputs/research'),out=path.resolve('../inputs/derived');fs.mkdirSync(out,{recursive:true});
const H=(b:any)=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.resolve('../inputs/prepared/manifest.json'),'utf8'));
function* texts(){for(const f of manifest.files){const b=fs.readFileSync(path.resolve('../inputs/prepared',f.path));if(H(b)!==f.sha256.replace('sha256:',''))throw Error('Input hash');yield gunzipSync(b).toString('utf8');}}
console.log('Canonical parser starts');const parsed=parseManualMarketData(texts());const d=parsed.dataset;
const compact=Object.fromEntries(Object.entries(d.observedBars!).map(([k,v])=>[k,v.map(b=>({tradeDate:b.tradeDate,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume,openObserved:b.openObserved,volumeObserved:b.volumeObserved,etfUnderlyingIndexClose:b.etfUnderlyingIndexClose}))]));
const markets=Object.fromEntries(d.instruments.map(i=>[i.symbol,i.market]));
for(const m of ['KOSPI','ETF']){const b=Object.fromEntries(Object.entries(compact).filter(([k])=>markets[k]===m));fs.writeFileSync(path.join(out,m+'.bars.json.gz'),gzipSync(JSON.stringify(b)));}
fs.writeFileSync(path.join(out,'meta.json'),JSON.stringify({sessions:manifest.sessions,markets,liquidCounts:d.liquidSymbolCountsByDate,instruments:d.instruments,stats:parsed.stats}));
console.log('Canonical bars serialized',d.instruments.length);
const snapshots:any[]=[],gates:any={};const receipts:any[]=[];
for(let i=0;i<20;i++){
 const dir=path.join(root,'stored','score-'+String(i).padStart(3,'0'));const completion=JSON.parse(fs.readFileSync(path.join(dir,'completion.json'),'utf8'));
 const mf=completion.files.find((f:any)=>f.path.endsWith('signal-cache.manifest.json'));const mb=fs.readFileSync(path.join(dir,mf.path));if(H(mb)!==mf.sha256)throw Error('Cache manifest hash');const cm=JSON.parse(mb.toString());
 const df=completion.files.find((f:any)=>f.path.endsWith('signal-cache.jsonl.gz'));const db=fs.readFileSync(path.join(dir,df.path));if(H(db)!==df.sha256||db.length!==df.bytes)throw Error('Cache data hash');
 const rows=gunzipSync(db).toString('utf8').trim().split('\n').map(l=>JSON.parse(l));
 receipts.push({part:i,manifest:mf.sha256,data:df.sha256,identity:cm.identity,dates:cm.evaluationDates});
 for(const wrapped of rows){const r=wrapped.record??wrapped; if(r.date<'2017-08-21')continue; snapshots.push({...r.krSnapshot,savedAt:cm.audit.createdAt,entries:r.krSnapshot.entries.filter((e:any)=>markets[e.symbol]==='KOSPI')});gates[r.date]=r.krGate;}
 console.log('Verified cache',i,rows.length,Object.keys(rows[0]??{}));
}
fs.writeFileSync(path.join(out,'kr.signals.json.gz'),gzipSync(JSON.stringify({snapshots,gates})));
fs.writeFileSync(path.join(out,'cache-receipts.json'),JSON.stringify(receipts));
console.log('Preparation complete',snapshots.length);
