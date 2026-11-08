/** Official immutable engines; complete-source subwindows, research outputs only. */
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
const [repoRoot,krEngine,inputRoot,outRoot]=process.argv.slice(2).map(s=>path.resolve(s));
const us=await import(pathToFileURL(path.join(repoRoot,'src/lib/engine/usProspectivePortfolio.ts')).href);
const dec=await import(pathToFileURL(path.join(repoRoot,'src/lib/ledger/decimal.ts')).href);
const kr=await import(pathToFileURL(path.join(krEngine,'src/lib/research/adoptedKrBacktest.ts')).href);
const risk=await import(pathToFileURL(path.join(krEngine,'src/lib/research/exitRiskPolicy.ts')).href);
const hash=(x:any)=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const write=(folder:string,name:string,x:any)=>{fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,name+'.tmp'),JSON.stringify(x));fs.renameSync(path.join(folder,name+'.tmp'),path.join(folder,name));};
for(const market of ['US','KR']){
 const file=path.join(inputRoot,market.toLowerCase()+'_account_input.json');const input=JSON.parse(fs.readFileSync(file,'utf8'));
 const variants=market==='US'?['baseline','legacy_spy_momentum20','spy_sma20','rs20_positive']:['baseline','score9','stop10','score9_stop10'];
 for(const fee of [.0015,.003])for(const name of variants){
  const dest=path.join(outRoot,market+'_'+name+'_'+(fee===.0015?'30bp':'60bp'));const identity=hash({input:hash(fs.readFileSync(file,'utf8')),runner:hash(fs.readFileSync(import.meta.filename,'utf8')),market,name,fee});
  if(fs.existsSync(path.join(dest,'COMPLETE.json'))){const d=JSON.parse(fs.readFileSync(path.join(dest,'COMPLETE.json'),'utf8'));if(d.identity!==identity)throw Error('Changed checkpoint identity');for(const f of d.files)if(hash(fs.readFileSync(path.join(dest,f.name),'utf8'))!==f.sha256)throw Error('Changed checkpoint output');console.log(JSON.stringify({resumed:dest}));continue;}
  if(market==='US'){
   const contract={start:input.start,end:input.end,capital:input.initial_capital,fee,name,allocation:'official dated fixed20 initial capital',maxPositions:20,participation:'.01 of previous source ADV20',classification:'date-local source rows'};
   const policy={version:'isolated-us-model-v1',strategyId:'A0_QUARTER_PRIMARY',bookId:`adopted-shadow-${input.start}-v1:US_A0`,contractHash:'sha256:'+hash(contract),accountingStartDate:input.start,initialCapital:String(input.initial_capital),oneWayCost:String(fee)};
   let state=null,previousNav=null;const nav=[],trades=[],audit=[];
   for(const session of input.sessions){
    const rows=session.rows.map((r:any)=>({...r,open:r.volume>0?Number(dec.representedLegacyNumber(r.open)):null,a0Entry:r.a0Entry&&(name==='baseline'||name==='legacy_spy_momentum20'&&r.mom20||name==='spy_sma20'&&r.sma20||name==='rs20_positive'&&r.rs20)}));
    const analysis={date:session.date,rows,state:{},summary:{inputRows:rows.length,rankedRows:rows.length,a0Entries:rows.filter((r:any)=>r.a0Entry).length,a0Exits:rows.filter((r:any)=>r.a0Exit).length,spyClose:rows.find((r:any)=>r.symbol==='SPY')?.close??null}};
    const r=us.stepUsProspectivePortfolio(us.US_PROSPECTIVE_STRATEGIES[0],analysis,state,previousNav,policy,us.usFixedSlotAllocationPolicy(String(input.initial_capital)));
    state=r.state;previousNav=r.nav;trades.push(...r.trades);nav.push({date:session.date,nav:r.nav,cash:r.cash,fees:r.feesUsd,turnover:r.turnover,positions:r.positionsCount});audit.push({date:session.date,stateHash:hash(state),pendingTargets:state.pendingTargets,pendingExits:state.pendingExits});
   }
   write(dest,'nav.json',nav);write(dest,'trades.json',trades);write(dest,'audit.json',audit);write(dest,'state.json',state);write(dest,'contract.json',contract);
  }else{
   const scores:any={};for(const s of input.snapshots)for(const e of s.entries){scores[e.symbol]??=new Map();scores[e.symbol].set(s.asOfDate,e.technicalPoints);}
   const snapshots=(name.includes('score9'))?input.snapshots.map((s:any)=>({...s,entries:s.entries.map((e:any)=>e.technicalPoints>=9?{...e,kosdaq80Onset:false,status:'RESEARCH_ENTRY_BLOCKED'}:{...e})})):input.snapshots;
   risk.configureExitRisk(name.includes('stop10')?{id:'FIXED_STOP10_C1',stop:.1,confirm:1,fee}:{id:'OFF',fee},input.bars,scores,input.sessions);
   const r=kr.runAdoptedKrBacktest({snapshots,bars:input.bars,markets:input.markets,marketDates:input.sessions,marketGates:{},startDate:input.start,throughDate:input.end,scope:'KOSDAQ',initialCapital:input.initial_capital,fingerprint:'R3_DATED_OBSERVED_SUBWINDOW',marketLiquidCounts:input.liquidCounts});
   write(dest,'nav.json',r.dailyNAV);write(dest,'trades.json',r.trades);write(dest,'accounting.json',r.ledger.modelAccounting);write(dest,'summary.json',r.ledger.summary);write(dest,'contract.json',{capital:input.initial_capital,start:input.start,end:input.end,fee,name,slots:30,sectorSlots:6,missing_signal_dates:input.missing_signal_dates});
  }
  const files=fs.readdirSync(dest).filter(n=>n!=='COMPLETE.json').map(name=>({name,sha256:hash(fs.readFileSync(path.join(dest,name),'utf8'))}));write(dest,'COMPLETE.json',{identity,market,name,fee,inputHash:hash(fs.readFileSync(file,'utf8')),files,productionChanged:false,independentOOS:false});console.log(JSON.stringify({complete:market+'_'+name,fee}));
 }
}
