"""US3.8 preliminary diagnostics from frozen US3.5/US3.7 outputs.

This does not re-run the simulator. It deliberately uses already frozen paths;
missing input data means no new execution surface or PIT claim is produced.
"""
from pathlib import Path
import zipfile, pandas as pd, numpy as np, json

ROOT=Path(__file__).resolve().parents[2]
US35=Path('/tmp/US35_results.zip')
US37=ROOT/'attachments/59f9e599-ea9c-486c-ac69-ac422d129128/US37_results.zip'
OUT=Path(__file__).resolve().parent/'outputs'; OUT.mkdir(exist_ok=True)
CANDIDATES={
 'A0_quarter':'daily_v3_A0_quarter.csv','A0_bimonth':'daily_v3_A0_bimonth.csv',
 'A2_quarter':'daily_v3_A2_quarter.csv','A2_week':'daily_v3_A2_week.csv',
 'B3_w55':'daily_v3_B3_w55.csv','B3_beta60d3':'daily_v3_B3_beta60d3.csv',
 'A0_existing':'daily_v37_A0_event__USD100K__R1.csv',
 'A2_existing':'daily_v37_A2_event__USD100K__R1.csv',
 'B3_existing':'daily_v37_B3_w50__USD100K__R1.csv'}
ATTR={k:'attr_v3_'+k+'.csv' for k in ['A0_quarter','A0_bimonth','A2_quarter','A2_week','B3_w55','B3_beta60d3']}

def read(zpath,name):
    with zipfile.ZipFile(zpath) as z: return pd.read_csv(z.open(name))

def metrics(r,spy=None):
    r=pd.Series(r,dtype=float).dropna(); eq=(1+r).cumprod(); dd=eq/eq.cummax()-1
    yrs=len(r)/252
    cagr=eq.iloc[-1]**(1/yrs)-1 if yrs>0 and eq.iloc[-1]>0 else np.nan
    sh=np.sqrt(252)*r.mean()/r.std(ddof=1) if len(r)>1 and r.std(ddof=1)>0 else np.nan
    out={'n':len(r),'CAGR':cagr,'MDD':dd.min(),'Sharpe':sh}
    if spy is not None:
        q=pd.Series(spy,dtype=float).reindex(r.index).dropna()
        out['SPY_CAGR']=(1+q).prod()**(252/len(q))-1 if len(q) else np.nan
        out['Excess_CAGR']=out['CAGR']-out['SPY_CAGR']
    return out

