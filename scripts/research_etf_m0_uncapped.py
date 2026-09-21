#!/usr/bin/env python3
"""Re-select the predeclared 111 rules with no time exit, from scored panel."""
import argparse
import json
from pathlib import Path
import numpy as np
import pandas as pd
from research_etf_m0_enhance import candidates, build_open_trades, portfolio, curve_stats


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--results',required=True)
    ap.add_argument('--reuse-grid',action='store_true');a=ap.parse_args()
    root=Path(a.results);out=root/'uncapped';out.mkdir(exist_ok=True)
    d=pd.read_parquet(root/'scored-panel.parquet')
    meta=pd.read_csv(root/'classification.csv',dtype={'symbol':str})
    d=d[d.symbol.isin(set(meta.loc[meta.assetClass=='equity','symbol']))].sort_values(['symbol','date'])
    hists=[h.reset_index(drop=True) for _,h in d.groupby('symbol',sort=False)]
    cal=sorted(d.loc[d.date>='2018-01-01','date'].unique())
    px={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d.itertuples(index=False)}
    spans=[('train','2018-01-01','2022-12-31'),('validation','2023-01-01','2024-12-31'),
           ('test','2025-01-01',cal[-1]),('all','2018-01-01',cal[-1])]
    specs=[dict(s,hold=9999) for s in candidates()]
    rows=[];curves=[];cache={}
    for j,s in enumerate([] if a.reuse_grid else specs):
        t=build_open_trades(hists,s,cal[-1]);cache[s['id']]=t
        if not len(t):
            continue
        for split,start,end in spans:
            c=portfolio(t[(t.signalDate>=start)&(t.entryDate<=end)],px,[x for x in cal if start<=x<=end])
            rows.append(dict(candidate=s['id'],entryMode=s['entry'],split=split,**curve_stats(c)))
            if split=='all':
                c['candidate']=s['id'];curves.append(c)
        print(json.dumps(dict(progress=j+1,total=len(specs),candidate=s['id'])),flush=True)
    if a.reuse_grid:
        p=pd.read_csv(out/'portfolio-summary.csv')
        curve=pd.read_csv(out/'portfolio-curves.csv.gz')
    else:
        p=pd.DataFrame(rows);p.to_csv(out/'portfolio-summary.csv',index=False)
        curve=pd.concat(curves,ignore_index=True);curve.to_csv(out/'portfolio-curves.csv.gz',index=False)
    def get_trades(cid):
        if cid not in cache:
            cache[cid]=build_open_trades(hists,next(s for s in specs if s['id']==cid),cal[-1])
        return cache[cid]
    chosen={};shortlists={}
    for mode,n in [('fixed',10),('modified',5)]:
        score_ids={s['id'] for s in specs if s['rule']!='ma60'}
        tr=p[(p.split=='train')&(p.entryMode==mode)&p.candidate.isin(score_ids)].sort_values(['sharpe','cagr'],ascending=False)
        shortlists[mode]=tr.head(n).candidate.tolist()
        val=p[(p.split=='validation')&p.candidate.isin(shortlists[mode])].sort_values(['sharpe','cagr'],ascending=False)
        chosen[mode]=val.iloc[0].candidate
    ids=['BASE_MA60_H60',*chosen.values()]
    annual=[]
    for cid,c in curve.groupby('candidate',sort=False):
        c=c.sort_values('date').copy();c['daily']=c.equity.pct_change().fillna(c.equity.iloc[0]-1)
        for year,q in c.groupby(c.date.str[:4]):
            q=q.copy();q['equity']=(1+q.daily).cumprod()
            annual.append(dict(candidate=cid,year=year,**curve_stats(q)))
    ann=pd.DataFrame(annual);ann.to_csv(out/'annual-portfolios.csv',index=False)
    # Frozen no-cap finalists, slot and cost sensitivity; no tuning on test.
    sens=[]
    for cid in ids:
        t=get_trades(cid)
        for slots in [5,10,20]:
            for cost in [.0015,.003]:
                for split,start,end in spans:
                    c=portfolio(t[(t.signalDate>=start)&(t.entryDate<=end)],px,[x for x in cal if start<=x<=end],slots=slots,cost=cost)
                    sens.append(dict(candidate=cid,slots=slots,roundTripCost=cost*2,split=split,**curve_stats(c)))
    pd.DataFrame(sens).to_csv(out/'sensitivity.csv',index=False)
    wf=[]
    for mode in ['fixed','modified']:
        mids={s['id'] for s in specs if s['entry']==mode and s['rule']!='ma60'}
        for year in range(2021,int(cal[-1][:4])+1):
            h=ann[(ann.year.astype(int)<year)&ann.candidate.isin(mids)]
            ranking=h.groupby('candidate').agg(sharpe=('sharpe','mean'),cagr=('cagr','mean'))
            pick=ranking.sort_values(['sharpe','cagr'],ascending=False).index[0]
            for cid in ['BASE_MA60_H60',pick]:
                start=f'{year}-01-01';end=f'{year}-12-31';t=get_trades(cid)
                c=portfolio(t[(t.signalDate>=start)&(t.entryDate<=end)],px,[x for x in cal if start<=x<=end])
                wf.append(dict(mode=mode,year=year,candidate=cid,role='baseline' if cid=='BASE_MA60_H60' else 'past_only',**curve_stats(c)))
    pd.DataFrame(wf).to_csv(out/'walk-forward.csv',index=False)
    # The label BASE_MA60_H60 is retained only as a key. All rules here have NO cap.
    result=dict(timeCap=None,candidates=len(specs),selected=chosen,shortlists=shortlists,
                comparison=p[p.candidate.isin(ids)].to_dict('records'),
                caveat='Retrospective extension on reused data; not a new untouched holdout. Baseline key retains H60 label, but cap is removed for all rows.')
    (out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print('RESULT '+json.dumps(result),flush=True)


if __name__=='__main__':
    main()
