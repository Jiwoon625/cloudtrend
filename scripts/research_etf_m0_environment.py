#!/usr/bin/env python3
"""Remove unused Priority slots; point-in-time, leave-family-out environment tests."""
import argparse,json,re,hashlib
from pathlib import Path
import numpy as np
import pandas as pd
from research_etf_m0_clean import events,save_json
from research_etf_m0_enhance import portfolio,curve_stats
from research_etf_m0_clean_followup import executed

SPECS=[('REF_PREVIOUS','old','own'),('REF_INDEX_ONLY','index_only','own'),
 ('P2_OWN','two','own'),('P2_OWN_LAG1','two','ownLag'),
 ('P2_PEER_TREND','two','peerTrend'),('P2_PEER_CONTINUOUS','two','peerContinuous'),
 ('P2_PEER_BREADTH','two','peerBreadth'),('P2_PEER_MIX','two','peerMix'),
 ('P2_NEUTRAL','two','neutral'),('P2_NO_ENV','two','omit')]

def family(name):
    t=str(name).upper();t=re.sub(r'[^A-Z0-9가-힣]','',t)
    # Economic-family grouping deliberately also removes different share classes/hedges/return labels.
    for pat,key in [(r'코스피200|KOSPI200','KOSPI200'),(r'코스닥150|KOSDAQ150','KOSDAQ150'),(r'SP500','SP500'),(r'NASDAQ100|나스닥100','NASDAQ100'),(r'CSI300','CSI300'),(r'TOPIX','TOPIX'),(r'NIKKEI225','NIKKEI225'),(r'NIFTY50','NIFTY50'),(r'HANGSENGCHINAH','HSCEI'),(r'HANGSENGTECH','HSTECH'),(r'DOWJONESUSDIVIDEND100','US_DIV100')]:
        # Korean sector variants are separate economic families, not broad 200/150 duplicates.
        if re.search(pat,t) and not (key in {'KOSPI200','KOSDAQ150'} and re.search(r'정보기술|바이오|헬스|소재|건설|중공업|금융|에너지|소비',t)):return key
    return re.sub(r'PRICERETURN|TOTALRETURN|시장가격지수|시장가격|지수|INDEX|\(PR\)|\(TR\)','',t)

