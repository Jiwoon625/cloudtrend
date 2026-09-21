#!/usr/bin/env python3
"""Fixed seven risk overlays for the Priority size ablation; research only."""
import argparse,json,hashlib
from pathlib import Path
from collections import defaultdict
import numpy as np
import pandas as pd
from research_etf_m0_v01_improvements import Study,routes
from research_etf_m0_clean import save_json
from research_etf_m0_enhance import curve_stats

SPECS={
 'FIXED8':{'fixed':.8},
 'VOL20':{'vol20':True},
 'SECTOR30':{'sector30':True},
 'FAMILY2':{'family2':True},
 'ENTRY_REGIME':{},
 'DD_HALF10':{'ddhalf':True},
 'VOL20_SECTOR30':{'vol20':True,'sector30':True},
 'CORRELATED40':{'correlation40':True}}
DESIGN=dict(cutoff='2026-09-11',entry='M0 80 onset',exit='underlyingMA60 next open; no new exit',slots=10,
 score='Technical62.5 Priority7.5 Health15 Environment15; priority size removed and relative slot normalized to100; foreign relative remains disabled',
 candidates=SPECS,posthocFollowup='CORRELATED40 added only after the first seven fixed overlays and drawdown attribution; descriptive challenger, not eligible for adoption in this reused sample',
 definitions={'correlation40':'prior60 full aligned daily returns, Pearson>=0.8 with proposed ETF; sum related existing opening market value plus new entry <=40% equity; no force trim; no region restriction; missing60day history leaves pair unmatched, counted', 'fixed': '8% entry equity vs10%; cash control', 'vol20':'entry ticket10% times min(1,20%/annualized20day close-return sample volatility); frozen at entry, no rebalancing', 'sector30':'same region+mappedsector opening weight <=30% after new buys; partial entry allowed; no forced selling if drift above cap', 'family2':'maximum2 same economic index family positions', 'entryRegime':'signal-day underlying > MA60; reject onset, no delayed entry', 'ddhalf':'previous close NAV / running peak <0.9 then halve only new entries; no forced de-risk of held positions'},
 selection='Train and validation at both15/30bp: CAGR >= V01 +80% of positive NOSIZE-minus-V01 CAGR increment, Sharpe>V01, MDD>=NOSIZE and >=V01-3pp, >=25entries. Passing candidates tested20 paired order seeds: need12/20 preserve80%increment vspairedV01 with improvedSharpe and MDD>=NOSIZE and >=V01-3pp. Select validationSharpe among passers only. Otherwise retainV01.',
 dataUse='2017-2022 train,2023-2024 validation,2025-20260911 reused retrospective diagnostic; risk candidates motivated partly by inspected2026 drawdown; not independent OOS',
 limitations=['Current survivor universe','Dividend adjustments unverified','Current sector/name mapping, not point-in-time','Foreign Priority asymmetry remains','No grid; thresholds fixed before candidate returns computed'],productionDeployment=False)

