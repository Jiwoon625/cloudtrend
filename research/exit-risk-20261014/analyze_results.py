import json,sys,gzip,math
from pathlib import Path
import numpy as np,pandas as pd
R=Path(__file__).resolve().parent
def lines(p):return [json.loads(x)for x in p.read_text().splitlines()if x]
def clean(v):
 if isinstance(v,dict):return {k:clean(x)for k,x in v.items()}
 if isinstance(v,list):return [clean(x)for x in v]
 if isinstance(v,(np.integer,)):return int(v)
 if isinstance(v,(np.floating,float)):return float(v)if math.isfinite(v)else None
 return v
def lifecycle(market,p):
 ts=lines(p/'trades.jsonl');out=[]
 if market=='KOSPI':
  partial=json.loads((p/'partial-fills.json').read_text());ps={x['id']:x for x in partial}
  for t in ts:
   x=ps.get(t['id']);basis=float(x['initialBasis'])if x else t['buyAmount']+t['entryFee'];q=x['initialShares']if x else t['shares'];partialCredit=float(x['gross'])-float(x['fee'])if x else 0
   credit=(t['shares']*t['exitPrice']-t['exitFee']if t['exitDate']else 0)+partialCredit
   out.append(dict(symbol=t['symbol'],name=t['name'],entry=t['entryDate'],exit=t['exitDate'],entryPrice=t['entryPrice'],exitPrice=t['exitPrice'],signalDate=t['exitSignalDate'],basis=basis,quantity=q,pnl=credit-basis if t['exitDate']else None,returnNet=credit/basis-1 if t['exitDate']else None,reason=t['exitReason'],partial=bool(x)))
 else:
  active={}
  for f in ts:
   s=f['symbol'];q=int(f['quantity']);px=float(f['price'])
   if f['side']=='BUY':active[s]=dict(symbol=s,name=s,entry=f['executionDate'],exit=None,entryPrice=px,basis=-float(f['cashDelta']),quantity=q,remaining=q,credit=0,partial=False)
   else:
    t=active[s];t['remaining']-=q;t['credit']+=float(f['cashDelta']);t['partial']|=t['remaining']>0
    if t['remaining']==0:
     t.update(exit=f['executionDate'],exitPrice=px,signalDate=f['signalDate'],reason=f.get('researchReason',f['reason']),pnl=t['credit']-t['basis'],returnNet=t['credit']/t['basis']-1);out.append(t);del active[s]
  out.extend(active.values())
 return out
def stats(nav,initial=1e8):
 nav=nav.copy();v=nav.nav.astype(float).to_numpy();n=len(v)
 if not n:return {}
 before=nav.attrs.get('prior',initial);ret=v/np.r_[before,v[:-1]]-1
 equity=np.r_[before,v];peak=np.maximum.accumulate(equity);dd=equity/peak-1
 years=(pd.Timestamp(nav.date.iloc[-1])-pd.Timestamp(nav.attrs.get('priorDate',nav.date.iloc[0]))).days/365.2425
 cagr=(v[-1]/before)**(1/max(years,1/365.2425))-1
 vol=np.std(ret,ddof=1)*np.sqrt(252)if n>1 else 0;sharpe=np.mean(ret)/np.std(ret,ddof=1)*np.sqrt(252)if vol>0 else 0
 longest=cur=0
 for d in dd[1:]:cur=cur+1 if d<0 else 0;longest=max(longest,cur)
 trough=int(np.argmin(dd));peak_i=int(np.argmax(equity[:trough+1]));recovers=np.where(equity[trough+1:]>=equity[peak_i])[0];recovery_i=int(trough+1+recovers[0])if len(recovers)else None
 date_ext=[nav.attrs.get('priorDate',nav.date.iloc[0])]+nav.date.tolist()
 return dict(cumulative=v[-1]/before-1,cagr=cagr,mdd=float(dd.min()),sharpe=sharpe,calmar=cagr/-dd.min()if dd.min()<0 else None,volatility=vol,cashWeight=float(np.mean(nav.cash.astype(float)/v)),observations=n,underwaterMaxSessions=longest,terminalUnderwaterSessions=cur,maxDrawdownPeakDate=date_ext[peak_i],maxDrawdownTroughDate=date_ext[trough],maxDrawdownRecoveryDate=date_ext[recovery_i]if recovery_i is not None else None,maxDrawdownRecoverySessions=recovery_i-peak_i if recovery_i is not None else None)
