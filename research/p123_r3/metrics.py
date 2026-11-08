"""Transparent research metrics. Return units are fractions; P&L keeps currency."""
import hashlib,json,math,os,pathlib
import numpy as np
import pandas as pd

def clean(x):
    if isinstance(x,dict):return {str(k):clean(v) for k,v in x.items()}
    if isinstance(x,(list,tuple)):return [clean(v) for v in x]
    if isinstance(x,(np.integer,)):return int(x)
    if isinstance(x,(np.floating,float)):return float(x) if math.isfinite(x) else None
    if isinstance(x,(np.bool_,)):return bool(x)
    return x
def sha(path):return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def save(path,obj):
    p=pathlib.Path(path);p.parent.mkdir(parents=True,exist_ok=True);t=p.with_suffix(p.suffix+'.tmp')
    with t.open('w') as f:json.dump(clean(obj),f,ensure_ascii=False,indent=2,allow_nan=False);f.flush();os.fsync(f.fileno())
    t.replace(p)
def table(path,rows):
    p=pathlib.Path(path);p.parent.mkdir(parents=True,exist_ok=True);pd.DataFrame(rows).to_csv(p,index=False,encoding='utf-8-sig')
def trade_stats(rows):
    if not rows:return {'n':0,'pnl':0}
    r=np.array([t['return'] for t in rows]);p=np.array([t['pnl'] for t in rows]);win=r[r>0];loss=r[r<0]
    result={'n':len(rows),'pnl':p.sum(),'mean_return':r.mean(),'median_return':np.median(r),'win_rate':np.mean(r>0),'payoff_ratio':win.mean()/-loss.mean() if len(win) and len(loss) else None,'profit_factor':win.sum()/-loss.sum() if len(win) and len(loss) else None}
    for k in ['mae','mfe']:
        v=[t[k] for t in rows if t.get(k) is not None and np.isfinite(t[k])]
        result['mean_'+k]=np.mean(v) if v else None;result['median_'+k]=np.median(v) if v else None
    return clean(result)
def nav_stats(rows,capital):
    f=pd.DataFrame(rows);v=f.nav.astype(float).to_numpy();cash=f.cash.astype(float).to_numpy();values=np.r_[capital,v]
    days=(pd.Timestamp(f.date.iloc[-1])-pd.Timestamp(f.date.iloc[0])).days
    m={'start':str(f.date.iloc[0]),'end':str(f.date.iloc[-1]),'n_days':len(f),'nav_return':v[-1]/capital-1,'mdd':np.min(values/np.maximum.accumulate(values)-1),'avg_exposure':np.mean(1-cash/v),'avg_cash':np.mean(cash/v),'ending_nav':v[-1],'cagr':(v[-1]/capital)**(365.25/days)-1 if days>=365 else None}
    return clean(m)
def excursion(bars,entry,exit_day,mark_day,entry_price,exit_price):
    # No exit-day high/low/close is available to a next-open exit.
    held=[b for b in bars if entry<=b['date'] and (b['date']<exit_day if exit_day else b['date']<=mark_day)]
    close=[entry_price,exit_price]+[b['close'] for b in held if b.get('close') and b['close']>0]
    hi=[entry_price,exit_price]+[b.get('high',b['close']) for b in held if b.get('high',b.get('close')) and b.get('high',b.get('close'))>0]
    lo=[entry_price,exit_price]+[b.get('low',b['close']) for b in held if b.get('low',b.get('close')) and b.get('low',b.get('close'))>0]
    return {'mae':min(close)/entry_price-1,'mfe':max(close)/entry_price-1,'mae_intraday':min(lo)/entry_price-1,'mfe_intraday':max(hi)/entry_price-1}
def cluster_selection_ci(rows,key='symbol',seed=20261108,reps=1500):
    """Cluster bootstrap of selected minus all mean; descriptive, reused sample."""
    if not rows:return None
    f=pd.DataFrame(rows);groups=[g for _,g in f.groupby(key,sort=True)];rng=np.random.default_rng(seed)
    # Sufficient statistics reproduce cluster resampling without materializing
    # thousands of duplicated DataFrames on each bootstrap draw.
    stats=np.array([[len(g),g['return'].sum(),int(g.selected.sum()),g.loc[g.selected,'return'].sum()] for g in groups],dtype=float)
    draws=rng.integers(0,len(groups),size=(reps,len(groups)));sums=stats[draws].sum(axis=1);good=sums[:,2]>0
    vals=(sums[good,3]/sums[good,2]-sums[good,1]/sums[good,0]).tolist()
    return {'clusters':len(groups),'reps':len(vals),'mean_difference':float(f.loc[f.selected,'return'].mean()-f['return'].mean()) if f.selected.any() else None,'lo':float(np.quantile(vals,.025)) if vals else None,'hi':float(np.quantile(vals,.975)) if vals else None,'interpretation':'descriptive reused-sample interval; no new OOS or multiple-testing correction'}
