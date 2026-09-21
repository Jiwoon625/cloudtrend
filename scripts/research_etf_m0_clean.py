#!/usr/bin/env python3
"""Cutoff-frozen mapping, no premium/tracking/fee inputs, predeclared rule comparisons."""
import argparse,json,hashlib,shutil
from pathlib import Path
import numpy as np
import pandas as pd
from research_etf_m0_exit_rules import load_and_score
from research_etf_m0_enhance import enrich_scores,portfolio,curve_stats
from research_etf_m0_vs_m1 import BASE_COLS,read_csv_cols,norm_symbol,enrich_price,build_market_sector,build_rotation,sha256
from build_etf_research_mapping import STOCK_SECTORS

CUTOFF='2026-09-11'
SPECS=[
 dict(id='REF_LEGACY',reference=True),
 dict(id='REF_NO_PREMIUM',noPremium=True),
 dict(id='REF_CAP_HEALTH',capHealth=True),
 dict(id='CLEAN'),
 dict(id='DROP_P_SIZE',dropSize=True),
 dict(id='DROP_P_RELATIVE',dropRelative=True),
 dict(id='DROP_P_ROTATION',dropRotation=True),
 dict(id='P_ACTIVE_NORMALIZE',activeP=True),
 dict(id='DROP_P',noP=True),
 dict(id='H_GATE_ONLY',noH=True,gate=True),
 dict(id='NO_P_H_GATE',noP=True,noH=True,gate=True),
 dict(id='CLEAN_LIQUIDITY_GATE',gate=True),
 dict(id='ENTRY_ABOVE_MA60',entryRegime=True),
 dict(id='NO_P_ENTRY_MA60',noP=True,entryRegime=True),
 dict(id='TECH_ONLY_GATE',techOnly=True,gate=True),
]

def save_json(p,obj):p.write_text(json.dumps(obj,ensure_ascii=False,indent=2,default=lambda x:x.item() if hasattr(x,'item') else str(x)))

def read_stock(a):
    doc=json.loads(Path(a.sector_map).read_text());meta=pd.DataFrame(doc['instruments']);meta=meta[meta.instrumentType=='STOCK'].copy();meta['symbol']=meta.symbol.map(norm_symbol)
    paths=json.loads(Path(a.source_manifest).read_text())['files'];ss=[];ii=[]
    for f in paths:
        x=read_csv_cols(Path(a.source_cache_dir)/f['cacheFile'],BASE_COLS);x['symbol']=x.symbol.map(norm_symbol);x['date']=x.date.astype(str).str[:10];x=x[x.date<=CUTOFF]
        ss.append(x[x.symbol.isin(meta.symbol)]);ii.append(x[x.symbol=='KOSPI'][['symbol','date','close']])
    s=pd.concat(ss).drop_duplicates(['symbol','date']);k=pd.concat(ii).drop_duplicates(['symbol','date']).sort_values('date')
    for c in BASE_COLS:
        if c not in {'symbol','name','market','securityType','date'}:s[c]=pd.to_numeric(s[c],errors='coerce')
    s=s.merge(meta[['symbol','sectorCode']],on='symbol',validate='many_to_one');s=enrich_price(s,flows=True)
    k['close']=pd.to_numeric(k.close,errors='coerce');k=k[k.close>0].copy()
    for n in [20,60,120]:k['r'+str(n)]=k.close/k.close.shift(n)-1
    k['dayReturn']=k.close/k.close.shift(1)-1
    return s[s.sectorCode.isin(STOCK_SECTORS)],k

