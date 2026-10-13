"""Descriptive year/sector supplements. No new hypothesis tests or strategy tuning."""
import json,sys
from pathlib import Path
import pandas as pd
from core import regression

def main(analysis,output):
    a,out=Path(analysis),Path(output);out.mkdir(exist_ok=True,parents=True)
    d=pd.read_parquet(a/'confirmation_observations.parquet')
    d=d[d.horizon.eq(20)&d.date.ge('2018-01-01')].copy();d['year']=d.date.str[:4]
    rows=[]
    for (market,year),g in d.groupby(['market','year']):
        for feature in ['X1','X2']:
            obs=g[g.status.eq('OBSERVED')];common=obs[obs['peer_'+feature].notna()];selected=common[common['peer_'+feature]>0]
            rows.append(dict(market=market,year=year,feature=feature,all_candidates=len(g),observed_n=len(obs),common_n=len(common),selected_n=len(selected),common_mean=common.target.mean(),selected_mean=selected.target.mean(),effect=selected.target.mean()-common.target.mean(),inference='DESCRIPTIVE_ONLY'))
    pd.DataFrame(rows).to_parquet(out/'annual_confirmation.parquet',index=False)
    c=pd.read_parquet(a/'leadlag_observations.parquet');c=c[c.horizon.eq(5)].copy();c['year']=c.date.str[:4]
    rows=[]
    for (market,sector,year),g in c.groupby(['market','sector','year']):
        controls=['local_X1','local_X2','local_market_ret20','local_market_vol20','fx_change20']+(['global_spy20'] if market=='KR' else [])
        for feature in ['X1','X2']:
            rec,_=regression(g,'peer_'+feature,controls);rec.update(market=market,sector=sector,year=year,feature=feature,inference='DESCRIPTIVE_ONLY');rows.append(rec)
    pd.DataFrame(rows).to_parquet(out/'annual_leadlag.parquet',index=False)
    rows=[];excluding=[]
    for market,g in d[d.period.eq('validation')&d.status.eq('OBSERVED')].groupby('market'):
        for feature in ['X1','X2']:
            common=g[g['peer_'+feature].notna()];selected=common[common['peer_'+feature]>0]
            for sec,base in common.groupby('sector'):
                subset=selected[selected.sector.eq(sec)]
                rows.append(dict(market=market,feature=feature,sector=sec,common_n=len(base),selected_n=len(subset),effect_contribution=subset.target.sum()/len(selected)-base.target.sum()/len(common),interpretation='Includes within-sector effects and selected sector mix; sums to total descriptive effect'))
            ex=common[~common.sector.eq('SEMI')];se=ex[ex['peer_'+feature]>0]
            excluding.append(dict(market=market,feature=feature,ex_semi_effect=se.target.mean()-ex.target.mean(),common_n=len(ex),selected_n=len(se)))
    pd.DataFrame(rows).to_parquet(out/'sector_effect_contribution.parquet',index=False)
    (out/'ex_semiconductor_diagnostic.json').write_text(json.dumps(excluding,indent=2))
    for stem,h in [('confirmation',20),('leadlag',5)]:
        r=pd.read_parquet(a/(stem+'_results.parquet'));r=r[r.period.eq('validation')&r.horizon.eq(h)]
        (out/('primary_'+stem+'.json')).write_text(r.to_json(orient='records',force_ascii=False,indent=2))
if __name__=='__main__':main(sys.argv[1],sys.argv[2])
