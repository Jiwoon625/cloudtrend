"""Gate-approved saved-path statistics and source-level PIT completeness audit.

Executed in run_us38_gate globals after baseline parity. No parameter selection.
"""
from itertools import combinations
from scipy.stats import rankdata
shutil.copy2(analysis_path,OUT/'analyze_us38_gate.py')
rolling=[]
for v,df in baseline_daily.items():
    for length,label in [(756,'3y_756_sessions'),(1260,'5y_1260_sessions')]:
        for end in range(length,len(df)+1,21):
            g=df.iloc[end-length:end]
            rolling.append(dict(variant=v,window=label,start=str(g.date.iloc[0].date()),end=str(g.date.iloc[-1].date()),method='overlapping slices of continuous portfolio; NOT fresh cash',**metrics(g)))
pd.DataFrame(rolling).to_csv(OUT/'rolling_3y_5y.csv',index=False)

# Require identical dates and benchmarks before common paired resampling.
anchor_df=baseline_daily[VARIANTS[0]]
for df in baseline_daily.values():
    assert df.date.equals(anchor_df.date)
    np.testing.assert_array_equal(df.spyReturn.to_numpy(),anchor_df.spyReturn.to_numpy())
series={v:np.log1p(df['return'].to_numpy()) for v,df in baseline_daily.items()}
series['SPY']=np.log1p(anchor_df.spyReturn.to_numpy())
own={'A0_quarter':'A0_event','A0_bimonth':'A0_event','A2_quarter':'A2_event','A2_week':'A2_event','B3_w55':'B3_w50','B3_beta60d3':'B3_w50'}
pairs=list(own.items())+[('A0_quarter','A0_bimonth'),('A2_quarter','A2_week'),('B3_w55','B3_beta60d3')]+[(v,'SPY') for v in CANDIDATES]
boot=[]
for length in [21,63]:
    n=len(anchor_df);B=10000;rng=np.random.default_rng(3800+length);blocks=int(np.ceil(n/length))
    observed=np.array([np.exp(252*series[a].mean())-np.exp(252*series[b].mean()) for a,b in pairs])
    draws=np.empty((B,len(pairs)))
    for cursor in range(0,B,200):
        batch=min(200,B-cursor);starts=rng.integers(0,n,size=(batch,blocks))
        ix=((starts[:,:,None]+np.arange(length))%n).reshape(batch,-1)[:,:n]
        vals={k:np.exp(252*value[ix].mean(axis=1)) for k,value in series.items()}
        draws[cursor:cursor+batch]=np.column_stack([vals[a]-vals[b] for a,b in pairs])
    se=draws.std(axis=0,ddof=1);assert (se>0).all()
    q=float(np.quantile(np.max(abs((draws-observed)/se),axis=1),.95))
    for j,(a,b) in enumerate(pairs):
        lo,hi=np.quantile(draws[:,j],[.025,.975])
        boot.append(dict(blockDays=length,candidate=a,reference=b,deltaCAGR=observed[j],individualLow=lo,individualHigh=hi,simultaneousLow=observed[j]-q*se[j],simultaneousHigh=observed[j]+q*se[j],B=B,seed=3800+length,familySize=len(pairs),maxTCritical=q,method='paired circular blocks; centered fixed-bootstrap-SE max-T approximation; historical saved paths'))
    print('BOOTSTRAP_COMPLETE',length,flush=True)
pd.DataFrame(boot).to_csv(OUT/'paired_bootstrap_maxT.csv',index=False)

# Standard relative rank r/(N+1); include the median as lambda <= 0.
# Also replicate the earlier r/N,<=(.5) convention to expose that difference.
segments=np.array_split(np.arange(len(anchor_df)),10);pbo=[]
for basis in ['simple_return_sharpe','log_return_sharpe_legacy']:
    R=np.column_stack([baseline_daily[v]['return'].to_numpy() if basis=='simple_return_sharpe' else series[v] for v in VARIANTS])
    for ins in combinations(range(10),5):
        ii=np.concatenate([segments[i] for i in ins]);oi=np.concatenate([segments[i] for i in range(10) if i not in ins])
        ish=R[ii].mean(axis=0)/R[ii].std(axis=0,ddof=1);osh=R[oi].mean(axis=0)/R[oi].std(axis=0,ddof=1)
        winners=np.flatnonzero(ish==ish.max());ranks=rankdata(osh,method='average')[winners]
        rel=ranks/(len(VARIANTS)+1);legacy=ranks/len(VARIANTS)
        pbo.append(dict(basis=basis,inSampleBlocks='|'.join(map(str,ins)),winners='|'.join(VARIANTS[i] for i in winners),ties=len(winners),oosRelativeRank=float(rel.mean()),logit=float(np.log(rel/(1-rel)).mean()),pboMass=float((rel<=.5).mean()),legacyBelowMedianMass=float((legacy<=.5).mean())))
