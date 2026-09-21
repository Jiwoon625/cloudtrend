#!/usr/bin/env python3
"""Point-in-time component summaries and raw monetary-field consistency."""
import argparse,json
from pathlib import Path
import numpy as np
import pandas as pd

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--components',required=True);a=ap.parse_args();out=Path(a.components)
    d=pd.read_parquet(out/'component-panel.parquet').sort_values(['symbol','date'])
    e=d[d.eligible&(d.date>='2018-01-01')].copy();prev=d.groupby('symbol').continuousM0.shift(1)
    sig=d[d.eligible&(d.date>='2018-01-01')&(d.continuousM0>=80)&(prev<80)].copy()
    rows=[]
    for scope,q in [('eligible',e),('onset',sig)]:
        for period,g in [('all',q),*list(q.groupby(q.date.str[:4]))]:
            for col in ['pSize','pRelative','pRotation','hAum','hLiquidity','hPremium','hPlain']:
                if col.startswith('p'):pts=g[col]/g.pDenominator*15
                else:pts=g[col]/80*15
                rows.append(dict(scope=scope,period=period,component=col,rows=len(g),nonzeroRate=(g[col]!=0).mean(),meanRawPoints=g[col].mean(),meanM0Contribution=pts.mean()))
    pd.DataFrame(rows).to_csv(out/'component-contributions.csv',index=False)
    cross=[]
    for period,g in [('all',d),*list(d.groupby(d.date.str[:4]))]:
        ratios={'marketCap_vs_etfMarketCap':g.marketCap/g.etfMarketCap-1,'impliedPrice_vs_close':g.etfMarketCap/g.etfListedUnits/g.close-1,'AUMperUnit_vs_NAV':g.etfNetAssetTotalAmount/g.etfListedUnits/g.etfNav-1,'tradingValue_vs_etfTradingValue':g.tradingValue/g.etfTradingValue-1}
        for col,r in ratios.items():
            v=r[np.isfinite(r)];cross.append(dict(period=period,check=col,rows=len(g),finite=len(v),median=v.median(),p99Abs=v.abs().quantile(.99),above1pct=int((v.abs()>.01).sum()),above10pct=int((v.abs()>.10).sum())))
    pd.DataFrame(cross).to_csv(out/'raw-consistency.csv',index=False)
    d['aumNavUnitError']=d.etfNetAssetTotalAmount/d.etfListedUnits/d.etfNav-1
    d['impliedPrice']=d.etfMarketCap/d.etfListedUnits
    cols=['symbol','name','date','close','impliedPrice','etfNav','etfListedUnits','etfNetAssetTotalAmount','aumNavUnitError']
    d.loc[d.aumNavUnitError.abs()>.01,cols].to_csv(out/'aum-nav-unit-anomalies.csv.gz',index=False)
    d.loc[d.etfNetAssetTotalAmount==0,cols].to_csv(out/'zero-aum.csv',index=False)
    e.groupby('sectorCode').agg(rows=('date','size'),rotationCoverage=('rotationScore',lambda s:s.notna().mean())).to_csv(out/'rotation-sector-coverage.csv')
    res=dict(priorityRotationMissingEligible=int(e.rotationScore.isna().sum()),eligibleRows=len(e),onsets=len(sig),
        prioritySizePassRate=float(e.pSize.mean()),priorityRelativePassRate=float(e.pRelative.mean()),
        pSizeCapMismatch=int(((e.marketCap>=300e9)!=(e.etfMarketCap>=300e9)).sum()),
        underlyingRelativePassRate=float(((e.dayReturn-e.underlyingDayReturn)*100>=2).mean()),
        onsetTvBelow1bn=int((sig.healthTv20<1e9).sum()),onsetAumBelow50bn=int((sig.etfNetAssetTotalAmount<50e9).sum()),onsetPremiumAbove1pct=int((sig.derivedPremium.abs()>1).sum()))
    (out/'diagnostics.json').write_text(json.dumps(res,indent=2));print(json.dumps(res))
if __name__=='__main__':main()
