#!/usr/bin/env python3
"""Recover auditable raw fields without fetching source data inside Python."""
import argparse,json
from pathlib import Path
import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from research_etf_m0_exit_rules import load_and_score
from research_etf_m0_enhance import enrich_scores,asset_class

def qa(frame,cols,scope):
    rows=[]
    for period,g in [('all',frame),*list(frame.groupby(frame.date.str[:4]))]:
        for col in cols:
            if col not in g:
                rows.append(dict(scope=scope,period=period,column=col,rows=len(g),present=False,finite=0));continue
            v=pd.to_numeric(g[col],errors='coerce');ok=np.isfinite(v)
            dates=g.loc[ok,'date']
            rows.append(dict(scope=scope,period=period,column=col,rows=len(g),present=True,finite=int(ok.sum()),coverage=float(ok.mean()),positive=int((ok&(v>0)).sum()),zero=int((ok&(v==0)).sum()),negative=int((ok&(v<0)).sum()),first=dates.min() if len(dates) else None,last=dates.max() if len(dates) else None,median=v[ok].median(),p01=v[ok].quantile(.01),p99=v[ok].quantile(.99)))
    return rows

def main():
    ap=argparse.ArgumentParser()
    for k in ['source-manifest','source-cache-dir','etf-parquet','sector-map','output-dir']:ap.add_argument('--'+k,required=True)
    a=ap.parse_args();out=Path(a.output_dir);out.mkdir(parents=True,exist_ok=True)
    schema=pq.read_schema(a.etf_parquet).names
    (out/'raw-schema.json').write_text(json.dumps(schema,indent=2))
    d=enrich_scores(load_and_score(a));d=d.sort_values(['symbol','date']).reset_index(drop=True)
    meta=d.drop_duplicates('symbol',keep='last')[['symbol','name','sectorCode','etfUnderlyingIndexName']].copy();meta['assetClass']=meta.apply(asset_class,axis=1);meta.to_csv(out/'classification.csv',index=False)
    optional=[c for c in schema if any(x in c.lower() for x in ['premium','discount','expense','tracking','aum']) and c not in d]
    source_fields=[c for c in ['priceSource','tradingValueSource','marketCapSource'] if c in schema]
    if optional or source_fields:
        raw=pd.read_parquet(a.etf_parquet,columns=['symbol','date']+optional+source_fields)
        from research_etf_m0_vs_m1 import norm_symbol
        raw['symbol']=raw.symbol.map(norm_symbol);raw['date']=raw.date.astype(str).str[:10];raw=raw.drop_duplicates(['symbol','date']);d=d.merge(raw,on=['symbol','date'],how='left',validate='one_to_one')
    sources=[]
    for col in source_fields:
        for value,n in d[col].fillna('MISSING').value_counts().items():sources.append(dict(column=col,source=str(value),rows=int(n)))
    pd.DataFrame(sources).to_csv(out/'source-provenance.csv',index=False)
    d['pSize']=(d.marketCap>=300e9).astype(float)
    d['pRelative']=((d.dayReturn-d.kospiDay)*100>=2).astype(float)
    d['pRotation']=d.rotationScore.fillna(0)/100
    d['pDenominator']=np.where(d.rotationScore.notna(),5.,4.)
    d['hAum']=np.where(d.etfNetAssetTotalAmount>=50e9,20.,0.)+np.where(d.etfNetAssetTotalAmount>=100e9,10.,0.)
    d['hLiquidity']=np.where(d.healthTv20>=1e9,20.,0.)
    d['hPremium']=np.where(d.derivedPremium.abs()<=.5,20.,np.where(d.derivedPremium.abs()<=1.,10.,0.))
    d['hPlain']=np.where(~(d.isLeveraged.fillna(False)|d.isInverse.fillna(False)),10.,0.)
    d['underlyingDayReturn']=d.groupby('symbol').etfUnderlyingIndexClose.pct_change(fill_method=None)
    d['marketCapPriceError']=d.etfMarketCap/d.etfListedUnits/d.close-1
    d['capFieldError']=d.marketCap/d.etfMarketCap-1
    d['navAssetError']=d.etfNetAssetTotalAmount/d.etfListedUnits/d.etfNav-1
    equity=d[d.symbol.isin(meta.loc[meta.assetClass=='equity','symbol'])].copy()
    cols=['marketCap','tradingValue','etfTradingValue','etfMarketCap','etfNetAssetTotalAmount','etfListedUnits','etfNav','etfUnderlyingIndexClose','kospiDay','rotationScore','healthTv20','derivedPremium','marketCapPriceError','capFieldError','navAssetError',*optional]
    rows=qa(d,cols,'all_etfs')+qa(equity,cols,'equity')+qa(equity[equity.eligible&(equity.date>='2018-01-01')],cols,'eligible_equity')
    pd.DataFrame(rows).to_csv(out/'qa-yearly.csv',index=False)
    sym=[]
    for symbol,g in equity.groupby('symbol'):
        for col in cols[:9]:
            ok=np.isfinite(pd.to_numeric(g[col],errors='coerce'))
            if ok.any():
                first=g.loc[ok,'date'].min();last=g.loc[ok,'date'].max();inside=g.date.between(first,last)
                sym.append(dict(symbol=symbol,name=g.name.iloc[-1],column=col,rows=len(g),first=first,last=last,coverage=ok.mean(),leadingMissing=int((g.date<first).sum()),internalMissing=int((inside&~ok).sum()),trailingMissing=int((g.date>last).sum())))
            else:sym.append(dict(symbol=symbol,name=g.name.iloc[-1],column=col,rows=len(g),coverage=0))
    pd.DataFrame(sym).to_csv(out/'qa-symbol.csv',index=False)
    keep=['symbol','date','name','sectorCode','marketCap','tradingValue','close','dayReturn','kospiDay','rotationScore','etfTradingValue','etfMarketCap','etfNetAssetTotalAmount','etfListedUnits','etfNav','healthTv20','derivedPremium','pSize','pRelative','pRotation','pDenominator','hAum','hLiquidity','hPremium','hPlain','underlyingDayReturn','priorityM0','health','continuousM0','eligible',*optional,*source_fields]
    equity[keep].to_parquet(out/'component-panel.parquet',index=False,compression='zstd')
    p=(equity.pSize+equity.pRelative+equity.pRotation)/equity.pDenominator*100
    h=(equity.hAum+equity.hLiquidity+equity.hPremium+equity.hPlain)/80*100
    errp=float((p-equity.priorityM0).abs().max());errh=float((h-equity.health).abs().max());assert errp<1e-10 and errh<1e-10
    result=dict(rows=len(equity),symbols=equity.symbol.nunique(),first=equity.date.min(),last=equity.date.max(),priorityReconstructionMaxError=errp,healthReconstructionMaxError=errh,optionalColumns=optional)
    (out/'export-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
if __name__=='__main__':main()