def events(d,cid,start='2017-01-01'):
    out=[]
    for sym,g in d.groupby('symbol',sort=False):
        g=g.reset_index(drop=True);dates=g.date.to_numpy();op=g.open.to_numpy();u=g.etfUnderlyingIndexClose.to_numpy();ma=g.uMa60.to_numpy()
        bad=~np.isfinite(u)|(u<=0)
        hit=np.flatnonzero(bad|(np.isfinite(ma)&(u<ma)))
        for s in np.flatnonzero(g.onset.to_numpy()&g.eligible.to_numpy()&(dates>=start)):
            b=s+1
            if b>=len(g) or not np.isfinite(op[b]) or op[b]<=0:continue
            hh=hit[hit>=b];x=int(hh[0]) if len(hh) else len(g)
            sell=x+1
            if sell<len(g) and (not np.isfinite(op[sell]) or op[sell]<=0):raise ValueError('Invalid executable exit open')
            done=sell<len(g)
            out.append(dict(candidate=cid,symbol=sym,signalDate=dates[s],entryDate=dates[b],entryOpen=op[b],exitSignalDate=dates[x] if x<len(g) else '',exitDate=dates[sell] if done else '9999-12-31',exitOpen=op[sell] if done else np.nan,reason=('data_unavailable' if bad[x] else 'ma60') if x<len(g) else 'terminal_open'))
    return pd.DataFrame(out,columns=['candidate','symbol','signalDate','entryDate','entryOpen','exitSignalDate','exitDate','exitOpen','reason'])

def compare(d,out):
    start=d.loc[d.eligible,'date'].min();cal=sorted(d.loc[d.date>=start,'date'].unique());spans=[('train',start,'2022-12-31'),('validation','2023-01-01','2024-12-31'),('test','2025-01-01',cal[-1]),('all',start,cal[-1]),('legacy_window','2018-01-01',cal[-1])]
    prices={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d[['symbol','date','open','close']].itertuples(index=False)}
    rows=[];curves=[];alltrades=[];signals=[];cache={};counts=[]
    for spec in SPECS:
        p=d.priorityClean.copy();h=d.healthClean.copy();s=d.sectorClean
        if spec.get('dropSize'):p-=d.pSize/d.pDen*100
        if spec.get('dropRelative'):p-=d.pRelative/d.pDen*100
        if spec.get('dropRotation'):p-=d.pRotation/d.pDen*100
        if spec.get('activeP'):p=(d.pSize+d.pRelative+d.pRotation)/(d.pDen-2)*100
        score=.55*d.techContinuous+.15*p+.15*h+.15*s;den=1.
        if spec.get('noP'):score-=.15*p;den-=.15
        if spec.get('noH'):score-=.15*h;den-=.15
        score/=den
        if spec.get('techOnly'):score=d.techContinuous
        if spec.get('reference'):score=d.continuousM0
        if spec.get('noPremium'):score=d.continuousM0+.15*(d.healthNoPremium-d.health)
        if spec.get('capHealth'):score=d.continuousM0+.15*(d.healthClean-d.health)
        d['score']=score;prev=d.groupby('symbol').score.shift(1);onset=(score>=80)&(prev<80)
        gate=pd.Series(True,index=d.index)
        if spec.get('gate'):gate&=(d.etfMarketCap>=50e9)&(d.healthTv20>=1e9)
        if spec.get('entryRegime'):gate&=d.etfUnderlyingIndexClose>d.uMa60
        d['onset']=onset&gate
        signals.append(dict(candidate=spec['id'],onsets=int((onset&d.eligible&(d.date>=cal[0])).sum()),passed=int((d.onset&d.eligible&(d.date>=cal[0])).sum())))
        t=events(d,spec['id'],cal[0]);cache[spec['id']]=t;alltrades.append(t)
        for split,start,end in spans:
            q=t[(t.signalDate>=start)&(t.entryDate<=end)];c=portfolio(q,prices,[dt for dt in cal if start<=dt<=end]);rows.append(dict(candidate=spec['id'],split=split,**curve_stats(c)))
            counts.append(dict(candidate=spec['id'],split=split,matchedEvents=len(q),completed=int((q.exitDate<=end).sum()),dataErrorEvents=int(((q.reason=='data_unavailable')&(q.exitDate<=end)).sum())))
            if split=='all':c['candidate']=spec['id'];curves.append(c)
        print(json.dumps({'candidate':spec['id'],'events':len(t)}),flush=True)
    p=pd.DataFrame(rows);p.to_csv(out/'portfolio-summary.csv',index=False);pd.DataFrame(signals).to_csv(out/'signal-counts.csv',index=False)
    pd.DataFrame(counts).to_csv(out/'event-counts.csv',index=False);pd.concat(curves).to_csv(out/'portfolio-curves.csv.gz',index=False);pd.concat(alltrades).to_csv(out/'matched-events.csv.gz',index=False)
    checks=[];passed=[]
    for spec in SPECS[4:]:
        ok=True
        for split in ['train','validation']:
            b=p[(p.candidate=='CLEAN')&(p.split==split)].iloc[0];r=p[(p.candidate==spec['id'])&(p.split==split)].iloc[0]
            ck=dict(cagr=bool(r.cagr>b.cagr),sharpe=bool(r.sharpe>b.sharpe),mdd=bool(r.mdd>=b.mdd-.03))
            checks.append(dict(candidate=spec['id'],split=split,**ck));ok &= all(ck.values())
        if ok:passed.append(spec['id'])
    pd.DataFrame(checks).to_csv(out/'selection-audit.csv',index=False)
    selected=p[(p.split=='validation')&p.candidate.isin(passed)].sort_values('sharpe').candidate.tolist();pick=selected[-1] if selected else 'CLEAN'
    # Fixed representative simplification and entry-rule checks; no test-period search.
    sens=[]
    for cid in dict.fromkeys(['CLEAN',pick,'NO_P_H_GATE','ENTRY_ABOVE_MA60']):
        for slots,cost in [(5,.0015),(20,.0015),(10,.003)]:
            for split,start,end in spans:
                q=cache[cid];q=q[(q.signalDate>=start)&(q.entryDate<=end)]
                c=portfolio(q,prices,[dt for dt in cal if start<=dt<=end],slots=slots,cost=cost);sens.append(dict(candidate=cid,split=split,slots=slots,costPerSide=cost,**curve_stats(c)))
    pd.DataFrame(sens).to_csv(out/'sensitivity.csv',index=False)
    save_json(out/'selection.json',dict(passed=passed,selected=pick,productionChange=False,testStatus='reused retrospective evidence, not untouched holdout'))


