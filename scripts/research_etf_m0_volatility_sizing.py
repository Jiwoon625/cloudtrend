#!/usr/bin/env python3
"""Sharpe-first entry volatility sizing study, fixed size-deleted score."""
import argparse,json,hashlib
from pathlib import Path
from collections import defaultdict
import numpy as np
import pandas as pd
from research_etf_m0_size_risk import RiskStudy
from research_etf_m0_v01_improvements import routes
from research_etf_m0_clean import save_json
from research_etf_m0_enhance import curve_stats

CANDIDATES={f'STD{w}_T{int(t*100)}':dict(window=w,target=t,power=1.,method='std') for w in [20,40,60] for t in [.15,.20,.25]}
CANDIDATES.update(EWM20_T20=dict(window=20,target=.20,power=1.,method='ewm'),STD20_T20_P05=dict(window=20,target=.20,power=.5,method='std'),STD20_T20_P2=dict(window=20,target=.20,power=2.,method='std'))
DESIGN=dict(cutoff='2026-09-11',score='Priority SIZE point removed, remaining relative slot normalized; NOT entire Priority block deletion',weights=[62.5,7.5,15,15],
 entry='M0 80 Onset; next open',exit='underlying MA60 next open',maxPositions=10,costs=[.0015,.003],
 candidates=CANDIDATES,controls=['V01','NOSIZE','FIXED5'],
 sizing='0.10 * min(1,(target/annualized_volatility)^power); at entry only, no rebalance; remaining cash zero interest',
 volatility='trailing adjusted-close simple return sample std*sqrt252; EWM span20 adjustFalse biasFalse min20. Same history mask for comparison; complete trailing20/40/60 data verified on all eligible rows.',
 objective='User changed objective from retention of80%return uplift to Sharpe first then shallower drawdown. No retuning entry or exit.',
 selection='Only2017-2022 train and2023-2024 validation: positive CAGR/Sharpe and>=25fills in each at15/30bp. Average train/validation Sharpe at15bp: shortlist within0.03ofhighest. Pick maximum worst(trainMDD,valMDD) then maximum worst30bpMDD then meanSharpe. 2025+ and full period descriptive only.',
 tieTolerance=[.02,.03,.05],randomSeeds=list(range(20)),integerCapitals=[10000000,50000000,100000000],
 limitations=['reused history, not independent OOS','survivor universe/current metadata','adjusted prices/dividends unresolved','integer-share test uses adjusted historical prices, indicative not exact corporate-action ledger','foreign Priority relative slot remains disabled'],
 productionDeployment=False)

