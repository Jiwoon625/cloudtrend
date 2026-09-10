import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && context.parentURL) {
    const url = new URL(specifier + ".ts", context.parentURL);
    if (existsSync(url)) return nextResolve(url.href, context);
  }
  return nextResolve(specifier, context);
}});
const { forwardOutcome, advanceScoreAge, entryState, buildScoreDiagnostics } = await import("../src/lib/engine/scoreDiagnostics.ts");
const { runBacktest, DEFAULT_BACKTEST_PARAMS } = await import("../src/lib/engine/backtestV4.ts");
const { chartSeries } = await import("../src/lib/engine/pipeline.ts");
const prices = (n) => Array.from({ length: n }, (_, i) => ({
  tradeDate: new Date(Date.UTC(2020,0,i+1)).toISOString().slice(0,10),
  open: 100+i, close: 101+i, low: 99+i, high: 102+i, volume: 1000,
  tradingValue: 100000, marketCap: 1e12, foreignNetBuyValue: 1000, institutionNetBuyValue: null,
}));

test("entry gap is excluded; adverse excursion uses entry-day low; censored tails and invalid opens excluded", () => {
  const bars = prices(3);
  bars[0].close = 100; bars[1] = {...bars[1], open: 120, high: 125, low: 90, close: 120};
  const r = forwardOutcome(bars,0,1,100);
  assert.equal(r.ret,-1); assert.equal(r.adverse,-25);
  assert.equal(forwardOutcome(bars,2,1),null);
  assert.equal(forwardOutcome([{...bars[0]}, {...bars[1], open:NaN}],0,1),null);
  assert.equal(forwardOutcome([{...bars[0]}, {...bars[1], low:NaN}],0,1).adverse,null);
});

test("daily episodes distinguish fresh crossing, persistence, reset, and unknown start", () => {
  const seq=[null,7,7,4,7,7,7,7,7,7,null,7,4,7]; let age=null;
  const ages=seq.map((s,i) => age=advanceScoreAge(seq[i-1]??null,s,6,age));
  assert.deepEqual(ages,[null,null,null,0,1,2,3,4,5,6,null,null,0,1]);
  assert.equal(entryState(1),"신규 돌파"); assert.equal(entryState(5),"지속 2~5일");
  assert.equal(entryState(6),"지속 6일 이상"); assert.equal(entryState(null),"시작 불명");
});

test("bands and mutually exclusive states reconcile; OOS uses signal date; benchmark matches next-open entry", () => {
  const bars=prices(8), scores=[null,7,4,7,7,7,7,7];
  const indexes=[{indexCode:"KOSPI",indexName:"index",bars}];
  const d=buildScoreDiagnostics([{symbol:"A",market:"KOSPI",bars,scores}],[1],indexes,bars[4].tradeDate);
  const all=d.rows.filter(r=>r.split==="ALL" && r.kind==="STATE" && r.threshold===6);
  assert.equal(all.reduce((n,r)=>n+r.count,0),5);
  assert.equal(all.find(r=>r.label==="신규 돌파").count,1);
  assert.equal(all.find(r=>r.label==="시작 불명").count,1);
  assert.equal(all.find(r=>r.label==="지속 2~5일").count,3);
  for(const r of all.filter(r=>r.count)) assert.equal(r.excessReturn,0);
  assert.equal(d.rows.filter(r=>r.split==="OOS"&&r.kind==="STATE"&&r.threshold===6).reduce((n,r)=>n+r.count,0),3);
  const noBenchmark=buildScoreDiagnostics([{symbol:"A",market:"KOSDAQ",bars,scores}],[1],indexes);
  assert.equal(noBenchmark.rows.find(r=>r.count>0).benchmarkCount,0);
});

test("engine and charts use complete raw 9.5-point scores, independent of feature experiments", () => {
  const bars=prices(280), series=[{symbol:"A",name:"A",market:"KOSPI",bars}];
  const result=runBacktest(series,{...DEFAULT_BACKTEST_PARAMS,horizons:[5],horizonDays:5,features:["BB_BREAKOUT"],weights:{BB_BREAKOUT:99}});
  const chart=chartSeries({bars:{A:bars},instruments:[{symbol:"A",instrumentType:"STOCK"}]},"A");
  assert.ok(chart.slice(0,251).every(p=>p.historicalTechnicalPoints===null));
  assert.equal(result.scoreDiagnostics.firstScoreDate,bars[251].tradeDate);
  assert.equal(result.scoreDiagnostics.validScoreDays,chart.filter(p=>p.historicalTechnicalPoints!==null).length);
  assert.equal(result.scoreDiagnostics.rows.filter(r=>r.kind==="BAND"&&r.split==="ALL").reduce((n,r)=>n+r.count,0),24);
  const expected=(bars[260].close/bars[256].open-1)*100;
  assert.ok(Math.abs(result.bucketHorizons.filter(r=>r.count>0)[0].avgReturn - (expected+(bars[265].close/bars[261].open-1)*100+(bars[270].close/bars[266].open-1)*100+(bars[275].close/bars[271].open-1)*100)/4)<1e-10);
});

const { simulateTrade, simulateScenario, STRATEGY_SCENARIOS, passesEntry } = await import("../src/lib/engine/strategyValidation.ts");
function strategySeries() {
  const bars=prices(12).map(b=>({...b,open:100,close:100,low:99,high:101}));
  return {symbol:"A",market:"KOSPI",bars,scores:[4,7,7,7,7,4,7,7,7,7,7,7],nearHighs:bars.map(()=>true),extensions:bars.map(()=>10),regimes:bars.map(()=>"RISK_ON")};
}
test("tight stops can discard eventual winners; overnight gaps lose more than the stop limit",()=>{
  const s=strategySeries(); s.bars[2]={...s.bars[2],low:94,close:101}; s.bars[4]={...s.bars[4],close:125,high:126};
  const base=STRATEGY_SCENARIOS.find(x=>x.id==="onset6");
  assert.equal(simulateTrade(s,1,3,base).ret,25);
  assert.ok(Math.abs(simulateTrade(s,1,3,{...base,stopPercent:5}).ret+5)<1e-10);
  s.bars[2].low=99; s.bars[3]={...s.bars[3],open:85,low:84,high:87,close:86};
  const gap=simulateTrade(s,1,3,{...base,stopPercent:5});
  assert.equal(gap.reason,"STOP_GAP"); assert.equal(gap.exitPrice,85);
});
test("score decay exits next open, not the close that generated the signal",()=>{
  const s=strategySeries(); s.scores[2]=3; s.bars[2].close=110; s.bars[3].open=90;
  const r=simulateTrade(s,1,4,STRATEGY_SCENARIOS.find(x=>x.id==="decay"));
  assert.equal(r.exitIndex,3); assert.equal(r.exitPrice,90); assert.equal(r.reason,"SCORE");
});
test("entry filters use signal-time data; positions cannot overlap",()=>{
  const s=strategySeries(), base=STRATEGY_SCENARIOS.find(x=>x.id==="filters");
  assert.equal(passesEntry(s,1,base),true);
  s.extensions[1]=16; assert.equal(passesEntry(s,1,base),false);
  s.extensions[1]=null; assert.equal(passesEntry(s,1,base),false);
  const trades=simulateScenario(s,3,STRATEGY_SCENARIOS.find(x=>x.id==="state6"));
  for(let i=1;i<trades.length;i++) assert.ok(trades[i].entryIndex>trades[i-1].exitIndex);
});
