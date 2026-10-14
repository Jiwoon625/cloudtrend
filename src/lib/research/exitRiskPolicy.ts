// Research-only opt-in overlay. Default OFF preserves the official executor byte for byte.
import type { DailyPrice } from '../engine/types';
import type { PortfolioTrade } from '../portfolioStoreCore';
import type { ExitPlan } from '../portfolioStrategyRules';
export interface ExitRiskPolicy { id:string; smoke?:boolean; currentExecution?:boolean; down?:number; stop?:number; ma?:number; trail?:number; replaceIndex?:boolean; confirm?:number; fraction?:number; fee?:number; exposureScale?:number; }
let policy:ExitRiskPolicy={id:'OFF'};
let bars:Record<string,DailyPrice[]>={};
let scores:Record<string,Map<string,number>>={};
let dates:string[]=[];
let dateIndex=new Map<string,number>();
let indexStreak=new Map<string,{date:string,n:number}>();
let cache=new Map<string,{date:string;reason:string}|null>();
export const partialDone=new Set<string>();
export const partialFills:any[]=[];
export function configureExitRisk(p:ExitRiskPolicy,b:Record<string,DailyPrice[]>,s:Record<string,Map<string,number>>,d:string[]){policy=p;bars=b;scores=s;dates=d;dateIndex=new Map(d.map((v,i)=>[v,i]));indexStreak.clear();cache=new Map();partialDone.clear();partialFills.length=0;}
export function exitRiskPolicy(){return policy;}
export const isTradable=(b:DailyPrice)=>Number.isFinite(b.open)&&b.open>0&&b.openObserved!==false&&Number.isFinite(b.volume)&&b.volume>0&&b.volumeObserved!==false;
export function firstAdditionalSignal(symbol:string,entryDate:string,entryPrice:number):{date:string;reason:string}|null{
 const key=`${symbol}|${entryDate}|${entryPrice}`;if(cache.has(key))return cache.get(key)!;
 const bs=bars[symbol]??[];const sm=scores[symbol];const confirm=policy.confirm??1;
 let highest=entryPrice,prevScore:number|undefined,downActive=false;let streaks:Record<string,number>={};let previousDate='';
 for(let i=0;i<bs.length;i++){
  const b=bs[i]!;const sc=sm?.get(b.tradeDate);
  if(b.tradeDate<entryDate){if(sc!==undefined)prevScore=sc;continue;}
  const validClose=Number.isFinite(b.close)&&b.close>0;
  const consecutive=previousDate===''||dateIndex.get(b.tradeDate)===(dateIndex.get(previousDate)??-2)+1;
  if(!consecutive){streaks={};downActive=false;}
  const conditions:Record<string,boolean>={};
  if(policy.down!==undefined){
   if(sc!==undefined){if(prevScore!==undefined&&prevScore>policy.down&&sc<=policy.down)downActive=true;if(sc>policy.down)downActive=false;conditions['DOWN'+policy.down]=downActive&&sc<=policy.down;prevScore=sc;}
   else {downActive=false;conditions['DOWN'+policy.down]=false;}
  }
  if(validClose)highest=Math.max(highest,b.close);
  if(policy.stop!==undefined)conditions['STOP'+policy.stop]=validClose&&b.close/(entryPrice*(1+(policy.fee??0.0015)))-1<=-policy.stop;
  if(policy.trail!==undefined)conditions['TRAIL'+policy.trail]=validClose&&b.close/highest-1<=-policy.trail;
  if(policy.ma){const window=bs.slice(Math.max(0,i-policy.ma+1),i+1);const good=window.length===policy.ma&&window.every(v=>Number.isFinite(v.close)&&v.close>0);const avg=good?window.reduce((a,v)=>a+v.close,0)/policy.ma:NaN;conditions['ETF_MA'+policy.ma]=validClose&&good&&b.close<avg;}
  for(const [reason,hit]of Object.entries(conditions)){streaks[reason]=hit?(streaks[reason]??0)+1:0;if(streaks[reason]>=confirm){const found={date:b.tradeDate,reason};cache.set(key,found);return found;}}
  previousDate=b.tradeDate;
 }
 cache.set(key,null);return null;
}
export function overlayKrExit(t:PortfolioTrade,original:ExitPlan|null,latest:string):ExitPlan|null{
 if(policy.id==='OFF'||partialDone.has(t.id))return original;
 const signal=firstAdditionalSignal(t.symbol,t.entryDate,t.entryPrice);if(!signal)return original;
 const b=(bars[t.symbol]??[]).find(b=>b.tradeDate>signal.date&&b.tradeDate<=latest&&isTradable(b));if(!b)return original;
 const extra:ExitPlan={signalDate:signal.date,exitDate:b.tradeDate,exitPrice:b.open,reason:'RESEARCH_'+signal.reason,timing:'OPEN'};
 if(!original||extra.exitDate<original.exitDate||(extra.exitDate===original.exitDate&&original.timing==='CLOSE'))return extra;
 return original;
}
export function etfAdditionalAt(symbol:string,entryDate:string,entryPrice:number,date:string){
 if(policy.id==='OFF')return null;
 const s=firstAdditionalSignal(symbol,entryDate,entryPrice);return s&&s.date===date?s.reason:null;
}

export function confirmIndexExit(symbol:string,date:string,exit:any){
 if(policy.id==='OFF'||(policy.confirm??1)===1)return exit;
 const prior=indexStreak.get(symbol);const consecutive=prior&&dateIndex.get(date)===(dateIndex.get(prior.date)??-2)+1;
 const n=exit==='MA60'?(consecutive?prior!.n+1:1):0;indexStreak.set(symbol,{date,n});
 return exit==='MA60'&&n<2?null:exit;
}
export function scaleBudget(value:bigint){return value*BigInt(Math.round((policy.exposureScale??1)*1000000))/1000000n;}