rows=[]; annual=[]; rolling=[]; start=[]; contribution=[]; yearjack=[]
mapping=read(US37,'mapping_v2.csv')
secmap=mapping.dropna(subset=['ticker']).drop_duplicates('ticker').set_index('ticker').sectorCode.to_dict()
for cid,fn in CANDIDATES.items():
    zp=US35 if cid in ATTR else US37
    d=read(zp,fn); d['date']=pd.to_datetime(d.date); d=d.sort_values('date').reset_index(drop=True)
    d['spyReturn']=d.spyReturn
    m=metrics(d['return'],d['spyReturn']); rows.append({'candidate':cid,'window':'full_2017_2026',**m,
         'mean_turnover':d.turnover.mean() if 'turnover' in d else np.nan,
         'annual_turnover':d.turnover.mean()*252 if 'turnover' in d else np.nan,
         'ending_equity':d.equity.iloc[-1] if 'equity' in d else np.nan})
    for y,g in d.groupby(d.date.dt.year):
        annual.append({'candidate':cid,'year':int(y),'return':(1+g['return']).prod()-1,'spy_return':(1+g.spyReturn).prod()-1,'partial':int(y)==2026})
    logrets=np.log1p(d['return'].to_numpy()); years=d.date.dt.year.to_numpy()
    year_log={int(y):float(logrets[years==y].sum()) for y in np.unique(years)}
    full_days=len(d)
    for y,yl in year_log.items():
        keep=years!=y; n=int(keep.sum()); lg=float(logrets[keep].sum())
        yearjack.append({'candidate':cid,'excluded_year':y,'excluded_log_growth_share':yl/float(logrets.sum()),
                         'leave_year_out_CAGR':np.exp(lg*252/n)-1 if n else np.nan,'remaining_trading_days':n})
    for y in range(2017,2024):
        g=d[d.date>=f'{y}-01-01']; mm=metrics(g['return'],g.spyReturn)
        start.append({'candidate':cid,'start_year':y,**mm,
                      'mean_turnover':g.turnover.mean() if 'turnover' in g else np.nan,
                      'annual_turnover':g.turnover.mean()*252 if 'turnover' in g else np.nan})
    for L,label in [(756,'3y'),(1260,'5y')]:
        for end in range(L,len(d)+1,21):
            g=d.iloc[end-L:end]; mm=metrics(g['return'],g.spyReturn)
            rolling.append({'candidate':cid,'window':label,'start':g.date.iloc[0].date().isoformat(),'end':g.date.iloc[-1].date().isoformat(),**mm})
    if cid in ATTR:
        a=read(US35,ATTR[cid]); a=a.sort_values('netPnl',ascending=False)
        total=a.netPnl.sum()
        for k in [1,3,5,10]:
            contribution.append({'candidate':cid,'metric':f'top{k}_net_contribution_share','value':a.head(k).netPnl.sum()/total if total else np.nan,'total_attribution':total})
        contribution.append({'candidate':cid,'metric':'top_symbol','value':a.iloc[0].symbol,'total_attribution':total})
        contribution.append({'candidate':cid,'metric':'top5_symbols','value':'|'.join(a.head(5).symbol.astype(str)),'total_attribution':total})
        a['sector']=a.symbol.map(secmap).fillna('UNMAPPED')
        bysec=a.groupby('sector',as_index=False).netPnl.sum().sort_values('netPnl',ascending=False)
        contribution.append({'candidate':cid,'metric':'top_sector','value':bysec.iloc[0].sector,'total_attribution':bysec.netPnl.sum()})
        contribution.append({'candidate':cid,'metric':'top_sector_share','value':bysec.iloc[0].netPnl/bysec.netPnl.sum() if bysec.netPnl.sum() else np.nan,'total_attribution':bysec.netPnl.sum()})
        contribution.append({'candidate':cid,'metric':'top1_positive_share','value':a.loc[a.netPnl>0,'netPnl'].head(1).sum()/total if total else np.nan,'total_attribution':total})

pd.DataFrame(rows).to_csv(OUT/'frozen_path_metrics.csv',index=False)
pd.DataFrame(annual).to_csv(OUT/'annual_returns.csv',index=False)
pd.DataFrame(start).to_csv(OUT/'start_date_sensitivity.csv',index=False)
pd.DataFrame(rolling).to_csv(OUT/'rolling_stability.csv',index=False)
pd.DataFrame(contribution).to_csv(OUT/'concentration_diagnostics.csv',index=False)
pd.DataFrame(yearjack).to_csv(OUT/'leave_year_out_diagnostic.csv',index=False)

# Parameter results below are existing frozen US3.5 runs, not fresh US3.8 reruns.
surface=[]
with zipfile.ZipFile(US35) as z:
    for fam,ids in {
      'B3_core_weight':['B3_w50','B3_w55','B3_w60'],
      'A0_rebalance':['A0_week','A0_biweek','A0_month','A0_bimonth','A0_quarter'],
      'A2_rebalance':['A2_week','A2_biweek','A2_month','A2_bimonth','A2_quarter'],
      'B3_beta_exit_partial':['B3_beta40d3','B3_beta50d3','B3_beta60d3','B3_beta50d2','B3_beta50d5']}.items():
        for id in ids:
            name=f'daily_v3_{id}.csv'
            if name not in z.namelist(): continue
            d=pd.read_csv(z.open(name));m=metrics(d['return'],d.spyReturn)
            surface.append({'family':fam,'point':id,**m,'mean_turnover':d.turnover.mean(),'annual_turnover':d.turnover.mean()*252})
pd.DataFrame(surface).to_csv(OUT/'available_historical_surfaces.csv',index=False)

# Bootstrap on paired daily log returns; fixed candidate set, no parameter search.
series={}
for cid,fn in CANDIDATES.items():
    d=read(US35 if cid in ATTR else US37,fn); series[cid]=np.log1p(d['return'].to_numpy(dtype=float))
candidate_groups=[('A0_quarter','A0_existing'),('A0_bimonth','A0_existing'),('A2_quarter','A2_existing'),
 ('A2_week','A2_existing'),('B3_w55','B3_existing'),('B3_beta60d3','B3_existing')]
