#!/usr/bin/env python3
"""Post-selection robustness, using the exported score panel without source reads."""
import argparse
import json
from pathlib import Path
import numpy as np
import pandas as pd
from research_etf_m0_enhance import candidates, build_open_trades, portfolio, curve_stats, COST


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--results',required=True);a=ap.parse_args()
    root=Path(a.results);result=json.loads((root/'result.json').read_text())
    panel=pd.read_parquet(root/'scored-panel.parquet')
    meta=pd.read_csv(root/'classification.csv',dtype={'symbol':str})
    d=panel[panel.symbol.isin(set(meta.loc[meta.assetClass=='equity','symbol']))].copy()
    d=d.sort_values(['symbol','date'])
    histories=[h.reset_index(drop=True) for _,h in d.groupby('symbol',sort=False)]
    calendar=sorted(d.loc[d.date>='2018-01-01','date'].unique())
    prices={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d.itertuples(index=False) if r.open>0 and r.close>0}
    specs={s['id']:s for s in candidates()}
    selected=result['modifiedSelected']
    compare=['BASE_MA60_H60',result['selected'],selected]
    spans=[('train','2018-01-01','2022-12-31'),('validation','2023-01-01','2024-12-31'),
           ('test','2025-01-01',calendar[-1]),('all','2018-01-01',calendar[-1])]
    cache={}
    def trades(cid,cap):
        key=(cid,cap)
        if key not in cache:
            cache[key]=build_open_trades(histories,dict(specs[cid],hold=cap),calendar[-1])
        return cache[key]
    rows=[]
    for cid in compare:
        # One-dimensional perturbations; no search or re-selection on these outputs.
        settings=[(60,slot,cost) for slot in [5,10,20] for cost in [.0015,.003]]
        settings += [(cap,10,.0015) for cap in [40,120,9999]]
        for cap,slots,cost in settings:
            t=trades(cid,cap)
            for split,start,end in spans:
                c=portfolio(t[(t.signalDate>=start)&(t.entryDate<=end)],prices,
                            [dt for dt in calendar if start<=dt<=end],slots=slots,cost=cost)
                rows.append(dict(candidate=cid,holdCap=cap,slots=slots,roundTripCost=cost*2,split=split,**curve_stats(c)))
    pd.DataFrame(rows).to_csv(root/'selected-robustness.csv',index=False)
    ann=pd.read_csv(root/'annual-portfolios.csv')
    wf=[]
    mids={k for k,v in specs.items() if v['entry']=='modified'}
    for year in range(2021,int(calendar[-1][:4])+1):
        history=ann[(ann.year<year)&ann.candidate.isin(mids)]
        rank=history.groupby('candidate').agg(sharpe=('sharpe','mean'),cagr=('cagr','mean'))
        pick=rank.sort_values(['sharpe','cagr'],ascending=False).index[0]
        for cid in ['BASE_MA60_H60',pick]:
            t=trades(cid,60);start=f'{year}-01-01';end=f'{year}-12-31'
            c=portfolio(t[(t.signalDate>=start)&(t.entryDate<=end)],prices,[dt for dt in calendar if start<=dt<=end])
            wf.append(dict(year=year,candidate=cid,role='baseline' if cid=='BASE_MA60_H60' else 'modified_past_only',**curve_stats(c)))
    pd.DataFrame(wf).to_csv(root/'modified-walk-forward.csv',index=False)
    # Reconcile exact reruns with exported primary metrics (10 slots/30bp/60D).
    pf=pd.read_csv(root/'portfolio-summary.csv')
    rerun=pd.DataFrame(rows).query('holdCap==60 and slots==10 and roundTripCost==0.003')
    check=rerun.merge(pf,on=['candidate','split'],suffixes=('_rerun','_original'))
    for col in ['cagr','mdd','sharpe','exposure']:
        np.testing.assert_allclose(check[col+'_rerun'],check[col+'_original'],rtol=1e-10,atol=1e-10)
    returns=d.groupby('symbol',sort=False).close.pct_change(fill_method=None)
    qa=dict(rows=len(d),symbols=d.symbol.nunique(),invalidOpens=int((~np.isfinite(d.open)|(d.open<=0)).sum()),
            invalidCloses=int((~np.isfinite(d.close)|(d.close<=0)).sum()),
            dailyAbsMovesOver50Pct=int((returns.abs()>.5).sum()),
            portfolioRerunsMatch=True,modifiedSelected=selected,
            originalScoreOnsets=int((d.originalOnset&d.eligible&(d.date>='2018-01-01')).sum()),
            modifiedScoreOnsets=int((d['onset_'+specs[selected]['model']]&d.eligible&(d.date>='2018-01-01')).sum()))
    (root/'robustness-qa.json').write_text(json.dumps(qa,indent=2))
    print(json.dumps(qa),flush=True)
    print(pd.DataFrame(rows).query('split=="test"').to_string(index=False),flush=True)
    print(pd.DataFrame(wf).to_string(index=False),flush=True)


if __name__=='__main__':
    main()
