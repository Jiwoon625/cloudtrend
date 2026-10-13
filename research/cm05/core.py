"""CM05 research primitives. No IO and no implicit filling of missing prices."""
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

def require(ok,message):
    if not ok: raise ValueError(message)

def prices(frame,dates):
    require(not frame.duplicated(['date','symbol']).any(),'duplicate price key')
    out={k:frame.pivot(index='date',columns='symbol',values=k).reindex(dates).astype(float) for k in ['open','close','volume']}
    for k in ['open','close']:out[k]=out[k].where(out[k]>0)
    return out

def sector_panel(p,benchmark,calendar,minimum=10,coverage_min=.8):
    c,o,v=p['close'],p['open'],p['volume']
    # The membership set uses only the preceding 252 market sessions, never future availability.
    history=c.notna().rolling(252,min_periods=252).sum().eq(252)
    prev=history.shift(1,fill_value=False)
    denominator=prev.sum(axis=1)
    valid=prev & c.notna() & c.shift(1).notna() & (v>0)
    n=valid.sum(axis=1);cov=n/denominator.replace(0,np.nan)
    good=(n>=minimum)&(cov>=coverage_min)
    bench=benchmark.reindex(c.index) if isinstance(benchmark,pd.DataFrame) else benchmark
    bc,bo=bench['close'].astype(float),bench['open'].astype(float)
    if isinstance(bc,pd.Series):
        bc=pd.DataFrame({s:bc for s in c.columns});bo=pd.DataFrame({s:bo for s in c.columns})
    bc=bc.reindex(index=c.index,columns=c.columns);bo=bo.reindex(index=c.index,columns=c.columns)
    excess20=(c/c.shift(20)-1)-(bc/bc.shift(20)-1)
    ma=c.rolling(60,min_periods=60).mean()
    breadth=(c>ma).where(valid & ma.notna()).mean(axis=1)
    daily=(c/c.shift(1)-1).where(valid).mean(axis=1)
    intraday=(c/o-1).where(valid & o.notna()).mean(axis=1)
    result=pd.DataFrame({'date':c.index,'n':n.to_numpy(),'denominator':denominator.to_numpy(),'coverage':cov.to_numpy(),
       'ready':good.to_numpy(),'X1':excess20.where(valid).median(axis=1).where(good).to_numpy(),
       'breadth60':breadth.where(good).to_numpy(),'daily_return':daily.where(good).to_numpy(),
       'intraday_return':intraday.where(good & ((valid & o.notna()).sum(axis=1)>=minimum)).to_numpy(),
       'market_ret20':(bc/bc.shift(20)-1).where(prev).mean(axis=1).to_numpy(),
       'market_vol20':bc.pct_change(fill_method=None).where(prev).mean(axis=1).rolling(20).std().to_numpy(),
       'benchmark_daily':bc.pct_change(fill_method=None).where(valid).mean(axis=1).where(good).to_numpy(),
       'benchmark_intraday':(bc/bo-1).where(valid & o.notna()).mean(axis=1).where(good).to_numpy()})
    result['X2']=result.breadth60-result.breadth60.shift(5)
    result['available_at']=pd.to_datetime(calendar.set_index('session_date').close_available_at.reindex(c.index).to_numpy(),utc=True)
    result['open_at']=pd.to_datetime(calendar.set_index('session_date').open_at.reindex(c.index).to_numpy(),utc=True)
    return result

def forward_basket(panel,h):
    # At row t the label starts at t's open and ends at close(t+h-1).
    gross=1+panel.intraday_return
    base=1+panel.benchmark_intraday
    for i in range(1,h):
        gross=gross*(1+panel.daily_return.shift(-i))
        base=base*(1+panel.benchmark_daily.shift(-i))
    return gross-base

def asof_peer(target,source,decision_col='decision_at'):
    source=source[['date','available_at','X1','X2']].rename(columns={'date':'source_session','available_at':'source_available_at','X1':'peer_X1','X2':'peer_X2'})
    a=target.sort_values(decision_col).copy();b=source.sort_values('source_available_at').copy()
    a[decision_col]=pd.to_datetime(a[decision_col],utc=True);b.source_available_at=pd.to_datetime(b.source_available_at,utc=True)
    require(a[decision_col].notna().all() and b.source_available_at.notna().all(),'missing availability timestamp')
    out=pd.merge_asof(a,b,left_on=decision_col,right_on='source_available_at',direction='backward',allow_exact_matches=False,tolerance=pd.Timedelta(days=3))
    require(not (out.source_available_at>=out[decision_col]).any(),'future information join')
    out['source_age_hours']=(out[decision_col]-out.source_available_at).dt.total_seconds()/3600
    return out