def analyze(market):
 allstats={};periods={};lives={};curves={}
 for p in sorted((R/'results'/market).iterdir()):
  if not(p/'COMPLETE.json').exists():continue
  if json.loads((p/'COMPLETE.json').read_text())['policy'].get('smoke'):continue
  ident=p.name;nav=pd.DataFrame(lines(p/'nav.jsonl'));nav['nav']=nav.nav.astype(float);nav['cash']=nav.cash.astype(float);curves[ident]=nav
  tr=lifecycle(market,p);lives[ident]=tr;closed=[t for t in tr if t.get('exit')];rs=np.array([t['returnNet']for t in closed]);wins=rs[rs>0];loss=rs[rs<0]
  k=stats(nav);streak=longest=0
  for t in sorted(closed,key=lambda t:t['exit']):streak=streak+1 if t['pnl']<0 else 0;longest=max(longest,streak)
  k.update(closedTrades=len(closed),buys=len(tr),winRate=float(np.mean(rs>0))if len(rs)else None,tradeMean=float(rs.mean())if len(rs)else None,tradeMedian=float(np.median(rs))if len(rs)else None,payoff=float(wins.mean()/-loss.mean())if len(wins)and len(loss)else None,profitFactor=sum(max(0,t['pnl'])for t in closed)/max(1e-12,-sum(min(0,t['pnl'])for t in closed)),worstTrade=float(rs.min())if len(rs)else None,consecutiveLosses=longest,averageHoldingDays=float(np.mean([(pd.Timestamp(t['exit'])-pd.Timestamp(t['entry'])).days for t in closed]))if closed else None,totalFees=sum(float(f.get('fee',0))for f in lines(p/'trades.jsonl'))if market=='ETF'else sum(t['entryFee']+t['exitFee']for t in lines(p/'trades.jsonl'))+sum(float(x['fee'])+float(x['initialFee'])-float(x['initialFee'])*(x['initialShares']-x['shares'])/x['initialShares']for x in json.loads((p/'partial-fills.json').read_text())),proxyExits=sum('모델 가정' in str(t.get('reason'))or t.get('reason')=='MODEL_UNOBSERVED'for t in closed))
  gaps=[]
  for sym in set(t['symbol']for t in tr):
   seq=sorted([t for t in tr if t['symbol']==sym],key=lambda t:t['entry'])
   gaps.extend((pd.Timestamp(b['entry'])-pd.Timestamp(a['exit'])).days for a,b in zip(seq,seq[1:])if a.get('exit'))
  k['reentryDaysMean']=float(np.mean(gaps))if gaps else None
  years=(pd.Timestamp(nav.date.iloc[-1])-pd.Timestamp(nav.attrs.get('priorDate',nav.date.iloc[0]))).days/365.2425
  k['annualTwoSidedTurnover']=sum((t['basis']+(t['pnl']+t['basis']if t.get('pnl')is not None else 0))for t in tr)/nav.nav.mean()/years
  allstats[ident]=k;periods[ident]={}
  spans={'2018-2024':('2018-01-01','2024-12-31'),'2025':('2025-01-01','2025-12-31'),'2026':('2026-01-01','2026-12-31'),'development_2018_2022':('2018-01-01','2022-12-31'),'validation_reused_2023_2024':('2023-01-01','2024-12-31')}
  spans.update({str(y):(f'{y}-01-01',f'{y}-12-31')for y in range(2017,2027)})
  for label,(lo,hi)in spans.items():
   sub=nav[(nav.date>=lo)&(nav.date<=hi)].copy()
   if sub.empty:continue
   ix=sub.index[0];sub.attrs['prior']=nav.nav.iloc[ix-1]if ix else 1e8;sub.attrs['priorDate']=nav.date.iloc[ix-1]if ix else nav.date.iloc[0];periods[ident][label]=stats(sub)
  (p/'lifecycle.json').write_text(json.dumps(clean(tr),ensure_ascii=False))
 base='K0'if market=='KOSPI'else'E0';base=base if base in lives else 'OFF';bt={t['symbol']+'|'+t['entry']:t for t in lives[base]}
 paired={}
 for ident,tr in lives.items():
  pairs=[]
  for t in tr:
   b=bt.get(t['symbol']+'|'+t['entry'])
   if b and b.get('exit')and t.get('exit'):
    pairs.append(dict(symbol=t['symbol'],entry=t['entry'],baseExit=b['exit'],candidateExit=t['exit'],deltaReturn=t['returnNet']-b['returnNet'],earlier=t['exit']<b['exit'],baseReturn=b['returnNet'],candidateReturn=t['returnNet'],baseExitPrice=b['exitPrice'],candidateExitPrice=t['exitPrice'],deltaFixedBaselineWon=(t['returnNet']-b['returnNet'])*b['basis']))
  early=[x for x in pairs if x['earlier']]
  paired[ident]=dict(matched=len(pairs),unmatched=len(tr)-len(pairs),deltaMean=float(np.mean([x['deltaReturn']for x in pairs]))if pairs else None,earlyCount=len(early),avoidedLossFixedBaselineWon=sum(max(0,x['deltaFixedBaselineWon'])for x in early),missedRiseFixedBaselineWon=sum(max(0,-x['deltaFixedBaselineWon'])for x in early),avoidedLossSumReturnPoints=sum(max(0,x['deltaReturn'])for x in early),missedRiseSumReturnPoints=sum(max(0,-x['deltaReturn'])for x in early),newEntryKeys=len(set(t['symbol']+'|'+t['entry']for t in tr)-set(bt)))
  (R/'results'/market/ident/'paired.json').write_text(json.dumps(clean(pairs),ensure_ascii=False))
  # Leave-one-year-out is arithmetic re-linking of the continuous path, never a fresh OOS.
  nav=curves[ident];ret=nav.nav.to_numpy()/np.r_[1e8,nav.nav.to_numpy()[:-1]]-1
  loyo={}
  for year in range(2018,2027):
   keep=~nav.date.str.startswith(str(year)).to_numpy();rr=ret[keep];vv=np.cumprod(1+rr);dd=vv/np.maximum.accumulate(np.r_[1,vv])[1:]-1
   loyo[str(year)]=dict(cumulative=float(vv[-1]-1),annualized252=float(vv[-1]**(252/len(vv))-1),mdd=float(dd.min()),sharpe=float(rr.mean()/rr.std(ddof=1)*np.sqrt(252)))
  periods[ident]['leave_one_year_out_relinked']=loyo
 result=clean(dict(market=market,all=allstats,periods=periods,paired=paired,selectionNote='All historical years reused; no untouched OOS. Annual and LOYO are continuous-path attribution, not reset-account backtests.'))
 (R/'results'/market/'analysis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result['all'],ensure_ascii=False,indent=2));return result
if __name__=='__main__':analyze(sys.argv[1])