def environment(d,out):
    g=d.groupby('symbol');d['uRet']=g.etfUnderlyingIndexClose.pct_change(fill_method=None)
    d['uMa20']=g.etfUnderlyingIndexClose.transform(lambda x:x.rolling(20,min_periods=20).mean())
    d['uBreadth']=((d.etfUnderlyingIndexClose>d.uMa20).astype(float)+(d.etfUnderlyingIndexClose>d.uMa60).astype(float)+(d.uMa20>d.uMa60).astype(float))/3*100
    d.loc[d[['uMa20','uMa60']].isna().any(axis=1),'uBreadth']=np.nan
    f=d.groupby(['region','family','date']).agg(ret=('uRet','median'),breadth=('uBreadth','median')).reset_index()
    allrows=[]
    for region,rr in f.groupby('region'):
        rets=rr.pivot(index='date',columns='family',values='ret').sort_index();br=rr.pivot(index='date',columns='family',values='breadth').reindex(rets.index)
        for fam in rets.columns:
            other=rets.drop(columns=fam);otherbr=br.drop(columns=fam)
            n=other.count(axis=1);nb=otherbr.count(axis=1)
            r=other.median(axis=1).where(n>=3)
            level=(1+r).cumprod(skipna=True);ma20=level.rolling(20,min_periods=20).mean();ma60=level.rolling(60,min_periods=60).mean();slope=ma60/ma60.shift(5)-1
            vol=r.rolling(20,min_periods=20).std().clip(lower=.003)
            valid=ma60.notna()&ma20.notna()&slope.notna()&r.rolling(65,min_periods=65).count().ge(65)
            trend=25*((level>ma20).astype(float)+(level>ma60).astype(float)+(ma20>ma60).astype(float)+(slope>0).astype(float))
            cont=sum((50+25*z/vol).clip(0,100) for z in [level/ma20-1,level/ma60-1,ma20/ma60-1,slope])/4
            breadth=otherbr.mean(axis=1).where(nb>=3)
            x=pd.DataFrame({'date':rets.index,'region':region,'family':fam,'peerCount':n.to_numpy(),'peerTrend':trend.where(valid).to_numpy(),'peerContinuous':cont.where(valid).to_numpy(),'peerBreadth':breadth.to_numpy()})
            x['peerMix']=(x.peerContinuous+x.peerBreadth)/2;allrows.append(x)
    pool=pd.concat(allrows,ignore_index=True)
    d=d.merge(pool,on=['region','family','date'],how='left',validate='many_to_one').sort_values(['symbol','date']).reset_index(drop=True)
    local=d.rotationSource.eq('domestic_stock_sector');gg=d.groupby('symbol');d['ownLag']=gg.sectorClean.shift(1)
    coverage=[]
    for c in ['peerTrend','peerContinuous','peerBreadth','peerMix']:
        d[c]=gg[c].shift(1)  # prior Korean observation: no same-day foreign-close dependence
        available=d[c].notna();d[c+'Available']=available
        d[c]=d[c].fillna(d.ownLag)  # explicitly labelled own-regime fallback, never another country
        for region,q in d[~local & d.eligible].groupby('region'):
            coverage.append(dict(candidate=c,region=region,rows=len(q),externalRows=int(q[c+'Available'].sum()),externalCoverage=float(q[c+'Available'].mean()),symbols=q.symbol.nunique()))
    pd.DataFrame(coverage).to_csv(out/'environment-coverage.csv',index=False)
    d[['symbol','date','region','family','peerCount','ownLag','peerTrend','peerContinuous','peerBreadth','peerMix','peerMixAvailable']].to_parquet(out/'environment-inputs.parquet',compression='zstd',index=False)
    return d

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--base',required=True);ap.add_argument('--mapping',required=True);ap.add_argument('--output',required=True);a=ap.parse_args();base=Path(a.base);out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
    m=pd.read_csv(a.mapping,dtype={'symbol':str},keep_default_na=False);m['family']=m.underlyingIndexName.map(family);m[['symbol','name','region','family','underlyingIndexName']].to_csv(out/'environment-families.csv',index=False)
    save_json(out/'design.json',dict(cutoff='2026-09-11',candidates=SPECS,priority='Two remaining points(size + existing Korean benchmark-relative daily jump)/2 *100; rotation and stock-index membership absent from numerator AND denominator. Foreign relative jump stays disabled as in preceding clean policy; no foreign KOSPI substitution.',environment='Domestic-sector score fixed. Other ETFs: same-region plain-equity underlying-return composite and breadth, excluding own economic index family; >=3 other families;1-observation lag; explicit own-regime fallback.',selection='Improve CAGR AND Sharpe in train AND validation with MDD no more than3pp worse than P2_OWN; select highest validation Sharpe. Reused2025+ descriptive.',execution='M0 onset80, underlyingMA60 exit, next open,10slots,15bp each side',sourceRun=35564981988,limitations=['current-universe survival bias','snapshot family/sector mapping','regional ETF proxy is not official market breadth','sparse regions cannot supply an independent environment','Priority foreign relative term remains disabled, not imputed']))
    d=pd.read_parquet(base/'clean-input-panel.parquet');d=d.merge(m[['symbol','family']],on='symbol',validate='many_to_one')
    s=pd.read_csv(base/'stock-sector-signals.csv.gz');d=d.merge(s[['date','sectorCode','rotationScore']],left_on=['date','mappedSectorCode'],right_on=['date','sectorCode'],how='left',validate='many_to_one')
    d=environment(d,out);local=d.rotationSource.eq('domestic_stock_sector');den=np.where(local,5.,4.);rot=d.rotationScore.where(local,0)
    points=(d.priorityClean*den-rot)/100
    assert np.allclose(points,np.round(points),equal_nan=True);points=points.round();assert points.dropna().between(0,2).all();d['priorityTwo']=points/2*100
    oldp=points/den*100;d['commonEligible']=d.eligible&d.ownLag.notna();start=d.loc[d.commonEligible,'date'].min();cal=sorted(d.loc[d.date>=start,'date'].unique())
    # Portfolio includes all price bars, but every model shares the same valid signal mask.
    d['eligible']=d.commonEligible;spans=[('train',start,'2022-12-31'),('validation','2023-01-01','2024-12-31'),('test','2025-01-01',cal[-1]),('all',start,cal[-1]),('legacy_window','2018-01-01',cal[-1])]
    prices={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d[['symbol','date','open','close']].itertuples(index=False)}
    rows=[];counts=[];curves=[];cache={};scopes={'all':d.symbol.unique(),'domestic_sector':d.loc[local,'symbol'].unique(),'other_equity':d.loc[~local,'symbol'].unique()}
    for cid,pm,em in SPECS:
        p=oldp if pm=='old' else points/(den-2)*100 if pm=='index_only' else d.priorityTwo
        env=d.sectorClean.copy()
        if em in ['ownLag','peerTrend','peerContinuous','peerBreadth','peerMix']:env=env.where(local,d[em])
        if em=='neutral':env=env.where(local,50.)
        score=.55*d.techContinuous+.15*p+.15*d.healthClean+.15*env
        if em=='omit':score=score.where(local,(score-.15*env)/.85)
        d['score']=score;prev=d.groupby('symbol').score.shift(1);d['onset']=(prev<80)&(score>=80)
        t=events(d,cid,start);cache[cid]=t
        for scope,syms in scopes.items():
            for split,begin,end in spans:
                q=t[t.symbol.isin(syms)&(t.signalDate>=begin)&(t.entryDate<=end)];c=portfolio(q,prices,[x for x in cal if begin<=x<=end]);rows.append(dict(candidate=cid,scope=scope,split=split,**curve_stats(c)))
                if scope=='all':counts.append(dict(candidate=cid,split=split,matchedEvents=len(q),completed=int((q.exitDate<=end).sum())))
                if scope=='all' and split=='all':c['candidate']=cid;curves.append(c)
        print(json.dumps({'candidate':cid,'events':len(t)}),flush=True)
    p=pd.DataFrame(rows);p.to_csv(out/'portfolio-summary.csv',index=False);pd.DataFrame(counts).to_csv(out/'event-counts.csv',index=False);pd.concat(curves).to_csv(out/'portfolio-curves.csv.gz',index=False)
    # Domestic-sector results must be identical across environment replacements.
    for cid,_,_ in SPECS[3:]:
        a0=p[(p.candidate=='P2_OWN')&(p.scope=='domestic_sector')].sort_values('split');b0=p[(p.candidate==cid)&(p.scope=='domestic_sector')].sort_values('split');assert np.allclose(a0[['cagr','mdd','sharpe']],b0[['cagr','mdd','sharpe']])
    audit=[];passed=[]
    for cid,_,_ in SPECS[3:]:
        ok=True
        for split in ['train','validation']:
            b=p[(p.candidate=='P2_OWN')&(p.scope=='all')&(p.split==split)].iloc[0];r=p[(p.candidate==cid)&(p.scope=='all')&(p.split==split)].iloc[0]
            checks=dict(cagr=bool(r.cagr>b.cagr),sharpe=bool(r.sharpe>b.sharpe),mdd=bool(r.mdd>=b.mdd-.03));audit.append(dict(candidate=cid,split=split,**checks));ok&=all(checks.values())
        if ok:passed.append(cid)
    pd.DataFrame(audit).to_csv(out/'selection-audit.csv',index=False);rank=p[(p.scope=='all')&(p.split=='validation')&p.candidate.isin(passed)].sort_values('sharpe');selected=rank.candidate.iloc[-1] if len(rank) else 'P2_OWN'
    sens=[];fills=[];execstats=[]
    for cid in dict.fromkeys(['P2_OWN',selected,'REF_PREVIOUS']):
        for slots,cost in [(5,.0015),(20,.0015),(10,.003),(10,.0015)]:
            for split,begin,end in spans:
                q=cache[cid];q=q[(q.signalDate>=begin)&(q.entryDate<=end)];cc=[x for x in cal if begin<=x<=end];c=portfolio(q,prices,cc,slots=slots,cost=cost);sens.append(dict(candidate=cid,split=split,slots=slots,costPerSide=cost,**curve_stats(c)))
                if slots==10 and cost==.0015:
                    ff,nav=executed(q,prices,cc);assert np.allclose(nav,c.equity,rtol=1e-12,atol=1e-12)
                    execstats.append(dict(candidate=cid,split=split,entries=len(ff),dataErrorExits=int(((ff.exitDate<=end)&ff.reason.eq('data_unavailable')).sum())))
                    if split=='all':fills.append(ff)
    pd.DataFrame(sens).to_csv(out/'sensitivity.csv',index=False);pd.concat(fills).to_csv(out/'executed-trades.csv',index=False);pd.DataFrame(execstats).to_csv(out/'executed-counts.csv',index=False)
    save_json(out/'decision.json',dict(selected=selected,passed=passed,models=len(SPECS),analysisStart=start,analysisEnd=cal[-1],priorityDenominator=2,rotationPoints=0,indexMembershipPoints=0,domesticSectorInvariantVerified=True,executedNAVVerified=True,productionDeployment=False))
    print(json.dumps({'selected':selected,'passed':passed}),flush=True)
if __name__=='__main__':main()
