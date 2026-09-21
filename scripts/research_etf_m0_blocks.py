#!/usr/bin/env python3
"""Predeclared block ablation; next-open fills, MA60 exits, no holding cap."""
import argparse, hashlib, itertools, json
from pathlib import Path
import numpy as np
import pandas as pd
from research_etf_m0_enhance import build_open_trades, portfolio, curve_stats


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--results',required=True);a=ap.parse_args()
    root=Path(a.results);out=root/'blocks';out.mkdir(exist_ok=True)
    specs=[dict(id='BASE',weights=dict(T=55,P=15,H=15,S=15))]
    for n in [1,2,3]:
        for drop in itertools.combinations('PHS',n):
            w={k:v for k,v in dict(T=55,P=15,H=15,S=15).items() if k not in drop}
            specs.append(dict(id='DROP_'+''.join(drop),weights=w))
    specs.append(dict(id='P_RANGE',weights=dict(T=55,P=15,H=15,S=15),pScale=1/.6))
    for k in 'PHS':
        w={j:v for j,v in dict(T=70,P=15,H=15,S=15).items() if j!=k}
        specs.append(dict(id='TO_T_'+k,weights=w))
    for gate in [62.5,75.]:
        for name,w in [('NO_H',dict(T=55,P=15,S=15)),('TS',dict(T=55,S=15)),('T85S15',dict(T=85,S=15)),('T',dict(T=100))]:
            specs.append(dict(id=f'G{gate:g}_{name}',weights=w,healthGate=gate))
    design=dict(specs=specs,threshold=80,exit='underlying close < underlying MA60; next open',timeCap=None,
        selection='Both train and validation CAGR and Sharpe above BASE; MDD at most 3 percentage points worse; >=25 completed matched events in each. Rank survivors by validation Sharpe. Test never selects.',
        splits=dict(train=['2018-01-01','2022-12-31'],validation=['2023-01-01','2024-12-31'],test=['2025-01-01','latest']),
        limitations=['Retrospective reused test, not independent holdout','Current-list survivor universe','P_RANGE is global 60-point ceiling hypothesis, not exact raw-component repair','Aggregate Health gate is not a raw liquidity/AUM screen','Score renormalization changes meaning of 80'])
    (out/'design.json').write_text(json.dumps(design,indent=2))
    d=pd.read_parquet(root/'scored-panel.parquet');meta=pd.read_csv(root/'classification.csv',dtype={'symbol':str})
    d=d[d.symbol.isin(set(meta.loc[meta.assetClass=='equity','symbol']))].sort_values(['symbol','date']).copy()
    d['P']=d.priorityM0;d['H']=d.health;d['S']=d.marketSectorScore
    d['T']=(d.continuousM0-.15*(d.P+d.H+d.S))/.55
    cal=sorted(d.loc[d.date>='2018-01-01','date'].unique());spans=[('train','2018-01-01','2022-12-31'),('validation','2023-01-01','2024-12-31'),('test','2025-01-01',cal[-1]),('all','2018-01-01',cal[-1])]
    px={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d[['symbol','date','open','close']].itertuples(index=False)}
    sample=d[d.eligible & (d.date>='2018-01-01')];sample[list('TPHS')].corr().to_csv(out/'block-correlations.csv')
    sample[list('TPHS')].describe(percentiles=[.1,.5,.9]).to_csv(out/'block-distribution.csv')
    cache={};rows=[];curves=[];counts=[]
    for s in specs:
        w=s['weights'];score=sum(d[k]*(s.get('pScale',1) if k=='P' else 1)*v for k,v in w.items())/sum(w.values())
        d['candidateScore']=score
        prev=d.groupby('symbol',sort=False).candidateScore.shift(1)
        d['onset_candidateScore']=(score>=80)&(prev<80)&(d.H>=s.get('healthGate',0))
        if s['id']=='BASE':
            assert np.nanmax(abs(score-d.continuousM0))<1e-10
            assert (d.onset_candidateScore==d.onset_continuousM0).all()
        hists=[h.reset_index(drop=True) for _,h in d.groupby('symbol',sort=False)]
        t=build_open_trades(hists,dict(id=s['id'],model='candidateScore',rule='ma60',level=0,confirm=1,hold=9999,entry='modified'),cal[-1]);cache[s['id']]=t
        for split,start,end in spans:
            tt=t[(t.signalDate>=start)&(t.entryDate<=end)]
            c=portfolio(tt,px,[x for x in cal if start<=x<=end])
            rows.append(dict(candidate=s['id'],split=split,**curve_stats(c)))
            counts.append(dict(candidate=s['id'],split=split,matchedEvents=len(tt),completedEvents=int((tt.exitDate<=end).sum()),symbols=tt.symbol.nunique()))
            if split=='all':c['candidate']=s['id'];curves.append(c)
        print(s['id'],flush=True)
    p=pd.DataFrame(rows);p.to_csv(out/'portfolio-summary.csv',index=False)
    count=pd.DataFrame(counts);count.to_csv(out/'event-counts.csv',index=False)
    curve=pd.concat(curves,ignore_index=True);curve.to_csv(out/'portfolio-curves.csv.gz',index=False)
    annual=[]
    for cid,c in curve.groupby('candidate',sort=False):
        c=c.copy();c['daily']=c.equity.pct_change().fillna(c.equity.iloc[0]-1)
        for year,q in c.groupby(c.date.str[:4]):
            q=q.copy();q['equity']=(1+q.daily).cumprod();annual.append(dict(candidate=cid,year=year,**curve_stats(q)))
    pd.DataFrame(annual).to_csv(out/'annual.csv',index=False)
    audit=[];passed=[]
    for s in specs[1:]:
        cid=s['id'];ok=True
        for split in ['train','validation']:
            b=p[(p.candidate=='BASE')&(p.split==split)].iloc[0];r=p[(p.candidate==cid)&(p.split==split)].iloc[0]
            n=count[(count.candidate==cid)&(count.split==split)].completedEvents.iloc[0]
            checks=dict(cagr=r.cagr>b.cagr,sharpe=r.sharpe>b.sharpe,mdd=r.mdd>=b.mdd-.03,events=n>=25)
            audit.append(dict(candidate=cid,split=split,**checks));ok=ok and all(checks.values())
        if ok:passed.append(cid)
    selected=p[(p.split=='validation')&p.candidate.isin(passed)].sort_values('sharpe',ascending=False).candidate.tolist()
    pick=selected[0] if selected else 'BASE'
    # Sensitivity covers all single-block removals and selection, not just ex-post best.
    sens=[]
    for cid in dict.fromkeys(['BASE','DROP_P','DROP_H','DROP_S','P_RANGE',pick]):
        t=cache[cid]
        for slots in [5,10,20]:
            for cost in [.0015,.003]:
                for split,start,end in spans:
                    c=portfolio(t[(t.signalDate>=start)&(t.entryDate<=end)],px,[x for x in cal if start<=x<=end],slots=slots,cost=cost)
                    sens.append(dict(candidate=cid,slots=slots,roundTripCost=cost*2,split=split,**curve_stats(c)))
    pd.DataFrame(sens).to_csv(out/'sensitivity.csv',index=False)
    pd.DataFrame(audit).to_csv(out/'selection-audit.csv',index=False)
    ref=pd.read_csv(root/'uncapped'/'portfolio-summary.csv');ref=ref[(ref.candidate=='NEWENTRY_continuousM0_MA60')&(ref.split=='all')].iloc[0]
    actual=p[(p.candidate=='BASE')&(p.split=='all')].iloc[0]
    assert all(abs(actual[k]-ref[k])<1e-10 for k in ['cagr','mdd','sharpe'])
    result=dict(selected=pick,passed=selected,universe=d.symbol.nunique(),start=cal[0],end=cal[-1],
        baselineReproduced=True,panelSHA256=hashlib.sha256((root/'scored-panel.parquet').read_bytes()).hexdigest(),
        productionChange=False,selection=design['selection'])
    (out/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)

if __name__=='__main__':main()
