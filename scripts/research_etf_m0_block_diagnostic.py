#!/usr/bin/env python3
"""Diagnostic only: match training onset count; not an 80-point strategy."""
import argparse,json
from pathlib import Path
import numpy as np
import pandas as pd
from research_etf_m0_enhance import build_open_trades,portfolio,curve_stats

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--results',required=True);a=ap.parse_args();root=Path(a.results);out=root/'blocks'
    d=pd.read_parquet(root/'scored-panel.parquet');m=pd.read_csv(root/'classification.csv',dtype={'symbol':str});d=d[d.symbol.isin(m.loc[m.assetClass=='equity','symbol'])].sort_values(['symbol','date']).copy()
    d['P']=d.priorityM0;d['H']=d.health;d['S']=d.marketSectorScore;d['T']=(d.continuousM0-.15*(d.P+d.H+d.S))/.55
    mask=(d.date>='2018-01-01')&(d.date<='2022-12-31')&d.eligible;target=int((mask&d.onset_continuousM0).sum())
    cal=sorted(d.loc[d.date>='2018-01-01','date'].unique());px={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d[['symbol','date','open','close']].itertuples(index=False)}
    specs=json.loads((out/'design.json').read_text())['specs'];rows=[];fits=[]
    for spec in [s for s in specs if s['id'] in ['DROP_P','DROP_H','DROP_S','P_RANGE']]:
        w=spec['weights'];d['candidateScore']=sum(d[k]*v*(spec.get('pScale',1) if k=='P' else 1) for k,v in w.items())/sum(w.values());prev=d.groupby('symbol').candidateScore.shift(1)
        # Fit frequency only, no performance objective. Upper thresholds avoid near-zero-score degeneracy.
        grid=np.arange(65,99.001,.05);counts=np.array([int((mask&(d.candidateScore>=v)&(prev<v)).sum()) for v in grid]);ix=min(range(len(grid)),key=lambda i:(abs(counts[i]-target),abs(grid[i]-80)))
        threshold=float(grid[ix]);d['onset_candidateScore']=(d.candidateScore>=threshold)&(prev<threshold)
        fits.append(dict(candidate=spec['id'],threshold=threshold,targetTrainOnsets=target,actualTrainOnsets=int(counts[ix])))
        t=build_open_trades([h.reset_index(drop=True) for _,h in d.groupby('symbol')],dict(id=spec['id'],model='candidateScore',rule='ma60',level=0,confirm=1,hold=9999,entry='modified'),cal[-1])
        for split,start,end in [('train','2018-01-01','2022-12-31'),('validation','2023-01-01','2024-12-31'),('test','2025-01-01',cal[-1]),('all','2018-01-01',cal[-1])]:
            c=portfolio(t[(t.signalDate>=start)&(t.entryDate<=end)],px,[x for x in cal if start<=x<=end]);rows.append(dict(candidate=spec['id'],split=split,**curve_stats(c)))
        print(spec['id'],threshold,flush=True)
    pd.DataFrame(fits).to_csv(out/'frequency-matched-thresholds.csv',index=False);pd.DataFrame(rows).to_csv(out/'frequency-matched-performance.csv',index=False)
if __name__=='__main__':main()