def period(date):
    y=int(str(date)[:4]);return 'discovery' if y<=2021 else 'validation' if y<=2024 else str(y)

def boundary_mask(dates,h=60):
    periods=pd.Series([period(x) for x in dates],index=range(len(dates)))
    return periods.eq(periods.shift(-h))

def fdr(values,family):
    a=np.asarray(values,dtype=float); out=np.full(len(a),np.nan);valid=np.flatnonzero(np.isfinite(a))
    idx=valid[np.argsort(a[valid])]
    if len(idx):out[idx]=np.minimum(1,np.minimum.accumulate((a[idx]*family/np.arange(1,len(idx)+1))[::-1])[::-1])
    return out

def block_indices(n,rng,block):
    return np.concatenate([(s+np.arange(block))%n for s in rng.integers(0,n,size=int(np.ceil(n/block)))])[:n]

def regression(frame,feature,controls):
    cols=[feature,'target']+controls
    d=frame.replace([np.inf,-np.inf],np.nan).dropna(subset=cols)
    if len(d)<100:return {'n':len(d),'status':'INSUFFICIENT_SAMPLE'},None
    X=np.column_stack([np.ones(len(d)),d[[feature]+controls].to_numpy(float)]);y=d.target.to_numpy(float)
    if np.linalg.matrix_rank(X)<X.shape[1]:return {'n':len(d),'status':'RANK_DEFICIENT'},None
    coef=np.linalg.lstsq(X,y,rcond=None)[0][1]
    return {'n':len(d),'status':'ESTIMATED','coefficient':float(coef),'rank_ic':float(spearmanr(d[feature],d.target).statistic)},(d,X,y)

def bootstrap_coefficients(fit,date_universe,block=63,replicates=499,seed=20261013):
    d,X,y=fit;groups={day:np.flatnonzero(d.date.to_numpy()==day) for day in set(d.date)}
    rng=np.random.default_rng(seed);vals=[]
    for _ in range(replicates):
        ix=np.concatenate([groups.get(date_universe[i],np.array([],dtype=int)) for i in block_indices(len(date_universe),rng,block)])
        if len(ix)<100 or np.linalg.matrix_rank(X[ix])<X.shape[1]:continue
        vals.append(np.linalg.lstsq(X[ix],y[ix],rcond=None)[0][1])
    if len(vals)<replicates*.8:return {'bootstrap_status':'INSUFFICIENT_REPLICATES'}
    lo,hi=np.quantile(vals,[.025,.975]);estimate=np.linalg.lstsq(X,y,rcond=None)[0][1]
    p=(1+sum(abs(np.asarray(vals)-estimate)>=abs(estimate)))/(len(vals)+1)
    return {'bootstrap_status':'COMPLETE','ci_lower':float(lo),'ci_upper':float(hi),'p_block':float(p),'replicates':len(vals)}

def event_labels(events,p,bench,dates,h):
    bench=bench[['open','close']].apply(pd.to_numeric,errors='raise')
    c,o,v=p['close'],p['open'],p['volume'];pos={d:i for i,d in enumerate(dates)};rows=[]
    for row in events.to_dict('records'):
        t=pos.get(row['date']);s=row['symbol'];item=dict(row,horizon=h,target=np.nan,status='CENSORED')
        if t is not None and t+1<len(dates) and s in c:
            entry=t+1;end=entry+h-1
            if end<len(dates):
                op=o.iloc[entry][s];cl=c.iloc[end][s];vol=v.iloc[entry][s]
                bo=bench.open.iloc[entry];bc=bench.close.iloc[end]
                item['entry_date']=dates[entry];item['exit_date']=dates[end]
                if period(dates[t])!=period(dates[min(t+60,len(dates)-1)]):item['status']='BOUNDARY_PURGED'
                elif not (np.isfinite(op) and op>0 and vol>0):item['status']='UNEXECUTABLE_OPEN'
                elif not(np.isfinite(cl) and cl>0 and bo>0 and bc>0):item['status']='MISSING_ENDPOINT'
                else:
                    item.update(target=float(cl/op-bc/bo),stock_return=float(cl/op-1),benchmark_return=float(bc/bo-1),status='OBSERVED')
        rows.append(item)
    return pd.DataFrame(rows)
