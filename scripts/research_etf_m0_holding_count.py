#!/usr/bin/env python3
"""Paired 5/10 holding-count study; fixed applied score, no weight search."""
import argparse, json, hashlib
from pathlib import Path
import numpy as np
import pandas as pd
from research_etf_m0_clean import events, save_json
from research_etf_m0_enhance import portfolio, curve_stats

def simulate(t, prices, cal, slots, cost, order='symbol', seed=0):
    rng=np.random.default_rng(seed); schedules={}
    for day,g in t.groupby('entryDate',sort=True):
        g=g.sort_values('symbol')
        if order=='reverse':g=g.iloc[::-1]
        elif order=='score':g=g.sort_values(['signalScore','symbol'],ascending=[False,True])
        elif order=='random':g=g.iloc[rng.permutation(len(g))]
        schedules[day]=list(g.to_dict('records'))
    held={};cash=1.;rows=[];fills=[];turn=0.;blocked=0
    for day in cal:
        quote=lambda s,f,last:prices.get((s,day),{}).get(f,last)
        for s,p in list(held.items()):
            if p['exitDate']==day:
                cash+=p['units']*p['exitOpen']*(1-cost);del held[s]
        opening=cash+sum(p['units']*quote(s,'open',p['last']) for s,p in held.items())
        for r in schedules.get(day,[]):
            if r['symbol'] in held:continue
            if len(held)>=slots:blocked+=1;continue
            amount=min(opening/slots,cash)
            if amount<1e-10:continue
            cash-=amount;turn+=amount/opening
            held[r['symbol']]=dict(r,units=amount/(r['entryOpen']*(1+cost)),last=r['entryOpen'])
            fills.append(dict(r,allocated=amount,entryWeight=amount/opening))
        for s,p in held.items():p['last']=quote(s,'close',p['last'])
        value=cash+sum(p['units']*p['last'] for p in held.values())
        weights=[p['units']*p['last']/value for p in held.values()]
        rows.append((day,value,(value-cash)/value,len(held),max(weights,default=0.)))
    c=pd.DataFrame(rows,columns=['date','equity','exposure','positions','largestWeight'])
    stats=dict(**curve_stats(c),entries=len(fills),averagePositions=c.positions.mean(),averageLargestWeight=c.largestWeight.mean(),maxLargestWeight=c.largestWeight.max(),annualEntryTurnover=turn/(len(cal)/252),blockedEvents=blocked)
    return c,stats,pd.DataFrame(fills)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--base',required=True);ap.add_argument('--output',required=True);a=ap.parse_args();base=Path(a.base);out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
    source=base/'adopted-environment-panel.parquet'
    design=dict(sourceRun=35567515449,sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),weights=[62.5,7.5,15,15],slots=[5,10],costPerSide=[.0015,.003],cutoff='2026-09-11',randomSeeds=list(range(100)),randomization='Same-day candidate order, paired between slots; not future-return confidence intervals',primaryOrder='symbol ascending; frozen existing engine',entry='M0 80 onset next open',exit='underlying MA60 next open',allocation='1/slots opening equity per new entry; cash constrained; no rebalance; no forced fill',selection='Compare paired full-period return/risk, reset subperiods, costs, continuous calendar years and order sensitivity; do not optimize score or choose best seed',limitations=['Current-survivor universe','Reused historical data, not fresh holdout','Current weight was selected under 10 slots; conditional model comparison'])
    save_json(out/'design.json',design)
    d=pd.read_parquet(source).sort_values(['symbol','date']);d['onset']=d.onsetApplied
    start=d.loc[d.eligible,'date'].min();cal=sorted(d.loc[d.date>=start,'date'].unique());assert cal[-1]=='2026-09-11'
    t=events(d,'P7.5',start).merge(d[['symbol','date','m0Applied']],left_on=['symbol','signalDate'],right_on=['symbol','date'],validate='many_to_one').rename(columns={'m0Applied':'signalScore'}).drop(columns='date')
    prices={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d[['symbol','date','open','close']].itertuples(index=False)}
    spans=[('all',start,cal[-1]),('train',start,'2022-12-31'),('validation','2023-01-01','2024-12-31'),('test','2025-01-01',cal[-1]),('legacy_window','2018-01-01',cal[-1])]
    rows=[];curves=[];annual=[];fills=[]
    for order in ['symbol','reverse','score']:
        for cost in [.0015,.003]:
            for split,begin,end in spans:
                q=t[(t.signalDate>=begin)&(t.entryDate<=end)];cc=[x for x in cal if begin<=x<=end]
                for slots in [5,10]:
                    c,s,f=simulate(q,prices,cc,slots,cost,order);rows.append(dict(order=order,costPerSide=cost,split=split,slots=slots,**s))
                    if order=='symbol' and cost==.0015 and split=='all':
                        ref=portfolio(q,prices,cc,slots=slots,cost=cost);assert np.allclose(c.equity,ref.equity,rtol=1e-12,atol=1e-12)
                        old=pd.read_csv(base/'sensitivity.csv');old=old[(old.candidate=='P7.5')&(old.split=='all')&(old.slots==slots)&(old.costPerSide==cost)].iloc[0]
                        assert np.allclose([s[k] for k in ['cagr','mdd','sharpe']],old[['cagr','mdd','sharpe']].astype(float),atol=1e-10)
                        c['slots']=slots;curves.append(c);f['slots']=slots;fills.append(f)
                        r=c.equity.pct_change();r.iloc[0]=c.equity.iloc[0]-1
                        for year,idx in c.groupby(c.date.str[:4]).groups.items():annual.append(dict(slots=slots,year=year,returnNet=float((1+r.loc[idx]).prod()-1),partialYear=year=='2026'))
    pd.DataFrame(rows).to_csv(out/'comparison.csv',index=False);pd.concat(curves).to_csv(out/'portfolio-curves.csv.gz',index=False);pd.DataFrame(annual).to_csv(out/'annual-returns.csv',index=False);pd.concat(fills).to_csv(out/'executed-trades.csv',index=False)
    random=[]
    for seed in range(100):
        for slots in [5,10]:
            _,s,_=simulate(t,prices,cal,slots,.0015,'random',seed);random.append(dict(seed=seed,slots=slots,**s))
    rr=pd.DataFrame(random);rr.to_csv(out/'random-order-sensitivity.csv',index=False)
    paired=rr[rr.slots==10].set_index('seed')[['cagr','mdd','sharpe']]-rr[rr.slots==5].set_index('seed')[['cagr','mdd','sharpe']]
    paired.to_csv(out/'paired-random-differences.csv')
    decision=dict(baselineReproduced=True,randomTrials=100,tenWins={k:int((paired[k]>0).sum()) for k in paired},jointWins=int((paired>0).all(axis=1).sum()),medianDifference=paired.median().to_dict(),productionDeployment=False)
    save_json(out/'decision.json',decision);print(json.dumps(decision),flush=True)
if __name__=='__main__':main()