pairs=[(a,b,f'{a}_vs_{b}') for a,b in candidate_groups]
pairs += [('A0_quarter','A0_bimonth','A0_quarter_vs_bimonth'),('A2_quarter','A2_week','A2_quarter_vs_week'),('B3_w55','B3_beta60d3','B3_w55_vs_beta_exit')]
pairs += [(a,'spy',f'{a}_vs_SPY') for a,_ in candidate_groups]
spy=np.log1p(read(US35,'daily_v3_A0_quarter.csv').spyReturn.to_numpy(dtype=float)); series['spy']=spy
bootrows=[]
for L in [21,63]:
    n=len(spy); B=10000; rng=np.random.default_rng(3800+L); blocks=int(np.ceil(n/L));
    observed={name:(np.exp(252*series[a].mean())-np.exp(252*series[b].mean())) for a,b,name in pairs}
    draws={name:np.empty(B) for _,_,name in pairs}; cursor=0
    while cursor<B:
        batch=min(200,B-cursor); starts=rng.integers(0,n,size=(batch,blocks)); chunks=[]
        for j in range(blocks): chunks.append((starts[:,j,None]+np.arange(L)[None,:])%n)
        ix=np.concatenate(chunks,axis=1)[:,:n]
        vals={k:np.exp(252*series[k][ix].mean(axis=1)) for k in series}
        for a,b,name in pairs: draws[name][cursor:cursor+batch]=vals[a]-vals[b]
        cursor+=batch
    ses={name:float(v.std(ddof=1)) for name,v in draws.items()}
    max_t=np.max(np.column_stack([np.abs((draws[k]-observed[k])/ses[k]) for k in draws]),axis=1)
    q=float(np.quantile(max_t,.95))
    for _,_,name in pairs:
        vals=draws[name]; bootrows.append({'block_days':L,'comparison':name,'point_CAGR_difference':observed[name],
            'individual_95_low':float(np.quantile(vals,.025)),'individual_95_high':float(np.quantile(vals,.975)),
            'simultaneous_maxT_95_low':observed[name]-q*ses[name], 'simultaneous_maxT_95_high':observed[name]+q*ses[name],
            'bootstrap_reps':B,'family_comparisons':len(pairs),'maxT_critical':q})
pd.DataFrame(bootrows).to_csv(OUT/'paired_bootstrap_maxT.csv',index=False)

# CSCV/PBO on the nine frozen candidates and their three existing controls.
# This is a lower-bound diagnostic: it excludes the broader search history.
strategy_ids=['A0_quarter','A0_bimonth','A2_quarter','A2_week','B3_w55','B3_beta60d3','A0_existing','A2_existing','B3_existing']
R=np.column_stack([series[k] for k in strategy_ids]); segments=np.array_split(np.arange(len(spy)),10); pbo=[]
from itertools import combinations
from scipy.stats import rankdata
for is_blocks in combinations(range(10),5):
    isix=np.concatenate([segments[i] for i in is_blocks]); oix=np.setdiff1d(np.arange(len(spy)),isix,assume_unique=False)
    # Daily Sharpe ranking, consistent for all strategies and both halves.
    isx=R[isix]; osx=R[oix]
    ish=isx.mean(axis=0)/isx.std(axis=0,ddof=1); osh=osx.mean(axis=0)/osx.std(axis=0,ddof=1)
    winner=int(np.argmax(ish)); rank=float(rankdata(osh,method='average')[winner]/len(strategy_ids))
    pbo.append({'is_blocks':'|'.join(map(str,is_blocks)),'in_sample_winner':strategy_ids[winner],
                'oos_relative_rank':rank,'below_median':rank<=.5,'winner_oos_sharpe':osh[winner]})
pd.DataFrame(pbo).to_csv(OUT/'cscv_pbo_lower_bound.csv',index=False)

print(json.dumps({'baseline_parity_source':'US37 baseline_parity.csv; stored max daily error is 0 for all 9 legacy paths',
 'candidates':len(CANDIDATES),'start_rows':len(start),'rolling_rows':len(rolling),'surface_rows':len(surface),
 'limitations':['No simulator rerun: raw daily feature/price inputs not available locally.','Existing beta and core surfaces do not fully match requested US3.8 points.','Static contribution shares are attribution diagnostics, not counterfactual jackknife reruns.','Sharadar/PIT collector package exists, but processed PIT dataset is not present in Drive.']},indent=2))