def main():
    ap=argparse.ArgumentParser()
    for k in ['source-manifest','source-cache-dir','etf-parquet','sector-map','mapping','output-dir']:ap.add_argument('--'+k,required=True)
    a=ap.parse_args();out=Path(a.output_dir);out.mkdir(parents=True,exist_ok=True)
    mapping=pd.read_csv(a.mapping,dtype={'symbol':str},keep_default_na=False);assert len(mapping)==393 and mapping.symbol.nunique()==393
    shutil.copyfile(a.mapping,out/'etf-universe-sector-map.csv')
    save_json(out/'design.json',dict(cutoff=CUTOFF,specs=SPECS,entry='M0 onset80; gates never generate delayed onset',exit='underlying close<MA60 next open; invalid underlying during holding triggers separately labelled data-error liquidation',scale='55/15/15/15; omitted block weights renormalized to100; no threshold tuning',selection='train maximal-valid-start through2022 AND validation2023-24: improve CAGR and Sharpe with MDD at most3pp worse; reused2025+ descriptive',price='TOSS_ADJUSTED_CANDLE',money='KRX_ETF marketCap and tradingValue in KRW',ignored=['premium','trackingError','expenseRatio'],mapping='current snapshot, not historical constituents',slots=10,costPerSide=.0015))
    print('Load verified source and legacy reference',flush=True)
    d=enrich_scores(load_and_score(a));d=d[d.date<=CUTOFF].copy().sort_values(['symbol','date']).reset_index(drop=True)
    assert set(d.symbol)==set(mapping.symbol)
    # Compute continuous technical directly, not from any deprecated Health component.
    g=d.groupby('symbol');vol=g.dayReturn.transform(lambda x:x.rolling(20,min_periods=20).std()).clip(lower=.003)
    slope=d.ma60/g.ma60.shift(5)-1
    d['techContinuous']=sum((50+25*x/vol).clip(0,100) for x in [d.close/d.cloudTop-1,d.ma20/d.ma60-1,d.ma60/d.ma120-1,d.close/d.ma20-1,slope])/5
    print('Rebuild stock-only sector scores',flush=True)
    stock,kospi=read_stock(a);ms=build_market_sector(stock,stock.iloc[:0],kospi);rot=build_rotation(stock,kospi)
    sectors=ms.merge(rot,on=['date','sectorCode'],validate='one_to_one');sectors.to_csv(out/'stock-sector-signals.csv.gz',index=False)
    src=pd.read_parquet(a.etf_parquet,columns=['symbol','date','priceSource','tradingValueSource','marketCapSource']);src['symbol']=src.symbol.map(norm_symbol);src['date']=src.date.astype(str).str[:10];src=src[src.date<=CUTOFF].drop_duplicates(['symbol','date'])
    provenance={c:src[c].value_counts(dropna=False).to_dict() for c in ['priceSource','tradingValueSource','marketCapSource']}
    assert set(src.priceSource.dropna())=={'TOSS_ADJUSTED_CANDLE'};assert set(src.tradingValueSource.dropna())=={'KRX_ETF'};assert set(src.marketCapSource.dropna())=={'KRX_ETF'}
    save_json(out/'source-provenance.json',provenance)
    d=d.merge(mapping[['symbol','assetClass','region','stockSectorCode','rotationSource','marketSource','sectorCode']].rename(columns={'sectorCode':'mappedSectorCode'}),on='symbol',validate='many_to_one')
    d=d.merge(sectors.rename(columns={'sectorCode':'stockSectorCode','rotationScore':'mappedRotation','marketSectorScore':'mappedSectorScore'}),on=['date','stockSectorCode'],how='left',validate='many_to_one')
    required_dates=set(kospi.loc[kospi.dayReturn.notna(),'date'])
    stock_counts=sectors[sectors.marketSectorScore.notna()&sectors.rotationScore.notna()].groupby('date').stockSectorCode.nunique() if 'stockSectorCode' in sectors else sectors[sectors.marketSectorScore.notna()&sectors.rotationScore.notna()].groupby('date').sectorCode.nunique()
    expected=set(mapping.loc[mapping.rotationSource=='domestic_stock_sector','stockSectorCode']);assert expected<=set(sectors.sectorCode)
    complete_dates=set(stock_counts[stock_counts==len(expected)].index)&required_dates
    end=min(CUTOFF,max(complete_dates));assert end==CUTOFF
    d=d[d.assetClass=='equity'].copy().reset_index(drop=True)
    raw_index=d.etfUnderlyingIndexClose.copy();bad=(~np.isfinite(raw_index))|(raw_index<=0)
    d.loc[bad,['symbol','name','date','etfUnderlyingIndexClose']].to_csv(out/'invalid-underlying.csv',index=False)
    d['etfUnderlyingIndexClose']=raw_index.where(~bad);g=d.groupby('symbol')
    d['uMa20']=g.etfUnderlyingIndexClose.transform(lambda x:x.rolling(20,min_periods=20).mean());d['uMa60']=g.etfUnderlyingIndexClose.transform(lambda x:x.rolling(60,min_periods=60).mean())
    uslope=d.uMa60/d.groupby('symbol').uMa60.shift(5)-1
    underlying_score=25*((d.etfUnderlyingIndexClose>d.uMa20).astype(float)+(d.etfUnderlyingIndexClose>d.uMa60).astype(float)+(d.uMa20>d.uMa60).astype(float)+(uslope>0).astype(float))
    underlying_score=underlying_score.where(d[['uMa20','uMa60']].notna().all(axis=1)&uslope.notna())
    local=d.rotationSource=='domestic_stock_sector'
    d['sectorClean']=d.mappedSectorScore.where(local,underlying_score)
    d['pSize']=(d.etfMarketCap>=300e9).astype(float)
    # KOSPI-relative daily jump has no benchmark meaning for non-Korean exposure.
    d['pRelative']=(((d.dayReturn-d.kospiDay)*100>=2)&d.region.eq('KR')).astype(float)
    d['pRotation']=d.mappedRotation.where(local,0)/100;d['pDen']=np.where(local,5.,4.)
    d['priorityClean']=(d.pSize+d.pRelative+d.pRotation)/d.pDen*100
    liquidity=(d.healthTv20>=1e9).astype(float)*20
    cap_size=(d.etfMarketCap>=50e9).astype(float)*20+(d.etfMarketCap>=100e9).astype(float)*10
    aum_size=(d.etfNetAssetTotalAmount>=50e9).astype(float)*20+(d.etfNetAssetTotalAmount>=100e9).astype(float)*10
    d['healthClean']=(cap_size+liquidity+10)/60*100;d['healthNoPremium']=(aum_size+liquidity+10)/60*100
    # A single comparison mask; no zero filling for required data and no date-tail carry.
    required=['techContinuous','sectorClean','priorityClean','healthClean','uMa60','open','close','healthTv20','etfMarketCap']
    d['eligible']=np.isfinite(d[required]).all(axis=1)&(d.etfUnderlyingIndexClose>0)&(d.open>0)&(d.close>0)&(d.etfMarketCap>0)&d.date.isin(complete_dates)
    # Foreign market regime needs five extra valid MA observations, shared by all models.
    d['eligible'] &= np.isfinite(underlying_score)
    coverage=[]
    for sym,q in d.groupby('symbol'):
        v=q[q.eligible];coverage.append(dict(symbol=sym,name=q.name.iloc[-1],rows=len(q),eligibleRows=len(v),firstEligible=v.date.min() if len(v) else '',lastEligible=v.date.max() if len(v) else '',invalidIndex=int(q.etfUnderlyingIndexClose.isna().sum()),mappedRotationFinite=int(q.mappedRotation.notna().sum()),rotationSource=q.rotationSource.iloc[-1]))
    pd.DataFrame(coverage).to_csv(out/'input-coverage.csv',index=False)
    save_json(out/'data-audit.json',dict(universe=len(mapping),equity=d.symbol.nunique(),cutoff=end,commonInputFirst=min(complete_dates),commonInputLast=max(complete_dates),firstPortfolioDate=d.loc[d.eligible,'date'].min(),rows=len(d),eligibleRows=int(d.eligible.sum()),unavailableUnderlyingRows=int(bad.sum()),legacyEquity=int((mapping.legacyAssetClass=='equity').sum()),assetCorrections=mapping[mapping.assetClass!=mapping.legacyAssetClass][['symbol','name','legacyAssetClass','assetClass']].to_dict('records'),rotationCounts=mapping.rotationSource.value_counts().to_dict(),sourceHash=sha256(Path(a.etf_parquet)),mappingSha256=hashlib.sha256(Path(a.mapping).read_bytes()).hexdigest(),limitations=['current-universe survivorship bias','snapshot sector labels not point-in-time holdings','adjusted source return series not independently certified total return','reused retrospective test']))
    keep=['symbol','name','date','mappedSectorCode','region','rotationSource','open','close','etfUnderlyingIndexClose','uMa60','techContinuous','priorityClean','healthClean','sectorClean','etfMarketCap','healthTv20','eligible']
    d[keep].to_parquet(out/'clean-input-panel.parquet',compression='zstd',index=False)
    compare(d,out)
    print('DONE',flush=True)
if __name__=='__main__':main()