pd.DataFrame(pbo).to_csv(OUT/'cscv_pbo.csv',index=False)
write_json('statistical_method_audit.json',dict(bootstrap='10,000 paired circular blocks, 21/63; all 15 comparisons jointly; fixed bootstrap SE approximation, no re-simulation',PBO='10 chronological blocks; 252 half-splits; ONLY fixed 9 settings; neither global search PBO nor a guaranteed lower bound',rankCorrection='standard r/(N+1), logit<=0 includes median. Earlier r/N<=0.5 excluded rank 5 of 9. Both reported; simple-return Sharpe primary and legacy log-return Sharpe diagnostic.',DSR={'status':'NOT COMPUTED','reason':'No defensible full independent trial count. US34/US35 scenario counts include correlated/duplicate execution variants and omit broader research history.'},dataUse='2017-2026 historical selection/review; no untouched OOS'))

# Read full small metadata tables; raw multi-GB prices already used above.
pit={};tables={}
for name in ['tickers','actions','metrics','sp500','descriptions']:
    df=pd.read_csv(ROOT/f'{name}.csv',low_memory=False);tables[name]=df
    pit[name]={'rows':len(df),'columns':list(df.columns),'sample':df.head(3).replace({np.nan:None}).to_dict('records')}
t=tables['tickers'];a=tables['actions']
for column in ['table','isdelisted','category','exchange']:
    if column in t:pit['tickers'][column+'Counts']=t[column].value_counts(dropna=False).astype(int).to_dict()
if 'ticker' in t and 'permaticker' in t:
    pairs=t[['ticker','permaticker']].drop_duplicates()
    pit['tickers']['tickersWithMultiplePermatickers']=int((pairs.groupby('ticker').permaticker.nunique()>1).sum())
    pit['tickers']['permatickersWithMultipleTickers']=int((pairs.groupby('permaticker').ticker.nunique()>1).sum())
    pairs.to_csv(OUT/'ticker_permaticker_observed_pairs.csv',index=False)
for column in ['action','event','type']:
    if column in a:pit['actions'][column+'Counts']=a[column].value_counts(dropna=False).astype(int).to_dict()
for name in ['tickers','actions','metrics','sp500']:
    df=tables[name]
    for column in [c for c in df if 'date' in c.lower()]:
        vals=pd.to_datetime(df[column],errors='coerce')
        pit[name][column+'Range']={'min':str(vals.min()),'max':str(vals.max()),'nonNull':int(vals.notna().sum())}
mapdf=pd.read_csv(PREV/'mapping_v2.csv',low_memory=False)
pit['mapping']={'rows':len(mapdf),'columns':list(mapdf.columns)}
for col in ['historicalTimelineComplete','commonEquityEligible','isdelisted','mappingVersion']:
    if col in mapdf:pit['mapping'][col+'Counts']=mapdf[col].astype(str).value_counts().astype(int).to_dict()
pit['gate']={'status':'NOT PASSED / PENDING','rawSourceAvailable':True,'expandedUniverseReplayCompleted':True,'strictPITReplayCompleted':False,'metricsUsedAsHistoricalFeatures':False,'limitations':['Current ticker metadata and first/last price dates do not establish historical exchange/listing eligibility at every date.','Observed ticker/permaticker pairs and dated actions do not by themselves certify all effective ticker intervals and reuse resolution.','Mapping v2 classifications are a snapshot; no complete effective-dated sector/category history is certified.','Revision 3 corporate corrections reproduced but discovery/as-of timing and independently published table snapshots are not a synchronized PIT release.'],'productionPromotionAllowed':False}
write_json('pit_source_audit.json',pit)
write_json('raw_input_sha256.json',{name:dict(bytes=(ROOT/name).stat().st_size,sha256=sha(ROOT/name)) for name in ['descriptions.csv','actions.csv','metrics.csv','stocks.csv','tickers.csv','sp500.csv','funds.csv','manifest.json']})
write_json('feature_input_sha256.json',{'path':str(OLD/'canonical_feature_inputs.parquet'),'sha256':sha(OLD/'canonical_feature_inputs.parquet')})
print('PIT_AUDIT_COMPLETE_NOT_PASSED',flush=True)
print('PBO_SUMMARY',pd.DataFrame(pbo).groupby('basis')[['pboMass','legacyBelowMedianMass']].mean().to_json(),flush=True)