class SizingStudy(RiskStudy):
    pass
    def sim(self,cid,begin,end,scope='all',cost=.0015,seed=None,force_order=None):
        cfg=self.config[cid];risk=cfg.get('risk',{});ledger=[];peak=1.;prevnav=1.;order=force_order or cfg['order'];held={};cash=1.;rows=[];fills=[];blockedcap=0;blockedslots=0;turn=0
        dates=[x for x in self.cal if begin<=x<=end]
        for day in dates:
            pnl=defaultdict(float,{sym:-x['units']*x['last'] for sym,x in held.items()})
            auditinfo={sym:(x['mappedSectorCode'],x['region']) for sym,x in held.items()}
            quote=lambda s,f,last:self.prices.get((s,day),{}).get(f,last)
            for sym,p in list(held.items()):
                if p['exitDate']==day:
                    proceeds=p['units']*p['exitOpen']*(1-cost);cash+=proceeds;pnl[sym]+=proceeds;del held[sym]
            opening=cash+sum(p['units']*quote(s,'open',p['last']) for s,p in held.items())
            q=[r for r in self.schedules[cid].get(day,[]) if r['signalDate']>=begin and (scope=='all' or (r['region']=='KR')==(scope=='domestic'))]
            rank=lambda r: hashlib.sha256(f'{seed}|{day}|{r["symbol"]}'.encode()).hexdigest() if seed is not None else r['symbol']
            if order=='liquidity':q=sorted(q,key=lambda r:(-r['healthTv20'],rank(r)))
            elif order=='reverse':q=sorted(q,key=lambda r:r['symbol'],reverse=True)
            elif order=='score':q=sorted(q,key=lambda r:(-r['signalScore'],rank(r)))
            else:q=sorted(q,key=rank)
            for r in q:
                if r['symbol'] in held:continue
                if risk.get('family2') and sum(x['duplicateFamily']==r['duplicateFamily'] for x in held.values())>=2:blockedcap+=1;continue
                if cfg['cap'] and any(p['duplicateFamily']==r['duplicateFamily'] for p in held.values()):blockedcap+=1;continue
                if len(held)>=10:blockedslots+=1;continue
                factor=risk.get('fixed',1.)
                if risk.get('vol20'):factor*=min(1.,.20/r['volAnnual'])
                if risk.get('ddhalf') and prevnav/peak-1<-.10:factor*=.5
                amount=min(opening/10*factor,cash)
                if risk.get('sector30'):
                    sector=r['region']+'|'+r['mappedSectorCode']
                    current=sum(x['units']*quote(sym,'open',x['last']) for sym,x in held.items() if x['region']+'|'+x['mappedSectorCode']==sector)
                    amount=min(amount,max(0.,opening*.30-current))
                if risk.get('correlation40'):
                    related=sum(x['units']*quote(sym,'open',x['last']) for sym,x in held.items() if self.correlated(r['signalDate'],r['symbol'],sym))
                    amount=min(amount,max(0.,opening*.40-related))
                if amount<1e-10:continue
                capital=risk.get('roundCapital')
                units=amount/(r['entryOpen']*(1+cost))
                if capital:
                    units=np.floor(units*capital)/capital
                    if units<=0:continue
                    amount=units*r['entryOpen']*(1+cost)
                cash-=amount;pnl[r['symbol']]-=amount;auditinfo[r['symbol']]=(r['mappedSectorCode'],r['region']);turn+=amount/opening;p=dict(r,units=units,last=r['entryOpen']);held[r['symbol']]=p;fills.append(dict(r,entryWeight=amount/opening,allocated=amount,riskFactor=factor))
            for s,p in held.items():p['last']=quote(s,'close',p['last'])
            value=cash+sum(p['units']*p['last'] for p in held.values());fw=defaultdict(float);sw=defaultdict(float)
            for p in held.values():fw[p['duplicateFamily']]+=p['units']*p['last']/value;sw[p['mappedSectorCode']]+=p['units']*p['last']/value
            for sym,x in held.items():pnl[sym]+=x['units']*x['last']
            assert abs(sum(pnl.values())-(value-prevnav))<1e-10
            if scope=='all' and begin==self.start and end==self.cal[-1] and cost==.0015 and seed is None and force_order is None:
                ledger.extend(dict(date=day,symbol=sym,pnl=delta,sector=auditinfo[sym][0],region=auditinfo[sym][1]) for sym,delta in pnl.items())
            prevnav=value;peak=max(peak,value)
            if risk.get('family2'):assert max([sum(x['duplicateFamily']==f for x in held.values()) for f in fw],default=0)<=2
            if cfg['cap']:assert len(fw)==len(held)
            assert cash>=-1e-10 and len(held)<=10
            rows.append((day,value,(value-cash)/value,len(held),len(fw),max(fw.values(),default=0),max(sw.values(),default=0),len(held)>len(fw)))
        c=pd.DataFrame(rows,columns=['date','equity','exposure','positions','families','largestFamilyWeight','largestSectorWeight','duplicateHeld'])
        s=dict(**curve_stats(c),entries=len(fills),meanPositions=c.positions.mean(),meanFamilies=c.families.mean(),duplicateDays=int(c.duplicateHeld.sum()),maxFamilyWeight=c.largestFamilyWeight.max(),meanLargestFamilyWeight=c.largestFamilyWeight.mean(),meanLargestSectorWeight=c.largestSectorWeight.mean(),blockedFamilyEvents=blockedcap,blockedSlotEvents=blockedslots,annualEntryTurnover=turn/(len(c)/252),dataErrorExits=sum(r['reason']=='data_unavailable' and r['exitDate']<=end for r in fills))
        if ledger:self.attribution[cid]=pd.DataFrame(ledger)
        return c,s,pd.DataFrame(fills)

