from pathlib import Path
import os
import pandas as pd,numpy as np,json,zipfile,hashlib
OUT=Path(os.environ.get('US33_DATA_ROOT','/content/drive/MyDrive/미국주식데이터'))/'US33_validation_20260927'
RUNTIME=Path(os.environ.get('US33_RUNTIME_ROOT','/content'))
s=pd.read_csv(OUT/'validation_summary.csv')
s=pd.concat([s,pd.read_csv(OUT/'consistent_validation_summary.csv'),pd.read_csv(OUT/'verified_validation_summary.csv')],ignore_index=True)
ref=pd.read_csv(OUT/'reference_prior_holdings_results.csv')
checks=[]
for r in ref[ref.max_positions.isin([15,20])].itertuples():
    config=f'{r.label}_N{r.max_positions}_SC{r.sector_cap}'
    for period,expected in [('train',r.trainCAGR),('reviewed',r.testCAGR),('full',r.fullCAGR)]:
        q=s[(s.dataset=='legacy')&(s.engine=='replay')&(s.config==config)&(s.period==period)]
        actual=q.CAGR.iloc[0]
        checks.append(dict(config=config,period=period,expected=expected,actual=actual,difference=actual-expected,pass_1bp=abs(actual-expected)<.0001))
pd.DataFrame(checks).to_csv(OUT/'reproduction_check.csv',index=False)
assert all(x['pass_1bp'] for x in checks), 'Original research reproduction failed'
# Paired comparisons use the same engine, frozen sector classification rules (not point-in-time sectors), price source and dates.
base=s[(s.engine=='ledger')&~s.config.str.contains('ZERO|COST2')]
a=base[base.dataset=='survivor_consistent'];b=base[base.dataset=='full_verified']
comp=a.merge(b,on=['config','period'],suffixes=('_survivor','_historical'))
for col in ['CAGR','Sharpe','MDD']:comp[col+'_survivor_minus_historical']=comp[col+'_survivor']-comp[col+'_historical']
comp.to_csv(OUT/'survivorship_comparison.csv',index=False)
full=base[(base.dataset=='full_verified')&base.period.isin(['train','reviewed','full'])]
full.to_csv(OUT/'eight_strategies.csv',index=False)
rows=[];rng=np.random.default_rng(330927)
def daily(config):
    return pd.read_csv(OUT/f'daily_full_verified_ledger_{config}.csv',parse_dates=['date']).set_index('date')
for style,cap in [('AGGRESSIVE',2),('BALANCED',3)]:
    pairs=[(f'{style}_N20_SC{c}',f'{style}_N15_SC{c}','N20-minus-N15') for c in [cap,'NONE']]
    pairs += [(f'{style}_N{n}_SCNONE',f'{style}_N{n}_SC{cap}','no-cap-minus-cap') for n in [15,20]]
    for x,y,label in pairs:
        dx,dy=daily(x),daily(y)
        for period,start in [('full','2017-01-01'),('reviewed','2023-01-01')]:
            v=pd.concat([dx.netReturn,dy.netReturn],axis=1).dropna().loc[start:].to_numpy()
            n=len(v);samples=[]
            for _ in range(1000):
                starts=rng.integers(0,n,size=int(np.ceil(n/21)))
                ind=((starts[:,None]+np.arange(21))%n).ravel()[:n]
                r=v[ind];c=np.exp(np.log1p(r).sum(axis=0)*252/n)-1;samples.append(c[0]-c[1])
            actual=np.exp(np.log1p(v).sum(axis=0)*252/n)-1
            rows.append(dict(style=style,comparison=label,a=x,b=y,period=period,CAGR_difference=actual[0]-actual[1],
                             block21_ci_low=np.quantile(samples,.025),block21_ci_high=np.quantile(samples,.975)))
pd.DataFrame(rows).to_csv(OUT/'paired_sensitivity.csv',index=False)
# Content hashes make the executed source files auditable without copying raw licensed data.
manifest={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.glob('*.py')}
(OUT/'validation_source_hashes.json').write_text(json.dumps(manifest,indent=2))
with zipfile.ZipFile(OUT/'validation_results.zip','w',zipfile.ZIP_DEFLATED) as z:
    for p in OUT.iterdir():
        if p.suffix in ['.csv','.json','.py'] and p.stat().st_size<100_000_000:z.write(p,p.name)
print('REPRODUCTION',pd.DataFrame(checks).to_string(index=False),flush=True)
print('EIGHT_STRATEGIES',full[['config','period','CAGR','Sharpe','MDD','avgPositions','lockedDays']].to_string(index=False),flush=True)
print('SURVIVORSHIP',comp[comp.period.isin(['full','reviewed'])][['config','period','CAGR_survivor','CAGR_historical','CAGR_survivor_minus_historical']].to_string(index=False),flush=True)
print('ANALYSIS_COMPLETE',flush=True)
