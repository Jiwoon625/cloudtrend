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

const {
  simulateTrade,
  simulateScenario,
  passesEntry,
  scorePercent,
} = await import("../src/lib/engine/strategyValidation.ts");
const { classifyV6Momentum } = await import("../src/lib/engine/v6Momentum.ts");

const scenario = (overrides={}) => ({
  id:"v6-test", label:"v6-test", entryThreshold:60, maxHoldingDays:20,
  upsideExitThreshold:80, downsideExitThreshold:60, ...overrides,
});

function strategySeries(n=30) {
  const bars=prices(n).map(b=>({...b,open:100,close:100,low:99,high:101}));
  const scores=Array(n).fill(6.0);
  scores[0]=5.0; // 52.6 -> 63.2: 60-point Onset at index 1
  return {symbol:"A",market:"KOSPI",bars,scores,nearHighs:bars.map(()=>true),extensions:bars.map(()=>10),regimes:bars.map(()=>"RISK_ON")};
}

test("V6 uses normalized 0-100 thresholds while preserving the 9.5 raw score", () => {
  assert.ok(Math.abs(scorePercent(5.7)-60)<1e-10);
  assert.ok(Math.abs(scorePercent(6.65)-70)<1e-10);
  const s=strategySeries();
  assert.equal(passesEntry(s,1,scenario()),true);
  assert.equal(passesEntry(s,2,scenario()),false);
  s.scores[1]=8.0;
  assert.equal(passesEntry(s,1,scenario()),false); // already beyond selected 80-point exit target
});

test("V6 upside score crossing exits on the following open", () => {
  const s=strategySeries();
  s.scores[2]=7.0;
  s.scores[3]=8.0; // crosses 80 at index 3 close
  s.bars[4].open=120;
  const trade=simulateTrade(s,1,scenario());
  assert.equal(trade.reason,"UPSIDE_SCORE");
  assert.equal(trade.exitIndex,4);
  assert.equal(trade.exitPrice,120);
  assert.ok(Math.abs(trade.ret-20)<1e-10);
});

test("V6 downside score crossing exits on the following open", () => {
  const s=strategySeries();
  s.scores[2]=6.1;
  s.scores[3]=5.5; // falls through 60 at index 3 close
  s.bars[4].open=90;
  const trade=simulateTrade(s,1,scenario());
  assert.equal(trade.reason,"DOWNSIDE_SCORE");
  assert.equal(trade.exitIndex,4);
  assert.equal(trade.exitPrice,90);
  assert.ok(Math.abs(trade.ret+10)<1e-10);
});

test("V6 closes at the maximum holding-day close when no score event occurs", () => {
  const s=strategySeries();
  s.bars[21].close=125;
  const trade=simulateTrade(s,1,scenario());
  assert.equal(trade.reason,"TIME");
  assert.equal(trade.exitIndex,21);
  assert.equal(trade.holdingDays,20);
  assert.ok(Math.abs(trade.ret-25)<1e-10);
});

test("V6 records score acceleration and prevents overlapping positions", () => {
  const s=strategySeries(50);
  s.scores=Array(50).fill(5.0);
  s.scores[0]=4.5; s.scores[1]=6.0;
  s.scores[7]=5.0; s.scores[8]=6.0;
  s.scores[14]=5.0; s.scores[15]=6.0;
  const trades=simulateScenario(s,scenario({maxHoldingDays:5,upsideExitThreshold:90,downsideExitThreshold:30}));
  for(let i=1;i<trades.length;i++) assert.ok(trades[i].entryIndex>trades[i-1].exitIndex);
});

test("fixed price stop fills at the stop intraday and at the open after a gap", () => {
  const base=scenario({upsideExitThreshold:90,downsideExitThreshold:30});
  const s=strategySeries();
  s.bars[2]={...s.bars[2],open:100,high:101,low:89,close:95};
  const intraday=simulateTrade(s,1,base,0,{kind:"FIXED_STOP",id:"fixed-10",label:"-10%",stopPercent:10});
  assert.equal(intraday.reason,"PRICE_STOP");
  assert.equal(intraday.exitIndex,2);
  assert.equal(intraday.exitPrice,90);
  assert.ok(Math.abs(intraday.ret+10)<1e-10);

  const g=strategySeries();
  g.bars[3]={...g.bars[3],open:85,high:88,low:84,close:86};
  const gap=simulateTrade(g,1,base,0,{kind:"FIXED_STOP",id:"fixed-10",label:"-10%",stopPercent:10});
  assert.equal(gap.reason,"PRICE_STOP");
  assert.equal(gap.exitIndex,3);
  assert.equal(gap.exitPrice,85);
  assert.ok(Math.abs(gap.ret+15)<1e-10);
});

test("ATR trailing stop only uses a trailing level known before the session", () => {
  const s=strategySeries(40);
  const base=scenario({maxHoldingDays:30,upsideExitThreshold:90,downsideExitThreshold:30});
  s.bars[15]={...s.bars[15],open:100,low:100,high:110,close:109};
  s.bars[16]={...s.bars[16],open:109,low:103,high:110,close:104};
  const trade=simulateTrade(s,1,base,0,{kind:"ATR_TRAILING",id:"atr-2",label:"ATR14 x2",multiplier:2,period:14});
  assert.equal(trade.reason,"ATR_TRAIL");
  assert.equal(trade.exitIndex,16);
  assert.equal(trade.exitTiming,"STOP");
  assert.ok(trade.exitPrice>103 && trade.exitPrice<109);
  assert.ok(trade.ret>0);
});

test("momentum risk means the latest 60+ episode reached 80 before falling below 60", () => {
  assert.equal(classifyV6Momentum([55,62,72,83,74,58,55]).status,"MOMENTUM_RISK");
  assert.equal(classifyV6Momentum([55,62,72,58,55]).status,null);
  assert.equal(classifyV6Momentum([55,82,58,62,58]).status,null); // new 60+ episode never reached 80
  assert.equal(classifyV6Momentum([55,62]).status,"ENTRY_60");
  assert.equal(classifyV6Momentum([55,75]).status,"ENTRY_70");
});
