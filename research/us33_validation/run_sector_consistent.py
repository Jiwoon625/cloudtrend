"""Keep v1.1 taxonomy and old issuer assignments; explicitly labelled extensions for new issuers."""
from pathlib import Path
import os
import runpy,duckdb,pandas as pd,numpy as np,json,gc
OUT=Path(os.environ.get('US33_DATA_ROOT','/content/drive/MyDrive/미국주식데이터'))/'US33_validation_20260927'
RUNTIME=Path(os.environ.get('US33_RUNTIME_ROOT','/content'))
ns=runpy.run_path(str(OUT/'run_validation.py'))
con=duckdb.connect(str(RUNTIME/'us33_validation.duckdb'));con.execute("SET memory_limit='3GB'");con.execute('SET threads=2')
sector=pd.read_csv(OUT/'sector_map_extended.csv',keep_default_na=False).set_index('ticker').sectorCode.to_dict()
dates,names,ids,op,mark,ok,terminal,spyold,spynew=ns['prepare_prices'](con,False)
di={d:i for i,d in enumerate(dates)};summaries=[]
for source,dataset in [('matched_pit','matched_consistent'),('survivor_pit','survivor_consistent'),('full_pit','full_consistent')]:
    states=[ns['State'](c,'ledger') for c in ns['CONFIGS']]
    if dataset=='full_consistent':
        states += [ns['State'](c,'ledger',stress=True) for c in ns['CONFIGS']]+[ns['State'](c,'ledger',cost=.003) for c in ns['CONFIGS']]
    prev={}
    for path in sorted(((RUNTIME/'us33_work')/source).glob('year=*.parquet')):
        f=pd.read_parquet(path);f['dt']=pd.to_datetime(f['dt']);f=f[f.mom_pct.notna()];f['k']=f.symbol.map(ids);f['sectorCode']=f.symbol.map(sector).fillna('UNKNOWN')
        for day,g in f.groupby('dt',sort=True):
            i=di.get(day)
            if i is None or i+2>=len(dates):continue
            rows={r.k:(r.mom_pct,r.sectorCode) for r in g.itertuples(index=False)}
            p=g[(g.mom_pct>=.8)&(g.dr_beta60_spy>=.9)&(g.dr_log_dollarvol20>=.1)&(g.dr_amihud20>=.1)].copy()
            pp=p.k.map(prev);p=p[pp.isna()|(pp<.8)];pools={}
            for style,fc in [('AGGRESSIVE','dr_ichimoku_tk_gap'),('BALANCED','dr_relvol1_20')]:
                pools[style]=p[p[fc]>=.8].sort_values(['mom_pct','dr_beta60_spy',fc,'symbol'],ascending=[False,False,False,True]).k.to_list()
            for st in states:ns['ledger'](st,i,rows,pools,mark,ok,terminal,dates,spynew,names)
            prev.update({k:v[0] for k,v in rows.items()})
        print('CONSISTENT',dataset,path.name,flush=True)
    for st in states:
        last=len(dates)-1;fee=0.;turn=0.
        for k,p in st.p.items():
            if ok[last,k]:fee+=st.cost*p['v'];turn+=p['v']/st.nav;st.pnl(k,-st.cost*p['v'])
            st.trades.append(dict(symbol=names[k],entryDate=p['date'],exitDate=dates[last],exitReason='END_MARK' if not ok[last,k] else 'END_OF_SAMPLE',grossTradeReturn=p['cum']-1))
        before=st.nav;st.nav-=fee;st.daily[-1]['netReturn']=(1+st.daily[-1]['netReturn'])*(st.nav/before)-1
        st.daily[-1]['equity']=st.nav;st.daily[-1]['turnover']+=turn
        summaries += ns['finish'](st,names,dataset)
    pd.DataFrame(summaries).to_csv(OUT/'consistent_validation_summary.csv',index=False)
    print('CONSISTENT_DONE',dataset,flush=True)
con.close()
# No-cap returns must be invariant to sector assignments.
base=pd.read_csv(OUT/'validation_summary.csv');new=pd.DataFrame(summaries)
a=base[(base.dataset=='full_pit')&base.config.str.endswith('SCNONE')&base.period.eq('full')]
b=new[(new.dataset=='full_consistent')&new.config.str.endswith('SCNONE')&new.period.eq('full')]
check=a.merge(b,on=['config','period'],suffixes=('_sic','_consistent'))
assert np.allclose(check.CAGR_sic,check.CAGR_consistent,atol=1e-12)
check.to_csv(OUT/'sector_invariance_check.csv',index=False)
print('CONSISTENT_ALL_COMPLETE',flush=True)
