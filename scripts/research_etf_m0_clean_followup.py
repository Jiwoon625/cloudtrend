#!/usr/bin/env python3
"""One predeclared interaction: selected rotation removal plus the existing quality gate."""
import argparse,json
from pathlib import Path
import numpy as np
import pandas as pd
from research_etf_m0_clean import events,save_json
from research_etf_m0_enhance import portfolio,curve_stats

def executed(t,prices,cal,slots=10,cost=.0015):
    by={k:g for k,g in t.groupby('entryDate')};held={};cash=1.;fills=[];marks=[]
    for day in cal:
        for sym,p in list(held.items()):
            if p['exitDate']==day:cash+=p['units']*p['exitOpen']*(1-cost);del held[sym]
        nav=cash+sum(p['units']*prices.get((sym,day),{}).get('open',p['last']) for sym,p in held.items())
        if day in by:
            for _,r in by[day].sort_values('symbol').iterrows():
                if len(held)>=slots or r.symbol in held:continue
                amount=min(nav/slots,cash)
                if amount<1e-10:continue
                cash-=amount;p=r.to_dict();p.update(units=amount/(r.entryOpen*(1+cost)),last=r.entryOpen);held[r.symbol]=p
                fills.append({**r.to_dict(),'entryWeight':amount/nav})
        for sym,p in held.items():p['last']=prices.get((sym,day),{}).get('close',p['last'])
        marks.append(cash+sum(p['units']*p['last'] for p in held.values()))
    return pd.DataFrame(fills),np.array(marks)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--base',required=True);ap.add_argument('--output',required=True);a=ap.parse_args();base=Path(a.base);out=Path(a.output);out.mkdir(parents=True,exist_ok=True)
    save_json(out/'followup-design.json',{'baseRun':35564981988,'basePrefix':'results/etf-m0-clean-inputs/20260911/35564981988','candidates':['DROP_P_ROTATION','DROP_P_ROTATION_GATE'],'onlyNewRule':'At original onset close: KRX marketCap>=50bn KRW and trailing20 average tradingValue>=1bn KRW. No delayed onset.','decision':'Add gate only if train AND validation CAGR and Sharpe improve without MDD deterioration>3pp; reused test descriptive only.','cutoff':'2026-09-11'})
    d=pd.read_parquet(base/'clean-input-panel.parquet');s=pd.read_csv(base/'stock-sector-signals.csv.gz');d=d.merge(s[['date','sectorCode','rotationScore']],left_on=['date','mappedSectorCode'],right_on=['date','sectorCode'],how='left',validate='many_to_one').sort_values(['symbol','date']).reset_index(drop=True)
    local=d.rotationSource.eq('domestic_stock_sector');rot=d.rotationScore.where(local,0);den=np.where(local,5.,4.)
    d['score']=.55*d.techContinuous+.15*(d.priorityClean-rot/den)+.15*d.healthClean+.15*d.sectorClean
    prev=d.groupby('symbol').score.shift(1);onset=(prev<80)&(d.score>=80)
    start=d.loc[d.eligible,'date'].min();cal=sorted(d.loc[d.date>=start,'date'].unique());spans=[('train',start,'2022-12-31'),('validation','2023-01-01','2024-12-31'),('test','2025-01-01',cal[-1]),('all',start,cal[-1])]
    prices={(r.symbol,r.date):dict(open=r.open,close=r.close) for r in d[['symbol','date','open','close']].itertuples(index=False)}
    rows=[];counts=[];allfills=[];curves=[];reproduced=[]
    for cid in ['DROP_P_ROTATION','DROP_P_ROTATION_GATE']:
        d['onset']=onset
        if cid.endswith('_GATE'):d['onset']=onset&(d.etfMarketCap>=50e9)&(d.healthTv20>=1e9)
        t=events(d,cid,start)
        for slots in [5,10,20]:
            for cost in [.0015,.003]:
                for split,begin,end in spans:
                    q=t[(t.signalDate>=begin)&(t.entryDate<=end)];c=portfolio(q,prices,[x for x in cal if begin<=x<=end],slots=slots,cost=cost);row=dict(candidate=cid,split=split,slots=slots,costPerSide=cost,**curve_stats(c));rows.append(row)
                    if slots==10 and cost==.0015:
                        fills,mark=executed(q,prices,[x for x in cal if begin<=x<=end]);assert np.allclose(mark,c.equity,atol=1e-12,rtol=1e-12)
                        counts.append(dict(candidate=cid,split=split,executedEntries=len(fills),completed=int((fills.exitDate<=end).sum()),executedDataErrorExits=int(((fills.exitDate<=end)&fills.reason.eq('data_unavailable')).sum())))
                        if split=='all':allfills.append(fills);c['candidate']=cid;curves.append(c)
                        if cid=='DROP_P_ROTATION':
                            old=pd.read_csv(base/'portfolio-summary.csv').query("candidate=='DROP_P_ROTATION' and split==@split").iloc[0]
                            assert all(abs(row[k]-old[k])<1e-10 for k in ['cagr','mdd','sharpe']);reproduced.append(split)
    p=pd.DataFrame(rows);p.to_csv(out/'gate-interaction.csv',index=False);pd.DataFrame(counts).to_csv(out/'executed-counts.csv',index=False);pd.concat(allfills).to_csv(out/'executed-trades.csv',index=False);pd.concat(curves).to_csv(out/'portfolio-curves.csv.gz',index=False)
    q=p[(p.slots==10)&(p.costPerSide==.0015)];audit=[]
    for split in ['train','validation']:
        b=q[(q.candidate=='DROP_P_ROTATION')&(q.split==split)].iloc[0];c=q[(q.candidate=='DROP_P_ROTATION_GATE')&(q.split==split)].iloc[0]
        audit.append(dict(split=split,cagr=bool(c.cagr>b.cagr),sharpe=bool(c.sharpe>b.sharpe),mdd=bool(c.mdd>=b.mdd-.03)))
    passed=all(x['cagr'] and x['sharpe'] and x['mdd'] for x in audit)
    chosen='DROP_P_ROTATION_GATE' if passed else 'DROP_P_ROTATION'
    save_json(out/'followup-decision.json',dict(selected=chosen,gatePassed=passed,audit=audit,baseReproducedSplits=reproduced,executedNAVReproduced=True,productionChange=False));print(json.dumps({'selected':chosen,'gatePassed':passed,'baseReproduced':True}))
if __name__=='__main__':main()
