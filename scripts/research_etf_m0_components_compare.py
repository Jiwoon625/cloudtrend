#!/usr/bin/env python3
"""Predeclared component comparisons, with raw-field gates at signal close."""
import argparse,json
from pathlib import Path
import numpy as np
import pandas as pd
from research_etf_m0_enhance import build_open_trades,portfolio,curve_stats


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--results',required=True);ap.add_argument('--components',required=True);a=ap.parse_args()
    root=Path(a.results);out=Path(a.components);raw=pd.read_parquet(out/'component-panel.parquet');old=pd.read_parquet(root/'scored-panel.parquet')
    d=old.merge(raw,on=['symbol','date'],how='inner',suffixes=('','_raw'),validate='one_to_one').sort_values(['symbol','date']).reset_index(drop=True)
    meta=pd.read_csv(root/'classification.csv',dtype={'symbol':str});expected=old[old.symbol.isin(meta.loc[meta.assetClass=='equity','symbol'])]
    assert len(d)==len(expected),'Raw and baseline universes differ'
    for k in ['priorityM0','health','continuousM0','close']:
        assert np.allclose(d[k],d[k+'_raw'],equal_nan=True,rtol=1e-12,atol=1e-10),f'Baseline drift: {k}'
    d['T']=(d.continuousM0-.15*(d.priorityM0+d.health+d.marketSectorScore))/.55
    cal=sorted(d.loc[d.date>='2018-01-01','date'].unique());spans=[('train','2018-01-01','2022-12-31'),('validation','2023-01-01','2024-12-31'),('test','2025-01-01',cal[-1]),('all','2018-01-01',cal[-1])]
    # Each change is isolated. No threshold tuning. The no-H alternatives preserve total scale by /0.85.
    specs=[dict(id='BASE')]
    specs += [dict(id='P_ZERO_'+c,pZero=c) for c in ['Size','Relative','Rotation']]
    specs += [dict(id='P_ACTIVE_NORMALIZE',pNormalize=True),dict(id='P_ETF_CAP',pCap=True),dict(id='P_UNDERLYING_REL',pUnderlying=True)]
    specs += [dict(id='H_DROP_'+c,hDrop=c) for c in ['Aum','Liquidity','Premium']]
    gates=[('TV1',dict(tv=1e9)),('TV3',dict(tv=3e9)),('AUM50',dict(aum=50e9)),('AUM50_TV1',dict(aum=50e9,tv=1e9)),('AUM50_TV1_PD1',dict(aum=50e9,tv=1e9,premium=1.)),('AUM100_TV3_PD05',dict(aum=100e9,tv=3e9,premium=.5))]
    specs += [dict(id='GATE_'+name,gate=g) for name,g in gates]
    specs += [dict(id='NOH_'+name,gate=g,noH=True) for name,g in gates if name in ['TV1','TV3','AUM50_TV1','AUM50_TV1_PD1']]
    design=dict(specs=specs,selection='Candidate must improve CAGR and Sharpe in BOTH train and validation; MDD no more than 3pp worse; at least 25 complete matched events in each. Rank passers by validation Sharpe. Reused test is descriptive only.',entryThreshold=80,exit='underlying MA60; next open',holdingCap=None,healthGate='evaluate at onset close only; failed gate never creates delayed onset',cost=.0015,slots=10)
    (out/'comparison-design.json').write_text(json.dumps(design,indent=2))
    px={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d[['symbol','date','open','close']].itertuples(index=False)}
    rows=[];curves=[];counts=[];cache={};profiles=[]
    for s in specs:
        p=d.priorityM0.copy();h=d.health.copy()
        if 'pZero' in s:p=p-d['p'+s['pZero']]/d.pDenominator*100
        if s.get('pNormalize'):p=(d.pSize+d.pRelative+d.pRotation)/(d.pDenominator-2)*100
        if s.get('pCap'):p=((d.etfMarketCap>=300e9).astype(float)+d.pRelative+d.pRotation)/d.pDenominator*100
        if s.get('pUnderlying'):
            valid=np.isfinite(d.underlyingDayReturn)&np.isfinite(d.dayReturn)&(d.etfUnderlyingIndexClose>0)
            p=(((d.dayReturn-d.underlyingDayReturn)*100>=2).astype(float)+d.pSize+d.pRotation)/d.pDenominator*100;p=p.where(valid)
        if 'hDrop' in s:
            maxpts={'Aum':30,'Liquidity':20,'Premium':20}[s['hDrop']]
            h=(d.health*80/100-d['h'+s['hDrop']])/(80-maxpts)*100
        score=(.55*d["T"]+.15*p+.15*h+.15*d.marketSectorScore)
        if s.get('noH'):score=(.55*d["T"]+.15*p+.15*d.marketSectorScore)/.85
        gate=pd.Series(True,index=d.index);g=s.get('gate',{})
        if 'tv' in g:gate &= np.isfinite(d.healthTv20)&(d.healthTv20>=g['tv'])
        if 'aum' in g:gate &= np.isfinite(d.etfNetAssetTotalAmount)&(d.etfNetAssetTotalAmount>=g['aum'])
        if 'premium' in g:gate &= np.isfinite(d.derivedPremium)&(d.derivedPremium.abs()<=g['premium'])&(d.etfNav>0)&(d.etfListedUnits>0)&(d.etfMarketCap>0)
        d['candidateScore']=score;prev=d.groupby('symbol',sort=False).candidateScore.shift(1)
        onset=(score>=80)&(prev<80);d['onset_candidateScore']=onset&gate
        if s['id']=='BASE':assert (d.onset_candidateScore==d.onset_continuousM0).all()
        sig=d[d.onset_candidateScore&d.eligible&(d.date>='2018-01-01')]
        profiles.append(dict(candidate=s['id'],onsetsBeforeGate=int((onset&d.eligible&(d.date>='2018-01-01')).sum()),onsetsAfterGate=len(sig),medianAum=sig.etfNetAssetTotalAmount.median(),medianTv20=sig.healthTv20.median(),medianPremiumAbs=sig.derivedPremium.abs().median()))
        t=build_open_trades([q.reset_index(drop=True) for _,q in d.groupby('symbol',sort=False)],dict(id=s['id'],model='candidateScore',entry='modified',rule='ma60',level=0,confirm=1,hold=9999),cal[-1]);cache[s['id']]=t
        if not len(t):
            t=pd.DataFrame(columns=['symbol','signalDate','entryDate','exitDate','entryOpen','exitOpen'])
            cache[s['id']]=t
        for split,start,end in spans:
            tt=t[(t.signalDate>=start)&(t.entryDate<=end)];c=portfolio(tt,px,[x for x in cal if start<=x<=end]);rows.append(dict(candidate=s['id'],split=split,**curve_stats(c)))
            counts.append(dict(candidate=s['id'],split=split,matchedEvents=len(tt),completedEvents=int((tt.exitDate<=end).sum()),symbols=tt.symbol.nunique()))
            if split=='all':c['candidate']=s['id'];curves.append(c)
        print(s['id'],flush=True)
    p=pd.DataFrame(rows);p.to_csv(out/'portfolio-summary.csv',index=False);counts=pd.DataFrame(counts);counts.to_csv(out/'event-counts.csv',index=False)
    pd.DataFrame(profiles).to_csv(out/'signal-quality.csv',index=False);curve=pd.concat(curves,ignore_index=True);curve.to_csv(out/'portfolio-curves.csv.gz',index=False)
    ann=[]
    for cid,c in curve.groupby('candidate',sort=False):
        c=c.copy();c['daily']=c.equity.pct_change().fillna(c.equity.iloc[0]-1)
        for year,q in c.groupby(c.date.str[:4]):
            q=q.copy();q['equity']=(1+q.daily).cumprod();ann.append(dict(candidate=cid,year=year,**curve_stats(q)))
    pd.DataFrame(ann).to_csv(out/'annual.csv',index=False)
    audit=[];passed=[]
    for spec in specs[1:]:
        ok=True
        for split in ['train','validation']:
            b=p[(p.candidate=='BASE')&(p.split==split)].iloc[0];r=p[(p.candidate==spec['id'])&(p.split==split)].iloc[0];n=counts[(counts.candidate==spec['id'])&(counts.split==split)].completedEvents.iloc[0]
            checks=dict(cagr=bool(r.cagr>b.cagr),sharpe=bool(r.sharpe>b.sharpe),mdd=bool(r.mdd>=b.mdd-.03),events=bool(n>=25));audit.append(dict(candidate=spec['id'],split=split,**checks));ok=ok and all(checks.values())
        if ok:passed.append(spec['id'])
    candidates=p[(p.split=='validation')&p.candidate.isin(passed)].sort_values('sharpe',ascending=False).candidate.tolist();selected=candidates[0] if candidates else 'BASE'
    pd.DataFrame(audit).to_csv(out/'selection-audit.csv',index=False)
    sens=[]
    for cid in dict.fromkeys(['BASE',selected,'GATE_TV1','GATE_AUM50_TV1','NOH_AUM50_TV1']):
        t=cache[cid]
        for slots in [5,10,20]:
            for cost in [.0015,.003]:
                for split,start,end in spans:
                    c=portfolio(t[(t.signalDate>=start)&(t.entryDate<=end)],px,[x for x in cal if start<=x<=end],slots=slots,cost=cost);sens.append(dict(candidate=cid,split=split,slots=slots,roundTripCost=2*cost,**curve_stats(c)))
    pd.DataFrame(sens).to_csv(out/'sensitivity.csv',index=False)
    prev=pd.read_csv(root/'blocks/portfolio-summary.csv').query("candidate=='BASE' and split=='all'").iloc[0];now=p.query("candidate=='BASE' and split=='all'").iloc[0]
    assert all(abs(prev[k]-now[k])<1e-10 for k in ['cagr','mdd','sharpe'])
    result=dict(selected=selected,passed=candidates,models=len(specs),baselineReproduced=True,productionChange=False)
    (out/'comparison-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
if __name__=='__main__':main()