def main():
    ap=argparse.ArgumentParser()
    for k in ['base','clean','prior','mapping','output']:ap.add_argument('--'+k,required=True)
    a=ap.parse_args();out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
    save_json(out/'design.json',DESIGN)
    base=Path(a.base);source=base/'adopted-environment-panel.parquet'
    d=pd.read_parquet(source).merge(pd.read_parquet(Path(a.clean)/'clean-input-panel.parquet')[['symbol','date','etfMarketCap','healthTv20']],on=['symbol','date'],validate='one_to_one')
    m=routes(pd.read_csv(a.mapping,dtype={'symbol':str},keep_default_na=False))
    d=d.merge(m[['symbol','duplicateFamily']],on='symbol',validate='many_to_one').sort_values(['symbol','date']).reset_index(drop=True)
    ret=d.groupby('symbol').close.pct_change(fill_method=None);vols={}
    for w in [20,40,60]:
        vols['std'+str(w)]=ret.groupby(d.symbol).transform(lambda x:x.rolling(w,min_periods=w).std())*np.sqrt(252)
    vols['ewm20']=ret.groupby(d.symbol).transform(lambda x:x.ewm(span=20,adjust=False,min_periods=20).std(bias=False))*np.sqrt(252)
    assert all(v[d.eligible].notna().all() and v[d.eligible].gt(0).all() for v in vols.values())
    d['volAnnual']=vols['std20'];rel=(d.priorityTwo/50-d.etfMarketCap.ge(300e9)).round();assert rel.dropna().between(0,1).all()
    s=SizingStudy(d,out)
    for cid,p,overlay in [('V01',d.priorityTwo,{}),('NOSIZE',rel*100,{}),('FIXED5',rel*100,{'fixed':.5})]:
        s.risk_build(cid,p,overlay);s.evaluate(cid)
    for cid,spec in CANDIDATES.items():
        sigma=vols[spec['method']+str(spec['window'])]
        factor=(spec['target']/sigma).pow(spec['power']).clip(upper=1)
        # Existing tested engine multiplies entry by min(1,.20/volAnnual).
        # This encoded column reproduces the requested factor; actual sigma is separately exported.
        s.d['volAnnual']=.20/factor
        s.risk_build(cid,rel*100,{'vol20':True});s.config[cid]['sizingSpec']=spec
        t=s.trades[cid].merge(pd.DataFrame({'symbol':d.symbol,'signalDate':d.date,'measuredAnnualVol':sigma,'targetEntryWeight':.1*factor}),on=['symbol','signalDate'],validate='many_to_one')
        s.trades[cid]=t;s.schedules[cid]={day:g.to_dict('records') for day,g in t.groupby('entryDate',sort=True)}
        s.evaluate(cid)
    old=pd.read_csv(Path(a.prior)/'comparison.csv')
    for cid,oldid in [('V01','V01'),('NOSIZE','NOSIZE'),('STD20_T20','VOL20')]:
        for split,_,_ in s.spans:
            for cost in [.0015,.003]:
                r=old[(old.candidate==oldid)&(old.scope=='all')&(old.split==split)&(old.costPerSide==cost)].iloc[0]
                assert np.allclose([s.row(cid,split,cost)[k] for k in ['cagr','mdd','sharpe']],r[['cagr','mdd','sharpe']].astype(float),atol=1e-10)
    rank=[]
    for cid in CANDIDATES:
        a0=s.row(cid,'train');b0=s.row(cid,'validation');a1=s.row(cid,'train',.003);b1=s.row(cid,'validation',.003)
        ok=all(r['cagr']>0 and r['sharpe']>0 and r['entries']>=25 for r in [a0,b0,a1,b1])
        rank.append(dict(candidate=cid,eligible=ok,meanSharpe=(a0['sharpe']+b0['sharpe'])/2,worstMdd=min(a0['mdd'],b0['mdd']),worstStressMdd=min(a1['mdd'],b1['mdd'])))
    r=pd.DataFrame(rank);best=r[r.eligible].meanSharpe.max()
    choices=[]
    for tol in [.02,.03,.05]:
        near=r[r.eligible&r.meanSharpe.ge(best-tol)].sort_values(['worstMdd','worstStressMdd','meanSharpe','candidate'],ascending=[False,False,False,True])
        choices.append(dict(tolerance=tol,selected=near.iloc[0].candidate,shortlist=list(near.candidate)))
    pick=next(x['selected'] for x in choices if x['tolerance']==.03)
    r['withinPrimarySharpeBand']=r.eligible&r.meanSharpe.ge(best-.03);r.to_csv(out/'selection-ranking.csv',index=False)
    save_json(out/'selection-tolerance.json',choices)
    # Validate all grid settings under matched order ranks; selection remains frozen.
    trials=[]
    for seed in range(20):
        for cid in ['V01','NOSIZE','FIXED5']+list(CANDIDATES):
            _,stats,_=s.sim(cid,s.start,s.cal[-1],seed=seed);trials.append(dict(candidate=cid,seed=seed,**stats))
    rr=pd.DataFrame(trials);rr.to_csv(out/'order-trials.csv',index=False)
    ref=rr[rr.candidate=='STD20_T20'].set_index('seed');random_summary=[]
    for cid in CANDIDATES:
        q=rr[rr.candidate==cid].set_index('seed')
        random_summary.append(dict(candidate=cid,medianSharpe=q.sharpe.median(),medianMdd=q.mdd.median(),medianCagr=q.cagr.median(),sharpeWithin003OfAnchor=int((q.sharpe>=ref.sharpe-.03).sum()),mddNoWorseThanAnchor=int((q.mdd>=ref.mdd-1e-10).sum()),jointAnchor=int(((q.sharpe>=ref.sharpe-.03)&(q.mdd>=ref.mdd-1e-10)).sum())))
    pd.DataFrame(random_summary).to_csv(out/'order-summary.csv',index=False)
    rounds=[]
    for cid in dict.fromkeys([pick,'STD20_T20','V01']):
        for capital in [10000000,50000000,100000000]:
            s.config[cid]['risk']['roundCapital']=capital
            for split,begin,end in s.spans[:4]:
                for cost in [.0015,.003]:
                    _,stats,_=s.sim(cid,begin,end,cost=cost)
                    rounds.append(dict(candidate=cid,capital=capital,split=split,costPerSide=cost,**stats))
            s.config[cid]['risk'].pop('roundCapital')
    pd.DataFrame(rounds).to_csv(out/'integer-share-sensitivity.csv',index=False)
    orders=[]
    for cid in dict.fromkeys([pick,'STD20_T20','V01']):
        for order in ['reverse','score','liquidity']:
            _,stats,_=s.sim(cid,s.start,s.cal[-1],force_order=order);orders.append(dict(candidate=cid,order=order,**stats))
    pd.DataFrame(orders).to_csv(out/'deterministic-order-sensitivity.csv',index=False)
    s.finish()
    cfg=dict(status='research_sizing_candidate_selected_pending_operational_confirmation',selected=pick,sizing=CANDIDATES[pick],
        priority='remove size point only; relative slot remains',baseWeight=.10,maximumPositions=10,entry=DESIGN['entry'],exit=DESIGN['exit'],
        formula='budget=min(cash,equity*0.10*min(1,(target/sigma)^power)); integer_qty=floor(budget/(order_price*(1+cost_buffer)))',
        missingVolatility='do not calculate order when insufficient/nonfinite history; show input warning',priceHandling='estimated order price; recalculate against actual available cash and order price; no use of unknown next-open price at signal time',
        rebalance=False,productionDeployment=False,sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest())
    save_json(out/'proposed-sizing-policy.json',cfg)
    result=dict(selected=pick,highestMeanSharpe=float(best),toleranceDecisions=choices,baselineReproduced=True,productionDeployment=False)
    save_json(out/'decision.json',result)
    print('FINAL_DECISION '+json.dumps(result),flush=True)
    metrics=[s.row(cid,'all') for cid in ['V01','NOSIZE','FIXED5']+list(CANDIDATES)]
    print('FULL_METRICS '+json.dumps([{k:x[k] for k in ['candidate','cagr','mdd','sharpe','exposure']} for x in metrics]),flush=True)
    print('RANKING '+r.to_json(orient='records'),flush=True)
    print('ORDER_SUMMARY '+json.dumps(random_summary),flush=True)
    print('SELECTED_SPLITS '+json.dumps([s.row(pick,x) for x in ['train','validation','test','all']]),flush=True)
    print('INTEGER_SUMMARY '+json.dumps([x for x in rounds if x['split']=='all' and x['costPerSide']==.0015]),flush=True)
if __name__=='__main__':main()