class RiskStudy(Study):
    def __init__(self,d,out):
        super().__init__(d,out);self.attribution={};self.corr_cache={};self.corr_missing=set()
        cl=d.pivot(index='date',columns='symbol',values='close').sort_index();self.returns=cl.pct_change(fill_method=None).to_numpy();self.date_index={v:i for i,v in enumerate(cl.index)};self.symbol_index={v:i for i,v in enumerate(cl.columns)}
    def correlated(self,day,a,b):
        key=(day,*sorted([a,b]))
        if key not in self.corr_cache:
            j=self.date_index[day];x=self.returns[max(0,j-59):j+1,self.symbol_index[a]];y=self.returns[max(0,j-59):j+1,self.symbol_index[b]]
            if len(x)<60 or not np.isfinite(x).all() or not np.isfinite(y).all() or x.std()==0 or y.std()==0:
                self.corr_missing.add(key);self.corr_cache[key]=False
            else:self.corr_cache[key]=bool(np.corrcoef(x,y)[0,1]>=.8)
        return self.corr_cache[key]
    def risk_build(self,cid,priority,overlay=None,gate=None):
        self.build(cid,priority,self.d.healthClean,gate=gate)
        self.config[cid]['risk']=overlay or {}
        t=self.trades[cid].merge(self.d[['symbol','date','volAnnual']],left_on=['symbol','signalDate'],right_on=['symbol','date'],validate='many_to_one').drop(columns='date')
        self.trades[cid]=t;self.schedules[cid]={day:g.to_dict('records') for day,g in t.groupby('entryDate',sort=True)}
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
                cash-=amount;pnl[r['symbol']]-=amount;auditinfo[r['symbol']]=(r['mappedSectorCode'],r['region']);turn+=amount/opening;p=dict(r,units=amount/(r['entryOpen']*(1+cost)),last=r['entryOpen']);held[r['symbol']]=p;fills.append(dict(r,entryWeight=amount/opening,allocated=amount,riskFactor=factor))
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
    a=ap.parse_args();out=Path(a.output);out.mkdir(parents=True,exist_ok=True);base=Path(a.base);prior=Path(a.prior)
    save_json(out/'design.json',dict(DESIGN,inputHashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [base/'adopted-environment-panel.parquet',Path(a.clean)/'clean-input-panel.parquet',Path(a.mapping)]}))
    d=pd.read_parquet(base/'adopted-environment-panel.parquet').merge(pd.read_parquet(Path(a.clean)/'clean-input-panel.parquet')[['symbol','date','etfMarketCap','healthTv20']],on=['symbol','date'],validate='one_to_one')
    m=routes(pd.read_csv(a.mapping,dtype={'symbol':str},keep_default_na=False));d=d.merge(m[['symbol','duplicateFamily']],on='symbol',validate='many_to_one').sort_values(['symbol','date']).reset_index(drop=True)
    ret=d.groupby('symbol').close.pct_change(fill_method=None);d['volAnnual']=ret.groupby(d.symbol).transform(lambda x:x.rolling(20,min_periods=20).std())*np.sqrt(252)
    assert d.loc[d.eligible,'volAnnual'].gt(0).all();rel=(d.priorityTwo/50-d.etfMarketCap.ge(300e9)).round();assert rel.dropna().between(0,1).all()
    s=RiskStudy(d,out)
    for cid,pp in [('V01',d.priorityTwo),('NOSIZE',rel*100)]:s.risk_build(cid,pp);s.evaluate(cid)
    old=pd.read_csv(prior/'comparison.csv')
    for cid,oldid in [('V01','V01'),('NOSIZE','S3_DROP_PRIORITY_SIZE')]:
        for split,_,_ in s.spans:
            r=old[(old.candidate==oldid)&(old.scope=='all')&(old.split==split)&(old.costPerSide==.0015)].iloc[0]
            assert np.allclose([s.row(cid,split)[k] for k in ['cagr','mdd','sharpe']],r[['cagr','mdd','sharpe']].astype(float),atol=1e-10)
    for cid,overlay in SPECS.items():
        gate=d.etfUnderlyingIndexClose.gt(d.uMa60) if cid=='ENTRY_REGIME' else None
        s.risk_build(cid,rel*100,overlay,gate);s.evaluate(cid)
    audits=[];pre=[]
    for cid in SPECS:
        ok=True
        for cost in [.0015,.003]:
            for split in ['train','validation']:
                r=s.row(cid,split,cost);b=s.row('V01',split,cost);n=s.row('NOSIZE',split,cost);floor=b['cagr']+.8*max(n['cagr']-b['cagr'],0)
                checks=dict(retention=r['cagr']>=floor,sharpe=r['sharpe']>b['sharpe'],mddVsNoSize=r['mdd']>=n['mdd']-1e-10,mddVsV01=r['mdd']>=b['mdd']-.03-1e-10,entries=r['entries']>=25)
                audits.append(dict(candidate=cid,split=split,costPerSide=cost,cagrFloor=floor,**checks));ok &= all(checks.values())
        if ok:pre.append(cid)
    # All overlays get20 paired trials, to report risk and return tradeoffs even when a temporal gate failed.
    trials=[];wins={};summary=[]
    for seed in range(20):
        for cid in ['V01','NOSIZE']+list(SPECS):
            _,r,_=s.sim(cid,s.start,s.cal[-1],seed=seed);trials.append(dict(candidate=cid,seed=seed,**r))
    rr=pd.DataFrame(trials);rr.to_csv(out/'paired-order-trials.csv',index=False)
    b=rr[rr.candidate=='V01'].set_index('seed');n=rr[rr.candidate=='NOSIZE'].set_index('seed')
    for cid in SPECS:
        x=rr[rr.candidate==cid].set_index('seed');floor=b.cagr+.8*(n.cagr-b.cagr).clip(lower=0)
        ck=(x.cagr>=floor)&(x.sharpe>b.sharpe)&(x.mdd>=n.mdd-1e-10)&(x.mdd>=b.mdd-.03-1e-10);wins[cid]=int(ck.sum())
        summary.append(dict(candidate=cid,jointPasses=wins[cid],requiredPasses=12,returnRetentionPasses=int((x.cagr>=floor).sum()),mddImprovementVsNoSize=int((x.mdd>=n.mdd-1e-10).sum()),mddWithin3ppV01=int((x.mdd>=b.mdd-.03-1e-10).sum()),medianCagrDeltaNoSize=(x.cagr-n.cagr).median(),medianMddDeltaNoSize=(x.mdd-n.mdd).median(),medianCagr=x.cagr.median(),medianMdd=x.mdd.median()))
    pd.DataFrame(summary).to_csv(out/'paired-order-summary.csv',index=False);pd.DataFrame(audits).to_csv(out/'risk-selection-audit.csv',index=False)
    passed=[c for c in pre if wins[c]>=12 and c!='CORRELATED40'];pick=max(passed,key=lambda c:s.row(c,'validation')['sharpe']) if passed else 'V01'
    # Descriptive time-period and concentration attribution; additive currency P&L divided by peak equity, not trade averages.
    draw=[];contrib=[]
    for c in s.curves:
        cid=c.candidate.iloc[0];c=c.reset_index(drop=True);running=c.equity.cummax().clip(lower=1);dd=c.equity/running-1;i=int(dd.idxmin());prefix=c.iloc[:i+1];j=int(prefix.equity.idxmax()) if prefix.equity.max()>=1 else -1;peakday=c.date.iloc[j] if j>=0 else 'initial_cash';peakval=c.equity.iloc[j] if j>=0 else 1.;lo=c.date.iloc[i]
        q=s.attribution[cid];q=q[(q.date>peakday if j>=0 else q.date>=s.start)&q.date.le(lo)]
        assert np.isclose(q.pnl.sum()/peakval,dd.iloc[i],atol=1e-10)
        draw.append(dict(candidate=cid,peak=peakday,trough=lo,mdd=dd.iloc[i],peakEquity=peakval))
        for (region,sector),g in q.groupby(['region','sector']):contrib.append(dict(candidate=cid,region=region,sector=sector,contributionToDrawdown=g.pnl.sum()/peakval))
    pd.DataFrame(draw).to_csv(out/'drawdown-episodes.csv',index=False);pd.DataFrame(contrib).to_csv(out/'drawdown-contributions.csv',index=False)
    sens=[]
    for cid in ['V01','NOSIZE']+list(SPECS):
        for order in ['reverse','score','liquidity']:
            _,r,_=s.sim(cid,s.start,s.cal[-1],force_order=order);sens.append(dict(candidate=cid,order=order,**r))
    pd.DataFrame(sens).to_csv(out/'deterministic-order-sensitivity.csv',index=False);s.finish()
    save_json(out/'decision.json',dict(selected=pick,temporalPassers=pre,passed=passed,randomJointWins=wins,baselineReproduced=True,pnlAttributionReconciled=True,correlationPairsChecked=len(s.corr_cache),correlationPairsMissing60=len(s.corr_missing),posthocChallenger='CORRELATED40',productionDeployment=False))
    print(json.dumps({'selected':pick,'temporalPassers':pre,'passed':passed}),flush=True)
if __name__=='__main__':main()
