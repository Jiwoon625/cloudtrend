#!/usr/bin/env python3
"""Fixed peer-mix environment; predeclared Priority weight revalidation."""
import argparse,json
from pathlib import Path
import numpy as np
import pandas as pd
from research_etf_m0_clean import events,save_json
from research_etf_m0_enhance import portfolio,curve_stats
from research_etf_m0_clean_followup import executed

WEIGHTS=[0,5,7.5,10,15]
def main():
    ap=argparse.ArgumentParser()
    for k in ['base','environment','mapping','output']:ap.add_argument('--'+k,required=True)
    a=ap.parse_args();base=Path(a.base);env=Path(a.environment);out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
    save_json(out/'design.json',dict(priorityWeights=WEIGHTS,technicalWeight='70-Priority',healthWeight=15,environmentWeight=15,environment='peerMix:50%continuous regional trend +50%peer breadth, lag1, leave-own-family-out, minimum3 other families; ownLag fallback; domestic stock-sector fixed',adoptionBasis='User instruction; earlier environment performance was not superior',entry='80 onset',exit='underlying MA60; next open; separate invalid-data exit',cutoff='2026-09-11',selection='Train AND validation CAGR/Sharpe improve vsP15; MDD at most3pp worse; choose validation Sharpe among passers. Reused test descriptive.',baseRun=35564981988,environmentRun=35566534880))
    d=pd.read_parquet(base/'clean-input-panel.parquet');e=pd.read_parquet(env/'environment-inputs.parquet');d=d.merge(e[['symbol','date','ownLag','peerMix','peerMixAvailable']],on=['symbol','date'],validate='one_to_one')
    s=pd.read_csv(base/'stock-sector-signals.csv.gz');d=d.merge(s[['date','sectorCode','rotationScore']],left_on=['date','mappedSectorCode'],right_on=['date','sectorCode'],how='left',validate='many_to_one').sort_values(['symbol','date']).reset_index(drop=True)
    local=d.rotationSource.eq('domestic_stock_sector');den=np.where(local,5.,4.);rot=d.rotationScore.where(local,0)
    pts=(d.priorityClean*den-rot)/100;assert np.allclose(pts,pts.round(),equal_nan=True);d['priorityTwo']=pts.round()/2*100
    d['environmentScore']=d.sectorClean.where(local,d.peerMix)
    d['environmentSource']=np.where(local,'domestic_stock_sector',np.where(d.peerMixAvailable,'regional_peer_mix_lag1','own_underlying_regime_lag1_fallback'))
    d['eligible']=d.eligible&d.ownLag.notna();start=d.loc[d.eligible,'date'].min();cal=sorted(d.loc[d.date>=start,'date'].unique());assert cal[-1]=='2026-09-11'
    m=pd.read_csv(a.mapping,dtype={'symbol':str},keep_default_na=False);last=d[d.date==cal[-1]][['symbol','environmentSource','environmentScore','eligible']]
    route=m.merge(last,on='symbol',how='left',validate='one_to_one');route['environmentSource']=route.environmentSource.fillna('excluded_nonplain_equity');route.to_csv(out/'etf-environment-routing-20260911.csv',index=False)
    panelcols=['symbol','name','date','region','mappedSectorCode','open','close','etfUnderlyingIndexClose','uMa60','techContinuous','priorityTwo','healthClean','environmentScore','environmentSource','eligible']
    d[panelcols].to_parquet(out/'adopted-environment-panel.parquet',compression='zstd',index=False)
    prices={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d[['symbol','date','open','close']].itertuples(index=False)}
    spans=[('train',start,'2022-12-31'),('validation','2023-01-01','2024-12-31'),('test','2025-01-01',cal[-1]),('all',start,cal[-1]),('legacy_window','2018-01-01',cal[-1])]
    scopes={'all':set(d.symbol),'domestic_sector':set(d.loc[local,'symbol']),'other_equity':set(d.loc[~local,'symbol'])};rows=[];curves=[];cache={};counts=[]
    for weight in WEIGHTS:
        cid='P'+str(weight);d['score']=(70-weight)/100*d.techContinuous+weight/100*d.priorityTwo+.15*d.healthClean+.15*d.environmentScore
        prev=d.groupby('symbol').score.shift(1);d['onset']=(prev<80)&(d.score>=80);t=events(d,cid,start);cache[cid]=t
        for scope,syms in scopes.items():
            for split,begin,end in spans:
                q=t[t.symbol.isin(syms)&(t.signalDate>=begin)&(t.entryDate<=end)];c=portfolio(q,prices,[x for x in cal if begin<=x<=end]);rows.append(dict(candidate=cid,priorityWeight=weight,technicalWeight=70-weight,scope=scope,split=split,**curve_stats(c)))
                if scope=='all' and split=='all':c['candidate']=cid;curves.append(c)
        print(json.dumps({'candidate':cid,'events':len(t)}),flush=True)
    p=pd.DataFrame(rows);p.to_csv(out/'portfolio-summary.csv',index=False);pd.concat(curves).to_csv(out/'portfolio-curves.csv.gz',index=False)
    old=pd.read_csv(env/'portfolio-summary.csv');old=old[old.candidate=='P2_PEER_MIX'].sort_values(['scope','split']);new=p[p.candidate=='P15'].sort_values(['scope','split']);assert np.allclose(old[['cagr','mdd','sharpe']],new[['cagr','mdd','sharpe']],atol=1e-10,rtol=1e-10)
    audit=[];passed=[]
    for w in WEIGHTS[:-1]:
        cid='P'+str(w);ok=True
        for split in ['train','validation']:
            b=p[(p.candidate=='P15')&(p.scope=='all')&(p.split==split)].iloc[0];r=p[(p.candidate==cid)&(p.scope=='all')&(p.split==split)].iloc[0]
            ck=dict(cagr=bool(r.cagr>b.cagr),sharpe=bool(r.sharpe>b.sharpe),mdd=bool(r.mdd>=b.mdd-.03));audit.append(dict(candidate=cid,split=split,**ck));ok&=all(ck.values())
        if ok:passed.append(cid)
    pd.DataFrame(audit).to_csv(out/'selection-audit.csv',index=False);rank=p[(p.scope=='all')&(p.split=='validation')&p.candidate.isin(passed)].sort_values('sharpe');pick=rank.candidate.iloc[-1] if len(rank) else 'P15'
    sens=[];fills=[]
    for cid,t in cache.items():
        for slots,cost in [(5,.0015),(20,.0015),(10,.003),(10,.0015)]:
            for split,begin,end in spans:
                q=t[(t.signalDate>=begin)&(t.entryDate<=end)];cc=[x for x in cal if begin<=x<=end];c=portfolio(q,prices,cc,slots=slots,cost=cost);sens.append(dict(candidate=cid,split=split,slots=slots,costPerSide=cost,**curve_stats(c)))
                if slots==10 and cost==.0015 and cid in ['P15',pick]:
                    f,nav=executed(q,prices,cc);assert np.allclose(nav,c.equity,atol=1e-12,rtol=1e-12);counts.append(dict(candidate=cid,split=split,entries=len(f),dataErrorExits=int(((f.exitDate<=end)&f.reason.eq('data_unavailable')).sum())))
                    if split=='all':fills.append(f)
    pd.DataFrame(sens).to_csv(out/'sensitivity.csv',index=False);pd.concat(fills).to_csv(out/'executed-trades.csv',index=False);pd.DataFrame(counts).to_csv(out/'executed-counts.csv',index=False)
    picked_weight=float(p[p.candidate==pick].priorityWeight.iloc[0]);policy=json.loads(Path('research/etf-m0-provisional-policy.json').read_text())
    policy.update(status='user_authorized_environment_with_revalidated_priority_weight',model='continuous_M0_peer_environment',weights={'technicalContinuous':70-picked_weight,'priorityTwo':picked_weight,'healthCapLiquidityPlain':15,'marketSectorMapped':15},componentStudyDecision='Priority weight selected by train and validation only; external environment imposed by user, not claimed superior to old environment',researchChallengers=[],researchResult={'selected':pick,'passed':passed,'cutoff':cal[-1],'outOfSampleStatus':'reused retrospective holdout'},productionDeployment=False)
    policy['marketSector']['otherEquity']='Peer mix where available; lagged own-index regime fallback; domestic stock-sector unchanged';policy['marketSector']['environmentStudy']['adoptionBasis']='Explicit user instruction';policy['marketSector']['environmentStudy']['weightStudySource']='results/etf-m0-priority-weights/20260911';policy.pop('historicalReference',None)
    save_json(out/'provisional-policy.json',policy);save_json(out/'decision.json',dict(selected=pick,passed=passed,priorityWeight=picked_weight,technicalWeight=70-picked_weight,baselineReproduced=True,executedNAVVerified=True,environmentRoutingCounts=route.environmentSource.value_counts().to_dict(),productionDeployment=False))
    d['m0Applied']=(70-picked_weight)/100*d.techContinuous+picked_weight/100*d.priorityTwo+.15*d.healthClean+.15*d.environmentScore
    d['onsetApplied']=(d.groupby('symbol').m0Applied.shift(1)<80)&(d.m0Applied>=80)&d.eligible
    d[panelcols+['m0Applied','onsetApplied']].to_parquet(out/'adopted-environment-panel.parquet',compression='zstd',index=False)
    print(json.dumps({'selected':pick,'passed':passed,'priorityWeight':picked_weight}),flush=True)
if __name__=='__main__':main()
