#!/usr/bin/env python3
"""Isolate the impact of ETFs with zero-valued underlying index observations."""
import argparse,json
from pathlib import Path
import pandas as pd
from research_etf_m0_enhance import build_open_trades,portfolio,curve_stats

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--results',required=True);ap.add_argument('--components',required=True);a=ap.parse_args();root=Path(a.results);out=Path(a.components)
    d=pd.read_parquet(root/'scored-panel.parquet');raw=pd.read_parquet(out/'component-panel.parquet');d=d.merge(raw[['symbol','date','healthTv20','etfNetAssetTotalAmount','pRotation','pDenominator']],on=['symbol','date'],validate='one_to_one').sort_values(['symbol','date'])
    bad=d[(d.etfUnderlyingIndexClose<=0)&(d.date>='2018-01-01')];symbols=sorted(bad.symbol.unique());bad[['symbol','name','date','etfUnderlyingIndexClose','uMa60','eligible']].to_csv(out/'invalid-underlying-rows.csv',index=False)
    px={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d[['symbol','date','open','close']].itertuples(index=False)};cal=sorted(d.loc[d.date>='2018-01-01','date'].unique());rows=[];affected=[]
    for cid in ['BASE','GATE_AUM50_TV1','P_ZERO_Rotation']:
        d['qaScore']=d.continuousM0-(.15*d.pRotation/d.pDenominator*100 if cid=='P_ZERO_Rotation' else 0)
        d['onset_qaScore']=(d.qaScore>=80)&(d.groupby('symbol').qaScore.shift(1)<80)
        if cid=='GATE_AUM50_TV1':d['onset_qaScore'] &= (d.healthTv20>=1e9)&(d.etfNetAssetTotalAmount>=50e9)
        t=build_open_trades([q.reset_index(drop=True) for _,q in d.groupby('symbol')],dict(id=cid,model='qaScore',entry='modified',rule='ma60',level=0,confirm=1,hold=9999),cal[-1])
        bkeys={(r.symbol,r.date) for r in bad.itertuples(index=False)}
        affected.append(dict(candidate=cid,matchedExitsOnInvalidIndex=sum((r.symbol,getattr(r,'exitSignalDate',None)) in bkeys for r in t.itertuples(index=False))))
        for role,tt in [('as_is',t),('exclude_zero_index_etfs',t[~t.symbol.isin(symbols)])]:
            for split,start,end in [('train','2018-01-01','2022-12-31'),('validation','2023-01-01','2024-12-31'),('test','2025-01-01',cal[-1]),('all','2018-01-01',cal[-1])]:
                c=portfolio(tt[(tt.signalDate>=start)&(tt.entryDate<=end)],px,[x for x in cal if start<=x<=end]);rows.append(dict(candidate=cid,scope=role,split=split,**curve_stats(c)))
    pd.DataFrame(rows).to_csv(out/'index-qa-sensitivity.csv',index=False)
    (out/'index-qa-impact.json').write_text(json.dumps(dict(excludedSymbols=symbols,invalidRows=len(bad),affectedMatchedExits=affected,interpretation='Diagnostic cohort exclusion, not a repair or adoptable historical selection rule'),indent=2))
if __name__=='__main__':main()
